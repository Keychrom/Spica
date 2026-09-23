import crypto from 'node:crypto';
import { adb, UserRow, createNotification, listStaffUserIds } from './db.js';
import { config } from './config.js';
import { deliverActivity, fetchRemoteActor, ACTIVITYSTREAMS_CONTEXT } from './activitypub.js';

/**
 * 通報（Report / ActivityPub の Flag）の保存と配送
 *
 * - ローカルユーザーからの通報を reports テーブルに貯め、管理画面「通報」で対応する
 * - 通報対象が他サーバーの場合、そのサーバーへ Flag Activity を配送する（Fediverse 標準）
 * - 他サーバーから届いた Flag も同じテーブルに取り込む
 */

export type ReportStatus = 'open' | 'resolved' | 'rejected';

export const REPORT_CATEGORIES = [
  'spam',
  'abuse',
  'sensitive',
  'impersonation',
  'other',
] as const;

export interface CreateReportParams {
  reporterActorUrl: string;
  reporterUserId?: string | null;
  reporterHandle?: string;
  targetActorUrl: string;
  targetUserId?: string | null;
  targetHandle?: string;
  targetPostId?: string | null;
  targetPostContent?: string | null;
  category?: string;
  comment?: string;
  isRemote?: boolean;
  /** 対象が他サーバーの場合に Flag を配送するか（既定: true） */
  forward?: boolean;
}

export interface ReportRow {
  id: string;
  reporter_actor_url: string;
  reporter_user_id: string | null;
  reporter_handle: string;
  target_actor_url: string;
  target_user_id: string | null;
  target_handle: string;
  target_post_id: string | null;
  target_post_content: string | null;
  is_remote: number;
  category: string;
  comment: string;
  forwarded: number;
  status: ReportStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export function normalizeCategory(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase();
  return (REPORT_CATEGORIES as readonly string[]).includes(value) ? value : 'other';
}

function isLocalActor(actorUrl: string): boolean {
  return typeof actorUrl === 'string' && actorUrl.startsWith(config.origin);
}

/** 通報レコードを作成する（配送は行わない） */
export async function insertReport(params: CreateReportParams): Promise<ReportRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const category = normalizeCategory(params.category);
  const comment = typeof params.comment === 'string' ? params.comment.trim().slice(0, 2000) : '';
  const targetPostContent = typeof params.targetPostContent === 'string'
    ? params.targetPostContent.replace(/<[^>]+>/g, '').trim().slice(0, 300)
    : null;

  await adb.prepare(`
    INSERT INTO reports (
      id, reporter_actor_url, reporter_user_id, reporter_handle,
      target_actor_url, target_user_id, target_handle,
      target_post_id, target_post_content, is_remote, category, comment,
      forwarded, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)
  `).run(
    id,
    params.reporterActorUrl,
    params.reporterUserId ?? null,
    params.reporterHandle ?? '',
    params.targetActorUrl,
    params.targetUserId ?? null,
    params.targetHandle ?? '',
    params.targetPostId ?? null,
    targetPostContent,
    params.isRemote ? 1 : 0,
    category,
    comment,
    now,
  );

  const report = await adb.prepare('SELECT * FROM reports WHERE id = ?').get(id) as unknown as ReportRow;

  // 運営メンバー（admin / moderate）へ通知する
  //   ・種類別設定で「通報」を切っている人には届かない（createNotification が弾く）
  //   ・通報者自身が運営の場合も通知されない（自分の操作は通知しない仕様）
  try {
    await notifyStaffOfReport(report);
  } catch (err: any) {
    console.warn('[Report] 運営への通知に失敗しました:', err?.message || err);
  }

  return report;
}

/** 通報を運営メンバー全員に通知する */
export async function notifyStaffOfReport(report: ReportRow): Promise<number> {
  const staffIds = await listStaffUserIds();
  if (staffIds.length === 0) return 0;

  const categoryLabels: Record<string, string> = {
    spam: 'スパム',
    abuse: '嫌がらせ・誹謗中傷',
    sensitive: 'センシティブ',
    impersonation: 'なりすまし',
    other: 'その他',
  };
  const target = report.target_handle || report.target_actor_url || '不明';
  const reason = report.comment ? `「${report.comment.slice(0, 120)}」` : '（コメントなし）';

  let created = 0;
  for (const staffId of staffIds) {
    const ok = await createNotification({
      userId: staffId,
      type: 'report',
      actorId: report.reporter_user_id || report.reporter_actor_url,
      actorName: report.reporter_handle || '通報者',
      actorHandle: report.reporter_handle || '',
      postId: report.target_post_id || undefined,
      postContent: report.target_post_content || '',
      content: `${categoryLabels[report.category] || report.category}: ${target} ${reason}`,
    });
    if (ok) created++;
  }
  if (created > 0) {
    console.log(`[Report] 🚩 通報を運営 ${created} 名へ通知しました（${report.id}）`);
  }
  return created;
}

/** リモートサーバーへ通報を転送する（Flag Activity） */
export async function forwardReport(report: ReportRow, actorUrl: string, userId?: string | null): Promise<boolean> {
  const targetIsRemote = !isLocalActor(report.target_actor_url);
  if (!targetIsRemote) {
    return false;
  }

  try {
    const remote = await fetchRemoteActor(report.target_actor_url);
    if (!remote?.inbox_url) {
      return false;
    }

    const objects: string[] = [report.target_actor_url];
    if (report.target_post_id) {
      objects.push(report.target_post_id);
    }

    const activity = {
      '@context': ACTIVITYSTREAMS_CONTEXT,
      id: `${config.origin}/reports/${report.id}`,
      type: 'Flag',
      actor: actorUrl,
      object: objects,
      content: report.comment || `Reported by ${config.instanceName} (${report.category})`,
    };

    const senderUser = userId
      ? (await adb.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined)
      : undefined;

    const delivered = await deliverActivity({
      inboxUrl: remote.inbox_url,
      activity,
      senderUser,
      useInstanceActor: !senderUser,
    });

    if (delivered) {
      await adb.prepare('UPDATE reports SET forwarded = 1 WHERE id = ?').run(report.id);
      console.log(`[Report] 📤 Forwarded Flag for ${report.target_actor_url} to ${remote.inbox_url}`);
    }
    return delivered;
  } catch (err) {
    console.warn('[Report] Flag の転送に失敗しました:', (err as Error).message);
    return false;
  }
}

/** 通報を作成し、必要なら対象サーバーへ転送する */
export async function createReport(params: CreateReportParams): Promise<{ report: ReportRow; forwarded: boolean }> {
  const report = await insertReport(params);

  let forwarded = false;
  if (params.forward !== false) {
    forwarded = await forwardReport(report, params.reporterActorUrl, params.reporterUserId);
  }

  return { report, forwarded };
}

/** 他サーバーから届いた Flag を取り込む */
export async function ingestRemoteFlag(params: {
  actorUrl: string;
  objects: string[];
  content?: string;
}): Promise<ReportRow | null> {
  const postUrl = params.objects.find((o) => o.includes('/posts/') || o.includes('/notes/') || o.includes('/statuses/'));
  const actorTarget = params.objects.find((o) => !postUrl || o !== postUrl) ?? params.actorUrl;

  // 対象が自分のノートの場合は、そのノートの投稿者を対象ユーザーとして解決する
  let targetActorUrl = actorTarget;
  let targetUserId: string | null = null;
  let targetPostId: string | null = null;
  let targetPostContent: string | null = null;

  if (postUrl) {
    const post = await adb.prepare('SELECT * FROM posts WHERE id = ?').get(postUrl) as
      | { id: string; user_id: string; author_url: string; content: string }
      | undefined;
    if (post) {
      targetPostId = post.id;
      targetPostContent = post.content;
      targetActorUrl = post.author_url;
      targetUserId = post.user_id;
    } else {
      targetPostId = postUrl;
    }
  }

  const localUser = await adb.prepare('SELECT id FROM users WHERE id = ?').get(targetActorUrl.split('/').pop() || '');
  if (localUser) {
    targetUserId = (localUser as { id: string }).id;
  }

  const report = await insertReport({
    reporterActorUrl: params.actorUrl,
    targetActorUrl,
    targetUserId,
    targetPostId,
    targetPostContent,
    category: 'other',
    comment: params.content || '',
    isRemote: true,
    forward: false,
  });

  console.log(`[Report] 📥 他サーバーからの通報を取り込み: ${params.actorUrl} -> ${targetActorUrl}`);
  return report;
}

/** 管理画面用: 通報一覧 */
export async function listReports(status?: string): Promise<ReportRow[]> {
  const valid: ReportStatus[] = ['open', 'resolved', 'rejected'];
  if (status && valid.includes(status as ReportStatus)) {
    return await adb.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 300').all(status) as unknown as ReportRow[];
  }
  return await adb.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 300').all() as unknown as ReportRow[];
}

export async function countOpenReports(): Promise<number> {
  const row = await adb.prepare("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'").get() as { c: number };
  return row?.c ?? 0;
}

/** 管理画面用: 通報の対応（対応済み / 却下 / 再オープン） */
export async function resolveReport(
  id: string,
  action: 'resolve' | 'reject' | 'reopen',
  adminUserId: string,
  note?: string,
): Promise<ReportRow | null> {
  const existing = await adb.prepare('SELECT * FROM reports WHERE id = ?').get(id) as unknown as ReportRow | undefined;
  if (!existing) {
    return null;
  }

  if (action === 'reopen') {
    await adb.prepare("UPDATE reports SET status = 'open', resolved_by = NULL, resolved_at = NULL, resolution_note = NULL WHERE id = ?").run(id);
  } else {
    const status: ReportStatus = action === 'resolve' ? 'resolved' : 'rejected';
    await adb.prepare('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?')
      .run(status, adminUserId, new Date().toISOString(), note ?? null, id);
  }

  return await adb.prepare('SELECT * FROM reports WHERE id = ?').get(id) as unknown as ReportRow;
}

/**
 * 新しい通報をサーバーログに目立つ形で記録する。
 *
 * ※ 通知テーブル（notifications）の type に 'report' を追加するには
 *    クライアント側の通知描画の対応も必要になるため、現状は
 *    管理画面「通報」タブのバッジ（未対応件数）とサーバーログで可視化する。
 */
export function logNewReport(report: ReportRow): void {
  console.warn(
    `[Report] 🚩 新しい通報 (${report.is_remote ? 'リモート' : 'ローカル'}): ` +
    `${report.reporter_handle || report.reporter_actor_url} -> ` +
    `${report.target_handle || report.target_actor_url} [${report.category}]` +
    `${report.target_post_id ? ` post=${report.target_post_id}` : ''}`,
  );
}
