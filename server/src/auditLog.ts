import crypto from 'node:crypto';
import { adb } from './db.js';

/**
 * 管理操作の監査ログ（admin_actions）
 *
 * 複数人でノードを運営するとき、「誰が・いつ・何をしたか」を後から追えるようにする。
 * 記録するのは管理 API（/api/admin/*）に対する**変更操作**（POST / PUT / PATCH / DELETE）だけで、
 * 成功したもの（2xx / 3xx）に限る。参照（GET）はノイズになるので記録しない。
 *
 * 方針:
 *   ・監査ログの記録失敗で本来の操作を止めない（try/catch で握る）
 *   ・本文（detail）には秘密を残さない（パスワード・トークン等のキーは伏せる）
 *   ・保持期間は設けず、肥大化したら管理画面から古いものを削除できるようにする
 */

export interface AdminActionRow {
  id: string;
  actor_id: string;
  action: string;
  method: string;
  path: string;
  target_type: string;
  target_id: string;
  detail: string;
  status: number;
  created_at: string;
}

/** 操作の種類（path から推定する）と表示ラベル */
const ACTION_LABELS: { pattern: RegExp; action: string; label: string; targetType: string }[] = [
  { pattern: /^\/blocks\//, action: 'block_domain_remove', label: 'ドメイン制限の解除', targetType: 'domain' },
  { pattern: /^\/blocks$/, action: 'block_domain', label: 'ドメインの制限（ブロック / サイレンス）', targetType: 'domain' },
  { pattern: /^\/users\/[^/]+\/freeze$/, action: 'freeze_user', label: 'ユーザーの凍結 / 解除', targetType: 'user' },
  { pattern: /^\/users\/[^/]+\/roles$/, action: 'assign_roles', label: 'ロールの付与', targetType: 'user' },
  { pattern: /^\/users\/[^/]+$/, action: 'delete_user', label: 'ユーザーの削除', targetType: 'user' },
  { pattern: /^\/roles\//, action: 'update_role', label: 'ロールの変更', targetType: 'role' },
  { pattern: /^\/roles$/, action: 'create_role', label: 'ロールの作成', targetType: 'role' },
  { pattern: /^\/reports\/[^/]+$/, action: 'resolve_report', label: '通報への対応', targetType: 'report' },
  { pattern: /^\/relays\//, action: 'relay_update', label: 'リレーの操作', targetType: 'relay' },
  { pattern: /^\/relays$/, action: 'relay_add', label: 'リレーの追加', targetType: 'relay' },
  { pattern: /^\/emojis\//, action: 'emoji_update', label: '絵文字の変更', targetType: 'emoji' },
  { pattern: /^\/emojis$/, action: 'emoji_add', label: '絵文字の登録', targetType: 'emoji' },
  { pattern: /^\/invites\//, action: 'invite_update', label: '招待コードの操作', targetType: 'invite' },
  { pattern: /^\/invites$/, action: 'invite_create', label: '招待コードの発行', targetType: 'invite' },
  { pattern: /^\/announcements\//, action: 'announcement_update', label: 'お知らせの変更', targetType: 'announcement' },
  { pattern: /^\/announcements$/, action: 'announcement_create', label: 'お知らせの作成', targetType: 'announcement' },
  { pattern: /^\/maintenance\/run$/, action: 'maintenance_run', label: 'メンテナンスの手動実行', targetType: 'server' },
  { pattern: /^\/maintenance\/settings$/, action: 'maintenance_settings', label: '自動整理の設定変更', targetType: 'server' },
  { pattern: /^\/maintenance$/, action: 'maintenance', label: 'メンテナンス操作', targetType: 'server' },
  { pattern: /^\/image-proxy\//, action: 'image_proxy_cache', label: '画像プロキシのキャッシュ操作', targetType: 'server' },
  { pattern: /^\/content-policy$/, action: 'content_policy', label: '検索・保存方針の変更', targetType: 'server' },
  { pattern: /^\/server-settings$/, action: 'server_settings', label: 'サーバー設定の変更', targetType: 'server' },
  { pattern: /^\/storage-settings$|^\/storage$/, action: 'storage_settings', label: 'ストレージ設定の変更', targetType: 'server' },
  { pattern: /^\/mail-settings\/test$/, action: 'mail_test', label: 'SMTP 接続テスト', targetType: 'server' },
  { pattern: /^\/mail-settings$/, action: 'mail_settings', label: 'メール設定の変更', targetType: 'server' },
  { pattern: /^\/auth-settings$/, action: 'auth_settings', label: '認証方式の変更', targetType: 'server' },
  { pattern: /^\/instance$|^\/instance-info$/, action: 'instance_info', label: 'インスタンス情報の変更', targetType: 'server' },
  { pattern: /^\/rules$/, action: 'rules', label: 'サーバールールの変更', targetType: 'server' },
  { pattern: /^\/media\//, action: 'media_admin', label: 'メディアの管理操作', targetType: 'media' },
  { pattern: /^\/delivery\//, action: 'delivery_queue', label: '配送キューの操作', targetType: 'server' },
];

/** detail に残さないキー（秘密情報） */
const SECRET_KEY_RE = /(pass|secret|token|key|auth|credential|cookie)/i;
const MAX_KEYS = 14;
const MAX_VALUE_LEN = 160;

function summarizeBody(body: unknown, query: unknown): string {
  const source = body && typeof body === 'object' && Object.keys(body as object).length > 0 ? body : query;
  if (!source || typeof source !== 'object') return '';

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break;
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '***';
      count++;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 10).map((item) => (typeof item === 'object' ? '[object]' : item));
    } else {
      out[key] = '[object]';
    }
    count++;
  }
  try {
    return JSON.stringify(out);
  } catch {
    return '';
  }
}

function resolveAction(method: string, path: string): { action: string; label: string; targetType: string } {
  for (const entry of ACTION_LABELS) {
    if (entry.pattern.test(path)) {
      return { action: entry.action, label: entry.label, targetType: entry.targetType };
    }
  }
  // 未知のパスはメソッドとパスから機械的に作る（新しい API を足しても記録は残る）
  const normalized = path.replace(/\/[0-9a-f-]{8,}/gi, '/:id').replace(/^\//, '').replace(/\//g, '_');
  return { action: `${method.toLowerCase()}_${normalized || 'unknown'}`, label: `${method} ${path}`, targetType: 'unknown' };
}

/** パスと本文から対象を推定する（ドメイン / ユーザー id / ロール id など） */
function resolveTarget(path: string, body: unknown): { targetType: string; targetId: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const segments = path.split('/').filter(Boolean);

  if (segments[0] === 'blocks' && segments[1]) return { targetType: 'domain', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'blocks') return { targetType: 'domain', targetId: String(b.domain ?? '') };
  if (segments[0] === 'users' && segments[1]) return { targetType: 'user', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'roles' && segments[1]) return { targetType: 'role', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'reports' && segments[1]) return { targetType: 'report', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'invites' && segments[1]) return { targetType: 'invite', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'announcements' && segments[1]) return { targetType: 'announcement', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'emojis' && segments[1]) return { targetType: 'emoji', targetId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'relays' && segments[1]) return { targetType: 'relay', targetId: decodeURIComponent(segments[1]) };
  return { targetType: '', targetId: '' };
}

/** 監査ログを 1 件記録する（失敗しても呼び出し元の処理は止めない） */
export async function recordAdminAction(params: {
  actorId: string;
  action: string;
  method?: string;
  path?: string;
  targetType?: string;
  targetId?: string;
  detail?: string | Record<string, unknown>;
  status?: number;
}): Promise<void> {
  try {
    const detail = typeof params.detail === 'string'
      ? params.detail
      : params.detail
        ? summarizeBody(params.detail, {})
        : '';
    await adb.prepare(`
      INSERT INTO admin_actions (id, actor_id, action, method, path, target_type, target_id, detail, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      params.actorId,
      params.action,
      params.method || '',
      params.path || '',
      params.targetType || '',
      params.targetId || '',
      detail,
      params.status ?? 200,
      new Date().toISOString(),
    );
  } catch (err) {
    console.warn('[AuditLog] 記録に失敗しました:', (err as any)?.message || err);
  }
}

/**
 * 管理 API の変更操作を自動で記録するミドルウェア。
 * 権限チェックの後ろに置くこと（拒否された操作は記録しない）。
 */
export function auditMiddleware() {
  return (req: any, res: any, next: any) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    res.on('finish', () => {
      try {
        if (res.statusCode >= 400) return; // 失敗した操作は記録しない
        const actorId = String(req.user?.id || req.rawUser?.id || '');
        if (!actorId) return;

        const path = String(req.path || '');
        const { action, label, targetType } = resolveAction(req.method, path);
        const target = resolveTarget(path, req.body);
        const summary = summarizeBody(req.body, req.query);

        // res.on('finish') は await できないので投げっぱなしにする。
        // recordAdminAction は自分で失敗を握るので、ここでの reject は起きない想定。
        void recordAdminAction({
          actorId,
          action,
          method: req.method,
          path,
          targetType: target.targetType || targetType,
          targetId: target.targetId,
          // ラベルは表示用に detail へ含めておく（ラベル表を後で変えても記録は読める）
          detail: summary ? `${label} | ${summary}` : label,
          status: res.statusCode,
        });
      } catch {
        // 記録できなくても本処理は完了している
      }
    });

    next();
  };
}

export interface AdminActionView extends AdminActionRow {
  label: string;
}

function labelFor(row: AdminActionRow): string {
  const detail = row.detail || '';
  const pipe = detail.indexOf(' | ');
  return pipe > 0 ? detail.slice(0, pipe) : detail || row.action;
}

function detailFor(row: AdminActionRow): string {
  const detail = row.detail || '';
  const pipe = detail.indexOf(' | ');
  return pipe > 0 ? detail.slice(pipe + 3) : '';
}

/** 監査ログの一覧（新しい順） */
export async function listAdminActions(params: {
  limit?: number;
  before?: string;
  action?: string;
  actorId?: string;
  targetId?: string;
}): Promise<{ actions: (AdminActionView & { detail_json: string })[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conds: string[] = [];
  const args: any[] = [];

  if (params.before) {
    conds.push('created_at < ?');
    args.push(params.before);
  }
  if (params.action) {
    conds.push('action = ?');
    args.push(params.action);
  }
  if (params.actorId) {
    conds.push('actor_id = ?');
    args.push(params.actorId);
  }
  if (params.targetId) {
    conds.push('target_id = ?');
    args.push(params.targetId);
  }

  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await adb.prepare(`
    SELECT * FROM admin_actions ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...args, limit + 1) as unknown as AdminActionRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];

  const total = Number((await adb.prepare(`SELECT COUNT(*) AS c FROM admin_actions ${where}`).get(...args) as any)?.c ?? 0);

  return {
    actions: pageRows.map((row) => ({
      ...row,
      label: labelFor(row),
      detail_json: detailFor(row),
    })),
    nextCursor: hasMore && last ? last.created_at : null,
    total,
  };
}

/** 古い監査ログを削除する（保持日数より前のもの） */
export async function pruneAdminActions(retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const result = await adb.prepare('DELETE FROM admin_actions WHERE created_at < ?').run(cutoff);
  return Number(result.changes ?? 0);
}

/** 表示に使える操作の種類（フィルタ用） */
export async function listActionKinds(): Promise<{ action: string; label: string; count: number }[]> {
  try {
    const rows = await adb.prepare(`
      SELECT action, COUNT(*) AS c FROM admin_actions GROUP BY action ORDER BY c DESC
    `).all() as unknown as { action: string; c: number }[];
    return rows.map((row) => {
      const found = ACTION_LABELS.find((entry) => entry.action === row.action);
      return { action: row.action, label: found?.label || row.action, count: Number(row.c) };
    });
  } catch {
    return [];
  }
}
