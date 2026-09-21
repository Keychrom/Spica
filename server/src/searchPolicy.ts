import { DatabaseSync } from 'node:sqlite';
import { db, getServerSetting, setServerSetting } from './db.js';
import { config } from './config.js';

/**
 * リモートコンテンツの保存・索引ポリシー
 *
 * リレーに参加していると 1 日に数万件のリモート投稿が流入し、DB が急速に膨らむ。
 * Mastodon / Misskey は「本文の全文索引を本体 DB に持たない」「索引する場合も
 * 既定はローカルノートのみ」という方針なので、Spica も既定をそれに合わせる。
 *
 *   FTS 索引スコープ（fts_index_scope）
 *     local   : ローカル投稿だけ索引する（既定・Misskey の Meilisearch 既定スコープ相当）
 *     follows : 加えて「フォロー中アクターの投稿」と「ローカル投稿への返信」も索引する
 *     all     : すべて索引する（従来の Spica の挙動）
 *
 *   リモートのブースト（announces）の保存（remote_announce_policy）
 *     follows : フォロー中アクターのブーストだけ保存する（既定）
 *     all     : すべて保存する（従来の挙動）
 *     none    : リモートのブーストは保存しない
 *
 * 設定は管理画面（server_settings）に保存し、未設定なら環境変数 → 既定値の順で解決する。
 * 既存データへの遡及適用は `npm run db:maintenance -- --apply`（FTS の整理・announces の整理）。
 */

export type FtsIndexScope = 'local' | 'follows' | 'all';
export type RemoteAnnouncePolicy = 'follows' | 'all' | 'none';

export const FTS_SCOPE_LABELS: Record<FtsIndexScope, string> = {
  local: 'ローカル投稿のみ（Mastodon / Misskey 相当・既定）',
  follows: 'ローカル＋フォロー中のアクター＋自分宛の返信',
  all: 'すべての投稿（従来の Spica の挙動）',
};

export const ANNOUNCE_POLICY_LABELS: Record<RemoteAnnouncePolicy, string> = {
  follows: 'フォロー中アクターのブーストのみ（既定）',
  all: 'すべて保存（従来の Spica の挙動）',
  none: 'リモートのブーストは保存しない',
};

function normalizeScope(raw: unknown): FtsIndexScope {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'all' || value === 'follows' || value === 'local') return value;
  return 'local';
}

function normalizeAnnouncePolicy(raw: unknown): RemoteAnnouncePolicy {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'all' || value === 'none' || value === 'follows') return value;
  return 'follows';
}

/**
 * 設定の読み出し。接続を渡すとその接続から読む（メンテナンス CLI 用。
 * サーバーの共有接続を開かずに済ませるため）。
 */
/** server_settings から値を読む（接続を渡せばその接続を使う）。CLI からも使う */
export function readSetting(conn: DatabaseSync | undefined, key: string): string {
  if (!conn) return getServerSetting(key as any, '') || '';
  try {
    const row = conn.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value || '';
  } catch {
    return '';
  }
}

export function getFtsIndexScope(conn?: DatabaseSync): FtsIndexScope {
  const stored = readSetting(conn, 'fts_index_scope');
  if (stored) return normalizeScope(stored);
  return normalizeScope(process.env.FTS_INDEX_SCOPE || config.ftsIndexScope);
}

export function setFtsIndexScope(scope: unknown): FtsIndexScope {
  const value = normalizeScope(scope);
  setServerSetting('fts_index_scope', value);
  return value;
}

export function getRemoteAnnouncePolicy(conn?: DatabaseSync): RemoteAnnouncePolicy {
  const stored = readSetting(conn, 'remote_announce_policy');
  if (stored) return normalizeAnnouncePolicy(stored);
  return normalizeAnnouncePolicy(process.env.REMOTE_ANNOUNCE_POLICY || config.remoteAnnouncePolicy);
}

export function setRemoteAnnouncePolicy(policy: unknown): RemoteAnnouncePolicy {
  const value = normalizeAnnouncePolicy(policy);
  setServerSetting('remote_announce_policy', value);
  return value;
}

/** ローカルユーザーがそのアクターをフォローしているか */
export function isFollowedByLocal(actorUrl: string | null | undefined): boolean {
  if (!actorUrl) return false;
  try {
    const row = db
      .prepare("SELECT 1 FROM follows WHERE following_url = ? AND status = 'accepted' LIMIT 1")
      .get(actorUrl);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** ローカル投稿への返信（または引用）か */
export function isReplyToLocalPost(inReplyTo: string | null | undefined): boolean {
  if (!inReplyTo) return false;
  try {
    const row = db.prepare('SELECT 1 FROM posts WHERE id = ? AND is_local = 1').get(inReplyTo);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 受信したリモート投稿を FTS 索引に入れるか。
 * 挿入時に posts.fts_indexed へ保存し、トリガがそれを見て索引するかどうかを決める。
 */
export function shouldIndexRemotePost(params: { authorUrl?: string | null; inReplyTo?: string | null }): boolean {
  switch (getFtsIndexScope()) {
    case 'all':
      return true;
    case 'follows':
      return isFollowedByLocal(params.authorUrl) || isReplyToLocalPost(params.inReplyTo);
    case 'local':
    default:
      return false;
  }
}

/** 受信したリモートのブースト（Announce）を保存するか */
export function shouldStoreRemoteAnnounce(actorUrl: string | null | undefined): boolean {
  switch (getRemoteAnnouncePolicy()) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'follows':
    default:
      return isFollowedByLocal(actorUrl);
  }
}

export interface FtsPolicyResult {
  /** 索引すべきでないのに索引に残っている投稿 */
  toUnindex: number;
  /** 索引すべきなのに索引に入っていない投稿 */
  toIndex: number;
  /** 方針適用後に残る索引行数 */
  ftsRowsAfter: number;
}

/** 方針を既存データへ遡及適用する（db:maintenance から呼ぶ。接続は呼び出し側が渡す） */
export function applyFtsPolicy(conn: DatabaseSync): FtsPolicyResult {
  const scope = getFtsIndexScope(conn);
  const keepCondition = `
    is_local = 1 OR (
      '${scope}' = 'all' OR (
        '${scope}' = 'follows' AND (
          EXISTS (SELECT 1 FROM follows f WHERE f.following_url = posts.author_url AND f.status = 'accepted')
          OR EXISTS (SELECT 1 FROM posts lp WHERE lp.is_local = 1 AND lp.id = posts.in_reply_to)
        )
      )
    )`;

  // fts_indexed を方針どおりに更新する
  conn.exec(`UPDATE posts SET fts_indexed = CASE WHEN ${keepCondition} THEN 1 ELSE 0 END`);

  const toUnindex = Number(
    (conn.prepare(`SELECT COUNT(*) AS c FROM posts WHERE fts_indexed = 0 AND id IN (SELECT post_id FROM posts_fts)`).get() as any).c,
  );
  const toIndex = Number(
    (conn.prepare(`SELECT COUNT(*) AS c FROM posts WHERE fts_indexed = 1 AND id NOT IN (SELECT post_id FROM posts_fts)`).get() as any).c,
  );

  if (toUnindex > 0) {
    conn.exec('DELETE FROM posts_fts WHERE post_id IN (SELECT id FROM posts WHERE fts_indexed = 0)');
  }
  if (toIndex > 0) {
    conn.exec(`
      INSERT INTO posts_fts(post_id, content)
      SELECT id, content FROM posts
      WHERE fts_indexed = 1 AND id NOT IN (SELECT post_id FROM posts_fts)
    `);
  }
  // 過去の削除などで残っている孤立 FTS 行も掃除する
  conn.exec('DELETE FROM posts_fts WHERE post_id NOT IN (SELECT id FROM posts)');

  const ftsRowsAfter = Number((conn.prepare('SELECT COUNT(*) AS c FROM posts_fts').get() as any).c);
  return { toUnindex, toIndex, ftsRowsAfter };
}

/** 方針に反して保存されているリモートのブーストを削除する */
export function applyAnnouncePolicy(conn: DatabaseSync): { toRemove: number; remaining: number } {
  const policy = getRemoteAnnouncePolicy(conn);
  let toRemove = 0;
  if (policy === 'none') {
    toRemove = Number((conn.prepare('SELECT COUNT(*) AS c FROM announces WHERE is_local = 0').get() as any).c);
    if (toRemove > 0) conn.exec('DELETE FROM announces WHERE is_local = 0');
  } else if (policy === 'follows') {
    toRemove = Number(
      (
        conn
          .prepare(
            `SELECT COUNT(*) AS c FROM announces WHERE is_local = 0
               AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.following_url = announces.user_id AND f.status = 'accepted')`,
          )
          .get() as any
      ).c,
    );
    if (toRemove > 0) {
      conn.exec(`
        DELETE FROM announces WHERE is_local = 0
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.following_url = announces.user_id AND f.status = 'accepted')
      `);
    }
  }
  const remaining = Number((conn.prepare('SELECT COUNT(*) AS c FROM announces').get() as any).c);
  return { toRemove, remaining };
}
