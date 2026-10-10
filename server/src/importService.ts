import crypto from 'node:crypto';
import { db, UserRow } from './db.js';
import { config } from './config.js';
import { normalizeVisibility, PostVisibility } from './postVisibility.js';
import { MAX_POST_ATTACHMENTS } from './postService.js';
import { uploadMediaFile, UploadedMedia } from './storage.js';
import { checkMediaQuota, recordMedia } from './mediaService.js';

/**
 * アカウント移行インポート（Phase 1: 投稿の取り込み / Phase 2: Spica 自身のエクスポート）
 *
 * 対応形式:
 *   - Spica    : このアプリのエクスポート（ZIP / JSON。`spica-full-backup.json` か ZIP 内の
 *                `posts.json` など）。本文に加えてメディア・フォロー・フォロワー・
 *                ブックマーク・リアクションを取り込む（Phase 2）
 *   - Mastodon : アーカイブ内の outbox.json（ActivityStreams の Create(Note) 配列）
 *   - Misskey  : エクスポートの notes.json（note オブジェクト配列）
 *   - 汎用     : 上記いずれかに近い配列 / オブジェクト
 *
 * 取り込む情報: 本文・CW・公開範囲・投稿日時（元の日時を保持して時系列を維持）
 *
 * ■ 取り込みの作法（Phase 2 で付随データを増やしたときの約束）
 *   - **冪等**: 投稿 ID は元の ID から決定的に作り、付随データは `ON CONFLICT DO NOTHING` で入れる。
 *     同じファイルを 2 回取り込んでも増えない
 *   - **止まらない**: 1 件の失敗で全体を止めず、件数を数えて報告する（`errors` は先頭 10 件まで）
 *   - **配送しない**: 連合配送・通知・アンテナ判定・SSE は行わない（過去ログの復元のため）
 *   - メディアは **ZIP に同梱された実ファイルだけ**を取り込む（JSON 単体には実ファイルが無い）
 */

export type ImportFormat = 'spica' | 'mastodon' | 'misskey' | 'generic';

/** 種類ごとの取り込み件数 */
export interface ImportCount {
  imported: number;
  skipped: number;
}

export interface ImportResult {
  format: ImportFormat;
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  errors: string[];
  /** Phase 2（Spica 形式のみ。他の形式では 0） */
  media: ImportCount;
  following: ImportCount;
  followers: ImportCount;
  bookmarks: ImportCount;
  reactions: ImportCount;
}

/** 一度に取り込める投稿の上限 */
const MAX_POSTS_PER_IMPORT = 5000;
/** 一度に取り込めるメディア実ファイルの上限（件数と合計サイズ。超えた分は「スキップ」として報告） */
const MAX_MEDIA_PER_IMPORT = 500;
const MAX_MEDIA_BYTES_PER_IMPORT = 200 * 1024 * 1024;
/** 付随データ（フォロー・フォロワー・ブックマーク・リアクション）の上限 */
const MAX_RELATIONS_PER_IMPORT = 5000;
/** 1 投稿に添付できるメディアの数（投稿作成側と同じ値を共有する） */
const MAX_ATTACHMENTS_PER_POST = MAX_POST_ATTACHMENTS;
/** 1 投稿の本文・CW の上限（壊れたアーカイブで巨大な値を入れさせない） */
const MAX_CONTENT_LENGTH = 100000;
const MAX_CW_LENGTH = 1000;
/** 記録する注意書き・エラーの件数（それ以上は数だけ数える） */
const MAX_NOTES = 10;

/** 空の集計を作る */
function emptyCount(): ImportCount {
  return { imported: 0, skipped: 0 };
}

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

/** 取り込み元の (投稿ID, リアクション) から決定的なリアクションIDを作る（再取り込みで重複しない） */
function buildImportedReactionId(postId: string, reaction: string): string {
  const hash = crypto.createHash('sha1').update(`${postId}|${reaction}`).digest('hex').slice(0, 16);
  return `${config.origin}/activities/react/import-${hash}`;
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
  // Spica 自身のエクスポート（full-backup.json）: 投稿以外も付随するので専用の取り込み口を使う
  if (isSpicaExport(data)) {
    return { format: 'spica', notes: [] };
  }

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
export async function importNotes(user: UserRow, notes: NormalizedNote[]): Promise<Omit<ImportResult, 'format'>> {
  const actorUrl = `${config.origin}/users/${user.id}`;
  const authorHandle = `@${user.id}@${config.domain}`;
  const authorIcon = user.icon_url || '';

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  const insert = await db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, in_reply_to, quote_id, is_sensitive, media_attachments, cw, published_at, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', NULL, NULL, ?, '[]', ?, ?, NULL)
  `);

  const targets = notes.slice(0, MAX_POSTS_PER_IMPORT);

  for (const note of targets) {
    try {
      const postId = buildImportedPostId(actorUrl, note.sourceId);
      const existing = await db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
      if (existing) {
        skipped++;
        continue;
      }

      // 日時が不正な場合は取り込み時刻で補う
      const publishedAt = Number.isNaN(Date.parse(note.publishedAt))
        ? new Date().toISOString()
        : new Date(note.publishedAt).toISOString();

      // await する（PostgreSQL では待たないと、取り込みの集計と実際の行数がずれる）
      await insert.run(
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
      if (errors.length < MAX_NOTES) {
        errors.push(`${note.sourceId}: ${(err as Error).message}`);
      }
    }
  }

  if (notes.length > MAX_POSTS_PER_IMPORT) {
    errors.push(`一度に取り込めるのは ${MAX_POSTS_PER_IMPORT} 件までです（残り ${notes.length - MAX_POSTS_PER_IMPORT} 件は分割して取り込んでください）`);
  }

  return {
    imported,
    skipped,
    failed,
    total: notes.length,
    errors,
    media: emptyCount(),
    following: emptyCount(),
    followers: emptyCount(),
    bookmarks: emptyCount(),
    reactions: emptyCount(),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Spica 自身のエクスポート（ZIP / JSON）の取り込み
// ---------------------------------------------------------------------------

export interface SpicaExportBundle {
  posts: any[];
  following: any[];
  followers: any[];
  bookmarks: any[];
  reactions: any[];
  media: any[];
  /** ZIP 内の実ファイル（検証済みの相対パス → 中身）。JSON 単体の取り込みでは空 */
  files: Map<string, Buffer>;
}

/** Spica 自身のエクスポート（`spica-full-backup.json`、または ZIP 内の posts.json 相当）かどうか */
export function isSpicaExport(data: any): boolean {
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Array.isArray(data.posts) &&
    data.manifest &&
    typeof data.manifest === 'object' &&
    data.account &&
    typeof data.account === 'object',
  );
}

/** 配列として使える要素だけを取り出す（文字列などが混ざっていても落とさない） */
function asArrayOfObjects(value: unknown): any[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

/** エクスポートの中身を正規化する（欠けているカテゴリは空配列にする） */
export function buildSpicaBundle(data: any, files: Map<string, Buffer> = new Map()): SpicaExportBundle {
  return {
    posts: asArrayOfObjects(data?.posts),
    following: asArrayOfObjects(data?.following),
    followers: asArrayOfObjects(data?.followers),
    bookmarks: asArrayOfObjects(data?.bookmarks),
    reactions: asArrayOfObjects(data?.reactions),
    media: asArrayOfObjects(data?.media),
    files,
  };
}

/**
 * ZIP の中身からバンドルを組み立てる。
 * `spica-full-backup.json` があればそれを、無ければカテゴリ別の JSON を使う。
 */
export function buildSpicaBundleFromZip(entries: Map<string, Buffer>): SpicaExportBundle {
  const readJson = (name: string): any => {
    const buf = entries.get(name);
    if (!buf) return null;
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null; // 壊れた JSON は「無い」ものとして扱う（他のファイルで続行する）
    }
  };

  const full = readJson('spica-full-backup.json');
  if (isSpicaExport(full)) {
    return buildSpicaBundle(full, entries);
  }
  return buildSpicaBundle(
    {
      posts: readJson('posts.json'),
      following: readJson('following.json'),
      followers: readJson('followers.json'),
      bookmarks: readJson('bookmarks.json'),
      reactions: readJson('reactions.json'),
      media: readJson('media.json'),
    },
    entries,
  );
}

/** 取り込み元の値から文字列を取り出す（型が違っても落とさない） */
function safeString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/** 日時として使える値だけを受け付ける（不正なら取り込み時刻で補う） */
function safeTimestamp(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return Number.isNaN(Date.parse(raw)) ? new Date().toISOString() : new Date(raw).toISOString();
}

/** このインスタンスのユーザーの Actor URL ならユーザーIDを返す（外部の URL なら null） */
function localUserIdFromActorUrl(actorUrl: string): string | null {
  const prefix = `${config.origin}/users/`;
  if (!actorUrl.startsWith(prefix)) return null;
  const id = actorUrl.slice(prefix.length);
  if (!id || id.includes('/') || id.includes('?') || id.includes('#')) return null;
  return id;
}

/**
 * アーカイブ内の投稿IDから、いま手元にある投稿のIDを探す。
 * 同じアーカイブで取り込んだ投稿は新しい ID に読み替える（返信先・ブックマーク・リアクション用）。
 */
async function resolveLocalPostId(sourceId: string, idMap: Map<string, string>): Promise<string | null> {
  const candidates = new Set<string>();
  const mapped = idMap.get(sourceId);
  if (mapped) candidates.add(mapped);
  candidates.add(sourceId);
  if (sourceId.includes('%')) {
    try {
      candidates.add(decodeURIComponent(sourceId));
    } catch {
      // 不正なパーセントエンコーディングは無視する
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const row = (await db.prepare('SELECT id FROM posts WHERE id = ?').get(candidate)) as { id: string } | undefined;
    if (row) return row.id;
  }
  return null;
}

/**
 * フォロー関係を 1 行入れる（冪等。既にあれば `skipped`）。
 *
 * ・相手が同じインスタンスのユーザーなら `accepted`（即時成立。移行なので通知は送らない）
 * ・リモートの相手は**行の復元だけ**行う（`inbox_url` は空のまま＝配送しない。相手側では
 *   フォローが成立していない可能性がある）
 * ・相手を特定できない（同名の別インスタンスなど）ときは静かにスキップする
 */
async function insertImportedFollow(params: {
  followerUrl: string;
  followingUrl: string;
  createdAt: string;
  /** 自分が起点のフォロー（自分のフォロー一覧）なら 1、相手が起点（フォロワー）なら 0 */
  isLocal: number;
  selfUrl: string;
}): Promise<'imported' | 'skipped'> {
  const { followerUrl, followingUrl, createdAt, isLocal, selfUrl } = params;
  if (!followerUrl.startsWith('http') || !followingUrl.startsWith('http')) return 'skipped';
  if (followerUrl === followingUrl) return 'skipped'; // 自分自身はフォローにならない

  // 相手が同じインスタンスのユーザーなら、そのユーザーの Inbox を控えて即時成立にする
  const counterpart = followerUrl === selfUrl ? followingUrl : followerUrl;
  let inboxUrl = '';
  const localId = localUserIdFromActorUrl(counterpart);
  if (localId) {
    const localUser = (await db.prepare('SELECT id FROM users WHERE id = ?').get(localId)) as
      | { id: string }
      | undefined;
    if (!localUser) return 'skipped'; // 手元に居ないユーザー（同名の別インスタンス）は静かにスキップ
    inboxUrl = `${counterpart}/inbox`;
  }

  const result = await db.prepare(`
    INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'accepted', ?)
    ON CONFLICT(follower_url, following_url) DO NOTHING
  `).run(`${followerUrl} -> ${followingUrl}`, followerUrl, followingUrl, inboxUrl, isLocal, createdAt);

  return Number(result.changes ?? 0) > 0 ? 'imported' : 'skipped';
}

/**
 * Spica のエクスポート（ZIP / JSON）を取り込む。
 * 投稿 → メディア → フォロー / フォロワー → ブックマーク → リアクションの順に処理し、
 * それぞれの件数を数えて返す（1 件の失敗で全体を止めない）。
 */
export async function importSpicaArchive(user: UserRow, bundle: SpicaExportBundle): Promise<ImportResult> {
  const actorUrl = `${config.origin}/users/${user.id}`;
  const authorHandle = `@${user.id}@${config.domain}`;
  const authorIcon = user.icon_url || '';

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const media = emptyCount();
  const following = emptyCount();
  const followers = emptyCount();
  const bookmarks = emptyCount();
  const reactions = emptyCount();

  const pushNote = (message: string): void => {
    if (errors.length < MAX_NOTES) errors.push(message);
  };

  const targets = bundle.posts.slice(0, MAX_POSTS_PER_IMPORT);
  if (bundle.posts.length > MAX_POSTS_PER_IMPORT) {
    pushNote(`一度に取り込める投稿は ${MAX_POSTS_PER_IMPORT} 件までです（残り ${bundle.posts.length - MAX_POSTS_PER_IMPORT} 件は分割して取り込んでください）`);
  }

  // 取り込み後の投稿 ID を先に確定する（返信先の読み替え・ブックマーク・リアクションで使う）
  const idMap = new Map<string, string>();
  targets.forEach((post, index) => {
    const sourceId = safeString(post?.id, 500) || `spica-post-${index}`;
    idMap.set(sourceId, buildImportedPostId(actorUrl, sourceId));
  });

  // メディアの台帳（元の URL → ZIP 内の実ファイルの位置を知るために使う）
  const mediaByUrl = new Map<string, any>();
  for (const item of bundle.media) {
    const url = safeString(item?.url, 1000);
    if (url) mediaByUrl.set(url, item);
  }

  const insertPost = await db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, in_reply_to, quote_id, is_sensitive, media_attachments, cw, published_at, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)
  `);

  let mediaBytes = 0;
  let mediaQuotaNoted = false;

  for (let index = 0; index < targets.length; index++) {
    const post = targets[index];
    const sourceId = safeString(post?.id, 500) || `spica-post-${index}`;
    const postId = idMap.get(sourceId)!;
    try {
      const existing = await db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
      if (existing) {
        skipped++; // 再取り込み。メディアもアップロードしない（冪等）
        continue;
      }

      // 1. 添付メディアの実ファイルをドライブへ保存する（ZIP に無い分は静かに落とす）
      const attachments: any[] = [];
      const uploaded: UploadedMedia[] = [];
      for (const att of asArrayOfObjects(post?.media_attachments).slice(0, MAX_ATTACHMENTS_PER_POST)) {
        const url = safeString(att?.url, 1000);
        if (!url) continue;
        const ledger = mediaByUrl.get(url);
        const archivePath = ledger ? safeString(ledger?.archive_path, 500) || safeString(ledger?.key, 500) : '';
        const data = archivePath ? bundle.files.get(archivePath) : undefined;
        if (!data || data.length === 0) {
          media.skipped++; // 実ファイルが同梱されていない（JSON 単体の取り込みなど）
          continue;
        }
        if (media.imported + uploaded.length >= MAX_MEDIA_PER_IMPORT || mediaBytes + data.length > MAX_MEDIA_BYTES_PER_IMPORT) {
          media.skipped++;
          pushNote(`メディアは一度に ${MAX_MEDIA_PER_IMPORT} 件 / ${Math.floor(MAX_MEDIA_BYTES_PER_IMPORT / (1024 * 1024))}MB までです（残りは取り込めませんでした）`);
          continue;
        }
        const quota = await checkMediaQuota(user.id, data.length);
        if (!quota.ok) {
          media.skipped++;
          if (!mediaQuotaNoted) {
            mediaQuotaNoted = true;
            pushNote(quota.error || 'ドライブの容量上限を超えるため、メディアの一部を取り込めませんでした。');
          }
          continue;
        }
        const saved = await uploadMediaFile({
          buffer: data,
          originalname: safeString(ledger?.name, 300) || archivePath.split('/').pop() || 'import.bin',
          mimetype: safeString(ledger?.media_type, 100) || safeString(att?.mediaType, 100) || 'application/octet-stream',
          size: data.length,
          userId: user.id,
        });
        mediaBytes += data.length;
        uploaded.push(saved);
        attachments.push({
          url: saved.url,
          mediaType: saved.mediaType,
          name: safeString(att?.name, 300) || saved.name || '',
          description: safeString(att?.description, 1500),
          size: saved.size,
          width: saved.width ?? (typeof att?.width === 'number' ? att.width : undefined),
          height: saved.height ?? (typeof att?.height === 'number' ? att.height : undefined),
          duration: saved.duration ?? (typeof att?.duration === 'number' ? att.duration : undefined),
          thumbnailUrl: saved.thumbnailUrl,
        });
      }

      const content = safeString(post?.content, MAX_CONTENT_LENGTH);
      if (!content.trim() && attachments.length === 0) {
        skipped++; // 本文もメディアも無い投稿は復元するものがない
        continue;
      }

      // 返信先がアーカイブ内（または手元）にあれば読み替える。無ければ NULL（ぶら下がりを残さない）
      const inReplyToRaw = safeString(post?.in_reply_to, 500);
      const inReplyTo = inReplyToRaw ? await resolveLocalPostId(inReplyToRaw, idMap) : null;

      const emojis = asArrayOfObjects(post?.emojis)
        .slice(0, 100)
        .map((e) => ({ name: safeString(e?.name, 100), url: safeString(e?.url, 1000) }))
        .filter((e) => e.name && e.url);
      const cw = safeString(post?.cw, MAX_CW_LENGTH);

      await insertPost.run(
        postId,
        user.id,
        user.name,
        actorUrl,
        authorHandle,
        authorIcon,
        content,
        normalizeVisibility(post?.visibility),
        emojis.length > 0 ? JSON.stringify(emojis) : '[]',
        inReplyTo,
        post?.is_sensitive ? 1 : 0,
        attachments.length > 0 ? JSON.stringify(attachments) : '[]',
        cw ? cw : null,
        safeTimestamp(post?.published_at),
      );
      imported++;
      media.imported += uploaded.length;

      // 2. ドライブの台帳に記録して投稿へ紐づける（投稿が入ってから。失敗しても投稿は残す）
      for (const saved of uploaded) {
        try {
          await recordMedia({
            userId: user.id,
            url: saved.url,
            key: saved.key,
            mediaType: saved.mediaType,
            size: saved.size,
            name: saved.name,
            thumbnailUrl: saved.thumbnailUrl,
            thumbnailKey: saved.thumbnailKey,
            width: saved.width,
            height: saved.height,
            duration: saved.duration,
            postId,
          });
        } catch (err) {
          pushNote(`メディアの台帳登録に失敗しました（${saved.key}）: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      failed++;
      pushNote(`${sourceId}: ${(err as Error).message}`);
    }
  }

  // 3. フォロー（自分 → 相手）と 4. フォロワー（相手 → 自分）
  let remoteFollowRows = 0;
  const importFollows = async (
    rows: any[],
    direction: 'following' | 'followers',
    counter: ImportCount,
  ): Promise<void> => {
    if (rows.length > MAX_RELATIONS_PER_IMPORT) {
      pushNote(`一度に取り込めるフォロー関係は ${MAX_RELATIONS_PER_IMPORT} 件までです（残りは分割して取り込んでください）`);
    }
    for (const item of rows.slice(0, MAX_RELATIONS_PER_IMPORT)) {
      try {
        const counterpartUrl = direction === 'following'
          ? safeString(item?.following_url, 1000).trim()
          : safeString(item?.follower_url, 1000).trim();
        if (!counterpartUrl) {
          counter.skipped++;
          continue;
        }
        if (!localUserIdFromActorUrl(counterpartUrl)) remoteFollowRows++;

        const outcome = await insertImportedFollow({
          followerUrl: direction === 'following' ? actorUrl : counterpartUrl,
          followingUrl: direction === 'following' ? counterpartUrl : actorUrl,
          createdAt: safeTimestamp(item?.created_at),
          isLocal: direction === 'following' ? 1 : localUserIdFromActorUrl(counterpartUrl) ? 1 : 0,
          selfUrl: actorUrl,
        });
        counter[outcome]++;
      } catch (err) {
        counter.skipped++;
        pushNote(`${direction === 'following' ? 'フォロー' : 'フォロワー'}の取り込みに失敗しました: ${(err as Error).message}`);
      }
    }
  };
  await importFollows(bundle.following, 'following', following);
  await importFollows(bundle.followers, 'followers', followers);
  if (remoteFollowRows > 0) {
    pushNote(`リモートの相手（${remoteFollowRows} 件）はフォロー行の復元のみ行いました（配送は行わないため、相手側では成立していない場合があります）`);
  }

  // 5. ブックマーク（対象の投稿が手元に無ければスキップ）
  const insertBookmark = await db.prepare(
    'INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  if (bundle.bookmarks.length > MAX_RELATIONS_PER_IMPORT) {
    pushNote(`一度に取り込めるブックマークは ${MAX_RELATIONS_PER_IMPORT} 件までです（残りは分割して取り込んでください）`);
  }
  for (const item of bundle.bookmarks.slice(0, MAX_RELATIONS_PER_IMPORT)) {
    try {
      const sourceId = safeString(item?.post_id, 500);
      const targetId = sourceId ? await resolveLocalPostId(sourceId, idMap) : null;
      if (!targetId) {
        bookmarks.skipped++; // 対象の投稿が手元に無い
        continue;
      }
      const result = await insertBookmark.run(user.id, targetId, safeTimestamp(item?.bookmarked_at));
      if (Number(result.changes ?? 0) > 0) bookmarks.imported++;
      else bookmarks.skipped++;
    } catch (err) {
      bookmarks.skipped++;
      pushNote(`ブックマークの取り込みに失敗しました: ${(err as Error).message}`);
    }
  }

  // 6. リアクション（対象の投稿が手元に無ければスキップ。配送・通知は行わない）
  const insertReaction = await db.prepare(`
    INSERT INTO reactions (id, post_id, user_id, user_name, user_icon, reaction, is_local, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT DO NOTHING
  `);
  if (bundle.reactions.length > MAX_RELATIONS_PER_IMPORT) {
    pushNote(`一度に取り込めるリアクションは ${MAX_RELATIONS_PER_IMPORT} 件までです（残りは分割して取り込んでください）`);
  }
  for (const item of bundle.reactions.slice(0, MAX_RELATIONS_PER_IMPORT)) {
    try {
      const reaction = safeString(item?.reaction, 100).trim();
      const sourceId = safeString(item?.post_id, 500);
      const targetId = sourceId ? await resolveLocalPostId(sourceId, idMap) : null;
      if (!reaction || !targetId) {
        reactions.skipped++; // 絵文字が空・対象の投稿が手元に無い
        continue;
      }
      const result = await insertReaction.run(
        buildImportedReactionId(targetId, reaction),
        targetId,
        actorUrl,
        user.name,
        authorIcon,
        reaction,
        safeTimestamp(item?.created_at),
      );
      if (Number(result.changes ?? 0) > 0) reactions.imported++;
      else reactions.skipped++;
    } catch (err) {
      reactions.skipped++;
      pushNote(`リアクションの取り込みに失敗しました: ${(err as Error).message}`);
    }
  }

  return {
    format: 'spica',
    imported,
    skipped,
    failed,
    total: bundle.posts.length,
    errors,
    media,
    following,
    followers,
    bookmarks,
    reactions,
  };
}

/** 取り込み結果の要約（API の `message` と画面表示に使う） */
export function buildImportMessage(result: Omit<ImportResult, 'format'>): string {
  const head = `投稿 ${result.imported} 件を取り込みました（重複スキップ ${result.skipped} 件 / 失敗 ${result.failed} 件）。`;
  const extras: string[] = [];
  const append = (label: string, count: ImportCount): void => {
    if (count.imported === 0 && count.skipped === 0) return;
    extras.push(count.skipped > 0 ? `${label} ${count.imported} 件（スキップ ${count.skipped} 件）` : `${label} ${count.imported} 件`);
  };
  append('メディア', result.media);
  append('フォロー', result.following);
  append('フォロワー', result.followers);
  append('ブックマーク', result.bookmarks);
  append('リアクション', result.reactions);
  return extras.length > 0 ? `${head}${extras.join('、')}も取り込みました。` : head;
}
