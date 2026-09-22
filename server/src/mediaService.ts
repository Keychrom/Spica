import crypto from 'node:crypto';
import { adb } from './db.js';
import { config } from './config.js';
import { deleteMediaFile } from './storage.js';

/**
 * ドライブ（自分のアップロード管理）
 *
 *  ・アップロードしたメディアを media テーブルに記録し、投稿に紐づかないものも一覧できるようにする
 *  ・使用量（件数・合計サイズ）を返し、任意でクォータ（MEDIA_QUOTA_MB）を強制する
 *  ・投稿に使用中のメディアは削除を拒否する（投稿側の参照が壊れるため）
 */

export interface MediaRow {
  id: string;
  user_id: string;
  url: string;
  key: string;
  media_type: string;
  size: number;
  name: string;
  thumbnail_url: string;
  thumbnail_key: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  post_id: string | null;
  created_at: string;
}

export interface MediaStats {
  count: number;
  bytes: number;
  /** クォータ（バイト）。0 は無制限 */
  quotaBytes: number;
}

export function getMediaQuotaBytes(): number {
  const mb = config.mediaQuotaMb;
  return mb > 0 ? mb * 1024 * 1024 : 0;
}

export async function getMediaStats(userId: string): Promise<MediaStats> {
  const row = await adb.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS b FROM media WHERE user_id = ?').get(userId) as any;
  return { count: Number(row?.c ?? 0), bytes: Number(row?.b ?? 0), quotaBytes: getMediaQuotaBytes() };
}

/** 追加アップロードを受け入れられるか（クォータ超過の判定） */
export async function checkMediaQuota(userId: string, incomingBytes: number): Promise<{ ok: boolean; error?: string }> {
  const quota = getMediaQuotaBytes();
  if (quota <= 0) return { ok: true };
  const stats = await getMediaStats(userId);
  if (stats.bytes + incomingBytes > quota) {
    const used = (stats.bytes / 1024 / 1024).toFixed(1);
    const limit = (quota / 1024 / 1024).toFixed(0);
    return { ok: false, error: `ドライブの容量上限を超えます（使用中 ${used}MB / 上限 ${limit}MB）。ドライブから不要なファイルを削除してください。` };
  }
  return { ok: true };
}

/** アップロードされたメディアを台帳に記録する */
export async function recordMedia(params: {
  userId: string;
  url: string;
  key: string;
  mediaType: string;
  size: number;
  name?: string;
  thumbnailUrl?: string;
  thumbnailKey?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  postId?: string | null;
}): Promise<MediaRow> {
  const id = `media_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  await adb.prepare(`
    INSERT INTO media (id, user_id, url, key, media_type, size, name, thumbnail_url, thumbnail_key, width, height, duration, post_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.userId,
    params.url,
    params.key,
    params.mediaType,
    params.size,
    params.name || '',
    params.thumbnailUrl || '',
    params.thumbnailKey || '',
    params.width ?? null,
    params.height ?? null,
    params.duration ?? null,
    params.postId ?? null,
    now,
  );
  return await adb.prepare('SELECT * FROM media WHERE id = ?').get(id) as unknown as MediaRow;
}

/** 投稿の作成時に、添付 URL から台帳のメディアを投稿へ紐づける */
export async function linkMediaToPost(userId: string, postId: string, attachments: any[]): Promise<void> {
  if (!Array.isArray(attachments) || attachments.length === 0) return;
  const urls = attachments
    .map((a) => (typeof a === 'string' ? a : a?.url))
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (urls.length === 0) return;
  const update = await adb.prepare('UPDATE media SET post_id = ? WHERE user_id = ? AND url = ?');
  for (const url of urls) {
    try {
      update.run(postId, userId, url);
    } catch (err: any) {
      console.warn('[Drive] メディアの紐づけに失敗しました:', err?.message || err);
    }
  }
}

/** 投稿が削除されたときの紐づけ解除（ファイルはドライブに残す） */
export async function unlinkMediaFromPost(postId: string): Promise<void> {
  try {
    await adb.prepare('UPDATE media SET post_id = NULL WHERE post_id = ?').run(postId);
  } catch (err: any) {
    console.warn('[Drive] メディアの紐づけ解除に失敗しました:', err?.message || err);
  }
}

export interface MediaListItem extends MediaRow {
  /** 使用中の投稿の本文冒頭（あれば） */
  post_excerpt?: string;
  post_is_local?: number;
}

/** クライアントへ返す形（API 全体と同じ camelCase に揃える） */
export interface ClientMedia {
  id: string;
  url: string;
  key: string;
  mediaType: string;
  size: number;
  name: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  postId: string | null;
  createdAt: string;
  /** 使用中の投稿の本文冒頭（一覧のみ） */
  postExcerpt?: string;
}

export function toClientMedia(row: MediaRow | MediaListItem): ClientMedia {
  return {
    id: row.id,
    url: row.url,
    key: row.key,
    mediaType: row.media_type,
    size: row.size,
    name: row.name,
    thumbnailUrl: row.thumbnail_url || '',
    width: row.width,
    height: row.height,
    duration: row.duration,
    postId: row.post_id,
    createdAt: row.created_at,
    postExcerpt: (row as MediaListItem).post_excerpt,
  };
}

/** 自分のメディア一覧（新しい順・カーソル対応） */
export async function listMedia(params: { userId: string; limit: number; cursor?: { at: string; id: string } | null }): Promise<MediaListItem[]> {
  const rows = params.cursor
    ? await (adb
        .prepare(
          `SELECT m.*, p.content AS post_content, p.is_local AS post_is_local
           FROM media m LEFT JOIN posts p ON p.id = m.post_id
           WHERE m.user_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
        )
        .all(params.userId, params.cursor.at, params.cursor.at, params.cursor.id, params.limit) as Promise<any[]>)
    : await (adb
        .prepare(
          `SELECT m.*, p.content AS post_content, p.is_local AS post_is_local
           FROM media m LEFT JOIN posts p ON p.id = m.post_id
           WHERE m.user_id = ?
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
        )
        .all(params.userId, params.limit) as Promise<any[]>);

  return rows.map((row) => ({
    ...(row as MediaRow),
    post_excerpt: row.post_content ? String(row.post_content).replace(/<[^>]+>/g, '').slice(0, 60) : undefined,
    post_is_local: row.post_is_local ?? undefined,
  }));
}

export interface DeleteMediaResult {
  ok: boolean;
  error?: string;
  /** 投稿から参照されているため拒否した場合 true */
  inUse?: boolean;
}

/** メディアを削除する（ファイル本体とサムネイルも消す） */
export async function deleteMedia(userId: string, id: string): Promise<DeleteMediaResult> {
  const row = await adb.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?').get(id, userId) as unknown as MediaRow | undefined;
  if (!row) return { ok: false, error: 'ファイルが見つかりません。' };

  // 投稿に使用中のものは消さない（投稿の添付が壊れるため）。先に投稿を削除してもらう。
  if (row.post_id) {
    return { ok: false, inUse: true, error: 'このファイルは投稿で使用されています。先に該当の投稿を削除してください。' };
  }

  await adb.prepare('DELETE FROM media WHERE id = ?').run(id);

  // ファイルは消せなくても台帳からは外す（孤児は db:maintenance の孤立メディア掃除で回収できる）
  if (row.key) void deleteMediaFile({ key: row.key, url: row.url });
  if (row.thumbnail_key) void deleteMediaFile({ key: row.thumbnail_key, url: row.thumbnail_url });
  return { ok: true };
}

/** アカウント削除時に、そのユーザーのメディアを台帳とストレージから消す */
export async function deleteAllMediaForUser(userId: string): Promise<number> {
  const rows = await adb.prepare('SELECT id, key, url, thumbnail_key, thumbnail_url FROM media WHERE user_id = ?').all(userId) as any[];
  for (const row of rows) {
    await adb.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    if (row.key) void deleteMediaFile({ key: row.key, url: row.url });
    if (row.thumbnail_key) void deleteMediaFile({ key: row.thumbnail_key, url: row.thumbnail_url });
  }
  return rows.length;
}

/**
 * ドライブの整合性チェック用: 台帳にあるが投稿から参照されていない情報を返す。
 * （db:maintenance の孤立メディア判定に使う）
 */
export async function listReferencedLocalKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const row of await adb.prepare("SELECT key FROM media WHERE key != ''").all() as any[]) {
    keys.add(String(row.key));
  }
  return keys;
}
