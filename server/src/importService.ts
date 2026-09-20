import crypto from 'node:crypto';
import { db, UserRow } from './db.js';
import { config } from './config.js';
import { normalizeVisibility, PostVisibility } from './postVisibility.js';

/**
 * アカウント移行インポート（Phase 1: 投稿の取り込み）
 *
 * 対応形式（JSON ファイル）:
 *   - Mastodon : アーカイブ内の outbox.json（ActivityStreams の Create(Note) 配列）
 *   - Misskey  : エクスポートの notes.json（note オブジェクト配列）
 *   - 汎用     : 上記いずれかに近い配列 / オブジェクト
 *
 * 取り込む情報: 本文・CW・公開範囲・投稿日時（元の日時を保持して時系列を維持）
 *
 * ■ Phase 2 以降（未対応）
 *   - メディア（画像/動画）の取り込み … アーカイブ内の実ファイルが必要なため
 *   - フォロー / フォロワー / ブックマーク / いいねの取り込み
 *   - ZIP アーカイブの直接読み込み（現状は JSON を取り出す必要がある）
 */

export type ImportFormat = 'mastodon' | 'misskey' | 'generic';

export interface ImportResult {
  format: ImportFormat;
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  errors: string[];
}

const MAX_POSTS_PER_IMPORT = 5000;

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 取り込み元の投稿IDから決定的な投稿IDを作る（再取り込みで重複しない） */
function buildImportedPostId(actorUrl: string, sourceId: string): string {
  const hash = crypto.createHash('sha1').update(sourceId).digest('hex').slice(0, 16);
  return `${actorUrl}/posts/import-${hash}`;
}

/** 宛先 (to/cc) から公開範囲を判定する（Mastodon / ActivityStreams 形式） */
function visibilityFromAddressing(item: any): PostVisibility {
  const to = Array.isArray(item?.to) ? item.to : item?.to ? [item.to] : [];
  const cc = Array.isArray(item?.cc) ? item.cc : item?.cc ? [item.cc] : [];
  const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
  if (to.includes(PUBLIC)) {
    return 'public';
  }
  if (cc.includes(PUBLIC)) {
    return 'local'; // 未収載（公開タイムラインには出さない）
  }
  return 'followers';
}

/** Misskey の visibility を Spica の公開範囲に変換する（specified = DM相当は取り込まない） */
function visibilityFromMisskey(raw: unknown): PostVisibility | null {
  const value = String(raw ?? '').toLowerCase();
  if (value === 'specified') {
    return null;
  }
  if (value === 'followers') {
    return 'followers';
  }
  if (value === 'home') {
    return 'local';
  }
  return 'public';
}

export interface NormalizedNote {
  sourceId: string;
  content: string;
  cw: string | null;
  publishedAt: string;
  visibility: PostVisibility;
}

/**
 * アーカイブ JSON を形式判定して正規化する
 */
export function parseArchive(data: any): { format: ImportFormat; notes: NormalizedNote[] } {
  // Mastodon outbox.json: { orderedItems: [ { type: 'Create', object: {...} } ] }
  if (data && typeof data === 'object' && Array.isArray(data.orderedItems)) {
    const notes: NormalizedNote[] = [];
    for (const item of data.orderedItems) {
      const object = item?.type === 'Create' ? item.object : item;
      if (!object || typeof object !== 'object') continue;
      const content = typeof object.content === 'string' ? htmlToText(object.content) : '';
      if (!content) continue;
      notes.push({
        sourceId: String(object.id || `${object.published || ''}-${notes.length}`),
        content,
        cw: typeof object.summary === 'string' && object.summary.trim() ? htmlToText(object.summary) : null,
        publishedAt: String(object.published || item?.published || new Date().toISOString()),
        visibility: visibilityFromAddressing(object),
      });
    }
    return { format: 'mastodon', notes };
  }

  // Misskey notes.json / ActivityStreams の配列
  if (Array.isArray(data)) {
    const isMisskey = data.some((n) => n && typeof n === 'object' && ('createdAt' in n || 'visibility' in n));
    const notes: NormalizedNote[] = [];

    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const object = item.type === 'Create' ? item.object : item;

      const content = typeof object.text === 'string'
        ? object.text.trim()
        : typeof object.content === 'string'
          ? htmlToText(object.content)
          : '';
      if (!content) continue;

      const visibility = isMisskey
        ? visibilityFromMisskey(object.visibility)
        : visibilityFromAddressing(object);
      if (!visibility) continue; // specified（DM相当）はスキップ

      const cw = typeof object.cw === 'string' && object.cw.trim()
        ? object.cw.trim()
        : typeof object.summary === 'string' && object.summary.trim()
          ? htmlToText(object.summary)
          : null;

      notes.push({
        sourceId: String(object.id || `${object.createdAt || object.published || ''}-${notes.length}`),
        content,
        cw,
        publishedAt: String(object.createdAt || object.published || new Date().toISOString()),
        visibility,
      });
    }

    return { format: isMisskey ? 'misskey' : 'generic', notes };
  }

  return { format: 'generic', notes: [] };
}

/**
 * 正規化済みノートをDBへ取り込む
 * ※ 連合配送・通知・アンテナ判定・SSE は行わない（過去ログの復元のため）
 */
export function importNotes(user: UserRow, notes: NormalizedNote[]): Omit<ImportResult, 'format'> {
  const actorUrl = `${config.origin}/users/${user.id}`;
  const authorHandle = `@${user.id}@${config.domain}`;
  const authorIcon = user.icon_url || '';

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  const insert = db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, in_reply_to, quote_id, is_sensitive, media_attachments, cw, published_at, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', NULL, NULL, ?, '[]', ?, ?, NULL)
  `);

  const targets = notes.slice(0, MAX_POSTS_PER_IMPORT);

  for (const note of targets) {
    try {
      const postId = buildImportedPostId(actorUrl, note.sourceId);
      const existing = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
      if (existing) {
        skipped++;
        continue;
      }

      // 日時が不正な場合は取り込み時刻で補う
      const publishedAt = Number.isNaN(Date.parse(note.publishedAt))
        ? new Date().toISOString()
        : new Date(note.publishedAt).toISOString();

      insert.run(
        postId,
        user.id,
        user.name,
        actorUrl,
        authorHandle,
        authorIcon,
        note.content,
        normalizeVisibility(note.visibility),
        note.cw ? 1 : 0,
        note.cw,
        publishedAt,
      );
      imported++;
    } catch (err) {
      failed++;
      if (errors.length < 10) {
        errors.push(`${note.sourceId}: ${(err as Error).message}`);
      }
    }
  }

  if (notes.length > MAX_POSTS_PER_IMPORT) {
    errors.push(`一度に取り込めるのは ${MAX_POSTS_PER_IMPORT} 件までです（残り ${notes.length - MAX_POSTS_PER_IMPORT} 件は分割して取り込んでください）`);
  }

  return { imported, skipped, failed, total: notes.length, errors };
}
