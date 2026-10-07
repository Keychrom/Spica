import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { db, UserRow, PostRow, FollowRow, ReactionRow } from './db.js';
import { config } from './config.js';
import { registerJobHandler, setJobResult } from './jobs.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

export interface ExportDataManifest {
  version: string;
  generator: string;
  exported_at: string;
  user_id: string;
  handle: string;
  counts: {
    posts: number;
    following: number;
    followers: number;
    bookmarks: number;
    reactions: number;
    /** ドライブのメディア（台帳の件数。ZIP では実ファイルも同梱する） */
    media: number;
  };
}

/** エクスポートに含めるメディア 1 件（`archive_path` は ZIP 内の位置。読めなかったものには付かない） */
export interface ExportMediaItem {
  id: string;
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
  archive_path?: string;
}

/** ZIP に同梱するメディアの上限（取り込み側の受け入れ上限に収まる範囲にする） */
const MAX_EXPORT_MEDIA_FILES = 200;
const MAX_EXPORT_MEDIA_BYTES = 32 * 1024 * 1024;
/** リモート保存（S3/R2）のメディアを取得するときの打ち切り時間 */
const MEDIA_FETCH_TIMEOUT_MS = 10000;

export interface UserExportData {
  manifest: ExportDataManifest;
  account: {
    id: string;
    name: string;
    summary: string;
    icon_url: string;
    banner_url: string;
    created_at: string;
    role: string;
    actor_url: string;
    handle: string;
    public_key_pem: string;
  };
  posts: Array<{
    id: string;
    content: string;
    cw: string | null;
    visibility: string;
    published_at: string;
    in_reply_to: string | null;
    media_attachments: any[];
    emojis: any[];
    reactions_count: number;
    renote_count: number;
  }>;
  following: Array<{
    following_url: string;
    created_at: string;
  }>;
  followers: Array<{
    follower_url: string;
    created_at: string;
  }>;
  bookmarks: Array<{
    post_id: string;
    bookmarked_at: string;
    content: string;
    author_name: string;
    author_handle: string;
    published_at: string;
  }>;
  reactions: Array<{
    reaction: string;
    post_id: string;
    post_content: string;
    created_at: string;
  }>;
  media: ExportMediaItem[];
}

/**
 * メディアの実ファイルを読む（ローカル保存ならディスク、S3/R2 なら公開 URL から）。
 * 読めなかった場合は null を返す（同梱せず、台帳の記録だけ残す）。
 */
async function readMediaFileBuffer(key: string, url: string): Promise<Buffer | null> {
  // ローカル保存: key = `media/<userId>/<file>` → `data/uploads/<userId>/<file>`（storage.ts と同じ場所）
  const relative = key.replace(/^media\//, '');
  if (relative && !relative.includes('..') && !relative.includes('\\')) {
    try {
      const filePath = path.resolve(process.cwd(), 'data', 'uploads', relative);
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
    } catch {
      // ローカルに無ければ URL からの取得を試す
    }
  }
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null; // 取得できないメディアは同梱しない（取り込み側ではスキップとして数える）
  }
}

/** ZIP 内の位置（相対パス）に使える形へ直す（`..` や区切り記号は落とす） */
function toArchivePath(key: string): string {
  const parts = key
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((part) => part && part !== '.' && part !== '..');
  return parts.length > 0 ? parts.join('/') : '';
}

/**
 * ドライブのメディアを ZIP に同梱できる形で集める。
 * 実ファイルが読めたものだけ `archive_path` を付け、件数・合計サイズの上限で打ち切る。
 */
async function collectExportMediaFiles(rows: any[]): Promise<{ files: { path: string; buffer: Buffer }[]; rows: ExportMediaItem[] }> {
  const files: { path: string; buffer: Buffer }[] = [];
  const usedPaths = new Set<string>();
  let totalBytes = 0;
  const out: ExportMediaItem[] = [];

  for (const row of rows) {
    const item: ExportMediaItem = { ...row };
    const path0 = toArchivePath(typeof row.key === 'string' ? row.key : '');
    const withinLimits = files.length < MAX_EXPORT_MEDIA_FILES && totalBytes < MAX_EXPORT_MEDIA_BYTES;
    if (path0 && !usedPaths.has(path0) && withinLimits) {
      const buffer = await readMediaFileBuffer(typeof row.key === 'string' ? row.key : '', typeof row.url === 'string' ? row.url : '');
      if (buffer && buffer.length > 0 && totalBytes + buffer.length <= MAX_EXPORT_MEDIA_BYTES) {
        usedPaths.add(path0);
        files.push({ path: path0, buffer });
        totalBytes += buffer.length;
        item.archive_path = path0;
      }
    }
    out.push(item);
  }

  if (rows.length > files.length) {
    console.log(`[Export] 📎 メディア ${rows.length} 件のうち ${files.length} 件の実ファイルを ZIP に同梱しました`);
  }
  return { files, rows: out };
}

/**
 * ユーザーの全データを抽出して構造化オブジェクトを返す
 */
export async function exportUserData(userId: string): Promise<UserExportData> {
  const user = await db.prepare(`
    SELECT id, name, summary, icon_url, banner_url, role, public_key_pem, created_at
    FROM users WHERE id = ?
  `).get(userId) as (UserRow & { public_key_pem: string }) | undefined;

  if (!user) {
    throw new Error(`ユーザー @${userId} が見つかりませんでした。`);
  }

  const actorUrl = `${config.origin}/users/${user.id}`;
  const handle = `@${user.id}@${config.domain}`;

  // 1. 投稿一覧
  const postRows = await db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id) as reactions_count,
      (SELECT COUNT(*) FROM announces a WHERE a.post_id = p.id) as renote_count
    FROM posts p
    WHERE p.user_id = ?
    ORDER BY p.published_at DESC
  `).all(userId) as any[];

  const posts = postRows.map((p) => {
    let media = [];
    let emojis = [];
    try { if (p.media_attachments) media = JSON.parse(p.media_attachments); } catch {}
    try { if (p.emojis) emojis = JSON.parse(p.emojis); } catch {}

    return {
      id: p.id,
      content: p.content,
      cw: p.cw || null,
      visibility: p.visibility || 'public',
      published_at: p.published_at,
      in_reply_to: p.in_reply_to || null,
      media_attachments: media,
      emojis: emojis,
      reactions_count: Number(p.reactions_count || 0),
      renote_count: Number(p.renote_count || 0),
    };
  });

  // 2. フォロー一覧
  const followingRows = await db.prepare(`
    SELECT following_url, created_at
    FROM follows
    WHERE follower_url = ? AND status = 'accepted'
    ORDER BY created_at DESC
  `).all(actorUrl) as any[];

  const following = followingRows.map((f) => ({
    following_url: f.following_url,
    created_at: f.created_at,
  }));

  // 3. フォロワー一覧
  const followerRows = await db.prepare(`
    SELECT follower_url, created_at
    FROM follows
    WHERE following_url = ? AND status = 'accepted'
    ORDER BY created_at DESC
  `).all(actorUrl) as any[];

  const followers = followerRows.map((f) => ({
    follower_url: f.follower_url,
    created_at: f.created_at,
  }));

  // 4. ブックマーク一覧
  const bookmarkRows = await db.prepare(`
    SELECT b.created_at as bookmarked_at, p.id as post_id, p.content, p.author_name, p.author_handle, p.published_at
    FROM bookmarks b
    JOIN posts p ON b.post_id = p.id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).all(userId) as any[];

  const bookmarks = bookmarkRows.map((b) => ({
    post_id: b.post_id,
    bookmarked_at: b.bookmarked_at,
    content: b.content,
    author_name: b.author_name,
    author_handle: b.author_handle,
    published_at: b.published_at,
  }));

  // 5. リアクション履歴
  //    `reactions.user_id` は API から付けた分は Actor URL、直接投入した分はユーザーID のことがある。
  //    どちらでも拾えるように両方で照合する（片方だけだと、実際に付けたリアクションが空になる）。
  const reactionRows = await db.prepare(`
    SELECT r.reaction, r.post_id, r.created_at, COALESCE(p.content, '') as post_content
    FROM reactions r
    LEFT JOIN posts p ON r.post_id = p.id
    WHERE r.user_id = ? OR r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(actorUrl, userId) as any[];

  const reactions = reactionRows.map((r) => ({
    reaction: r.reaction,
    post_id: r.post_id,
    post_content: r.post_content.slice(0, 100),
    created_at: r.created_at,
  }));

  // 6. ドライブのメディア台帳（ZIP では実ファイルも同梱する。JSON は記録のみ）
  const mediaRows = await db.prepare(`
    SELECT id, url, key, media_type, size, name, thumbnail_url, thumbnail_key, width, height, duration, post_id, created_at
    FROM media
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as ExportMediaItem[];

  const media: ExportMediaItem[] = mediaRows.map((m) => ({
    id: m.id,
    url: m.url,
    key: m.key,
    media_type: m.media_type,
    size: Number(m.size || 0),
    name: m.name || '',
    thumbnail_url: m.thumbnail_url || '',
    thumbnail_key: m.thumbnail_key || '',
    width: m.width ?? null,
    height: m.height ?? null,
    duration: m.duration ?? null,
    post_id: m.post_id ?? null,
    created_at: m.created_at,
  }));

  const manifest: ExportDataManifest = {
    version: '1.0',
    generator: `Spica / ${config.instanceName}`,
    exported_at: new Date().toISOString(),
    user_id: user.id,
    handle,
    counts: {
      posts: posts.length,
      following: following.length,
      followers: followers.length,
      bookmarks: bookmarks.length,
      reactions: reactions.length,
      media: media.length,
    },
  };

  return {
    manifest,
    account: {
      id: user.id,
      name: user.name,
      summary: user.summary,
      icon_url: user.icon_url || '',
      banner_url: user.banner_url || '',
      created_at: user.created_at,
      role: user.role,
      actor_url: actorUrl,
      handle,
      public_key_pem: user.public_key_pem,
    },
    posts,
    following,
    followers,
    bookmarks,
    reactions,
    media,
  };
}

/**
 * ユーザーの全データを ZIP アーカイブとしてストリーミング生成する
 */
export async function streamUserExportZip(userId: string, outputStream: NodeJS.WritableStream): Promise<void> {
  // 中で await するため async な executor にする（失敗は内側の try/catch が reject へ流す）
  return new Promise((resolve, reject) => {
    void (async () => {
    const options = { zlib: { level: 9 } };
    const archive = typeof archiver === 'function'
      ? archiver('zip', options)
      : (archiver.ZipArchive ? new archiver.ZipArchive(options) : new archiver.Archiver('zip', options));

    archive.on('error', (err: any) => {
      reject(err);
    });

    archive.pipe(outputStream);

    try {
      const data = await exportUserData(userId);

      // ドライブのメディアは実ファイルごと同梱する（読めなかったものは台帳の記録だけ残す）
      const mediaFiles = await collectExportMediaFiles(data.media);
      data.media = mediaFiles.rows;

      // manifest.json
      archive.append(JSON.stringify(data.manifest, null, 2), { name: 'manifest.json' });

      // account.json
      archive.append(JSON.stringify(data.account, null, 2), { name: 'account.json' });

      // posts.json
      archive.append(JSON.stringify(data.posts, null, 2), { name: 'posts.json' });

      // following.json
      archive.append(JSON.stringify(data.following, null, 2), { name: 'following.json' });

      // followers.json
      archive.append(JSON.stringify(data.followers, null, 2), { name: 'followers.json' });

      // bookmarks.json
      archive.append(JSON.stringify(data.bookmarks, null, 2), { name: 'bookmarks.json' });

      // reactions.json
      archive.append(JSON.stringify(data.reactions, null, 2), { name: 'reactions.json' });

      // media.json（ドライブの台帳。実ファイルは archive_path の位置に格納する）
      archive.append(JSON.stringify(data.media, null, 2), { name: 'media.json' });

      // メディアの実ファイル（画像・動画など）。取り込み時にドライブへ戻す
      for (const file of mediaFiles.files) {
        archive.append(file.buffer, { name: file.path });
      }

      // full-backup.json (統合JSON)
      archive.append(JSON.stringify(data, null, 2), { name: 'spica-full-backup.json' });

      // README.txt
      const readme = [
        `=============================================================`,
        ` Spica データエクスポート (Data Sovereignty Backup)`,
        ` ユーザー: @${data.account.id} (${data.account.name})`,
        ` エクスポート日時: ${data.manifest.exported_at}`,
        ` サーバー: ${config.origin} (${config.instanceName})`,
        `=============================================================`,
        ``,
        `【格納ファイル一覧】`,
        `  - manifest.json: エクスポート概要と件数メタデータ`,
        `  - account.json: アカウント基本情報（プロフィール・公開鍵など）`,
        `  - posts.json: あなたの過去の全投稿（${data.posts.length}件）`,
        `  - following.json: フォロー中アカウント（${data.following.length}件）`,
        `  - followers.json: フォロワー一覧（${data.followers.length}件）`,
        `  - bookmarks.json: 保存したブックマーク投稿（${data.bookmarks.length}件）`,
        `  - reactions.json: 付与したリアクション履歴（${data.reactions.length}件）`,
        `  - media.json: ドライブのメディア台帳（${data.media.length}件。実ファイルは media/ の下に ${mediaFiles.files.length}件を同梱）`,
        `  - spica-full-backup.json: 上記全データを1つにまとめた完全バックアップ`,
        ``,
        `※ 「自分のデータは自分のもの（データ主権）」の理念に基づき出力されています。`,
        `※ このアーカイブは Spica の「他のサーバーからの移行（インポート）」でそのまま取り込めます。`,
        `   （メディアの実ファイルは取り込み時にドライブへ戻され、投稿に紐づきます）`,
        `=============================================================`,
      ].join('\n');
      archive.append(readme, { name: 'README.txt' });

      archive.on('end', () => {
        resolve();
      });

      archive.finalize().catch((err: any) => reject(err));
    } catch (err) {
      archive.abort();
      reject(err);
    }
    })().catch(reject);
  });
}

// ---------------------------------------------------------------------------
// 非同期エクスポート（ジョブキュー経由）
//
// 大きなアカウントのエクスポートは ZIP の生成に時間がかかるため、**リクエストの中で待たせない**。
// 受け付けたらジョブを積み、`jobs.result` に作ったファイルの場所を残す。利用者は状態を見て
// 出来上がったらダウンロードする（`/api/user/export/:jobId` と `:jobId/file`）。
// ---------------------------------------------------------------------------

/** エクスポートの置き場（1 時間で掃除する。ダウンロード後に消す） */
export function getUserExportDir(): string {
  return path.resolve(path.dirname(config.dbPath), 'exports');
}

export interface UserExportFile {
  filePath: string;
  filename: string;
  bytes: number;
}

/** エクスポートを作ってファイルに書き出す（ジョブから呼ぶ） */
export async function buildUserExportFile(userId: string, format: 'json' | 'zip'): Promise<UserExportFile> {
  const dir = getUserExportDir();
  fs.mkdirSync(dir, { recursive: true });
  const dateStr = new Date().toISOString().split('T')[0];
  const safeId = userId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const filename = `spica-export-${safeId}-${dateStr}.${format}`;
  const filePath = path.join(dir, `${crypto.randomUUID()}-${filename}`);

  if (format === 'zip') {
    await streamUserExportZip(userId, fs.createWriteStream(filePath));
  } else {
    const data = await exportUserData(userId);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  return { filePath, filename, bytes: fs.statSync(filePath).size };
}

/** 古いエクスポート（1 時間より前）を消す */
export function cleanupOldUserExports(maxAgeMs = 60 * 60 * 1000): number {
  const dir = getUserExportDir();
  if (!fs.existsSync(dir)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {
      // 消せなくても続ける
    }
  }
  return removed;
}

// ジョブの処理を登録する（`jobs` テーブル経由。ワーカーが拾って実行する）
registerJobHandler('user_export', async (payload: { userId?: string; format?: string }, jobId: string) => {
  const userId = String(payload?.userId || '');
  const format = payload?.format === 'zip' ? 'zip' : 'json';
  if (!userId) throw new Error('userId がありません');
  const built = await buildUserExportFile(userId, format);
  await setJobResult(jobId, built);
});
