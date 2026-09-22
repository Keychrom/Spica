import { createRequire } from 'node:module';
import { adb, UserRow, PostRow, FollowRow, ReactionRow } from './db.js';
import { config } from './config.js';

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
  };
}

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
}

/**
 * ユーザーの全データを抽出して構造化オブジェクトを返す
 */
export async function exportUserData(userId: string): Promise<UserExportData> {
  const user = await adb.prepare(`
    SELECT id, name, summary, icon_url, banner_url, role, public_key_pem, created_at
    FROM users WHERE id = ?
  `).get(userId) as (UserRow & { public_key_pem: string }) | undefined;

  if (!user) {
    throw new Error(`ユーザー @${userId} が見つかりませんでした。`);
  }

  const actorUrl = `${config.origin}/users/${user.id}`;
  const handle = `@${user.id}@${config.domain}`;

  // 1. 投稿一覧
  const postRows = await adb.prepare(`
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
  const followingRows = await adb.prepare(`
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
  const followerRows = await adb.prepare(`
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
  const bookmarkRows = await adb.prepare(`
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
  const reactionRows = await adb.prepare(`
    SELECT r.reaction, r.post_id, r.created_at, COALESCE(p.content, '') as post_content
    FROM reactions r
    LEFT JOIN posts p ON r.post_id = p.id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(userId) as any[];

  const reactions = reactionRows.map((r) => ({
    reaction: r.reaction,
    post_id: r.post_id,
    post_content: r.post_content.slice(0, 100),
    created_at: r.created_at,
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
        `  - spica-full-backup.json: 上記全データを1つにまとめた完全バックアップ`,
        ``,
        `※ 「自分のデータは自分のもの（データ主権）」の理念に基づき出力されています。`,
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
