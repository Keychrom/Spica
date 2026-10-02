import type { AsyncSpicaDatabase } from './db/asyncDriver.js';
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
 * 設定の読み出し。
 * 接続を渡すとその接続から読む（メンテナンス CLI 用。サーバーの共有接続を開かずに済ませるため）。
 * 渡さない場合はメモリのキャッシュ（起動時に loadServerSettings が読む）から同期で返す。
 */
export async function readSetting(conn: AsyncSpicaDatabase | undefined, key: string): Promise<string> {
  if (!conn) return getServerSetting(key as any, '') || '';
  try {
    const row = await conn.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value || '';
  } catch {
    return '';
  }
}

export async function getFtsIndexScope(conn?: AsyncSpicaDatabase): Promise<FtsIndexScope> {
  const stored = await readSetting(conn, 'fts_index_scope');
  if (stored) return normalizeScope(stored);
  return normalizeScope(process.env.FTS_INDEX_SCOPE || config.ftsIndexScope);
}

export async function setFtsIndexScope(scope: unknown): Promise<FtsIndexScope> {
  const value = normalizeScope(scope);
  await setServerSetting('fts_index_scope', value);
  return value;
}

export async function getRemoteAnnouncePolicy(conn?: AsyncSpicaDatabase): Promise<RemoteAnnouncePolicy> {
  const stored = await readSetting(conn, 'remote_announce_policy');
  if (stored) return normalizeAnnouncePolicy(stored);
  return normalizeAnnouncePolicy(process.env.REMOTE_ANNOUNCE_POLICY || config.remoteAnnouncePolicy);
}

export async function setRemoteAnnouncePolicy(policy: unknown): Promise<RemoteAnnouncePolicy> {
  const value = normalizeAnnouncePolicy(policy);
  await setServerSetting('remote_announce_policy', value);
  return value;
}

/** ローカルユーザーがそのアクターをフォローしているか */
export async function isFollowedByLocal(actorUrl: string | null | undefined): Promise<boolean> {
  if (!actorUrl) return false;
  try {
    const row = await db
      .prepare("SELECT 1 FROM follows WHERE following_url = ? AND status = 'accepted' LIMIT 1")
      .get(actorUrl);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** ローカル投稿への返信（または引用）か */
export async function isReplyToLocalPost(inReplyTo: string | null | undefined): Promise<boolean> {
  if (!inReplyTo) return false;
  try {
    const row = await db.prepare('SELECT 1 FROM posts WHERE id = ? AND is_local = 1').get(inReplyTo);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 受信したリモート投稿を FTS 索引に入れるか。
 * 挿入時に posts.fts_indexed へ保存し、トリガがそれを見て索引するかどうかを決める。
 */
export async function shouldIndexRemotePost(params: { authorUrl?: string | null; inReplyTo?: string | null }): Promise<boolean> {
  switch (await getFtsIndexScope()) {
    case 'all':
      return true;
    case 'follows':
      return (await isFollowedByLocal(params.authorUrl)) || (await isReplyToLocalPost(params.inReplyTo));
    case 'local':
    default:
      return false;
  }
}

/** 受信したリモートのブースト（Announce）を保存するか */
export async function shouldStoreRemoteAnnounce(actorUrl: string | null | undefined): Promise<boolean> {
  switch (await getRemoteAnnouncePolicy()) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'follows':
    default:
      return await isFollowedByLocal(actorUrl);
  }
}

export interface FtsPolicyResult {
  /** 索引すべきでないのに索引に残っている投稿 */
  toUnindex: number;
  /** 索引すべきなのに索引に入っていない投稿 */
  toIndex: number;
  /** 方針適用後に残る索引行数 */
  ftsRowsAfter: number;
  /** 方針が前回と同じで何もしなかったか */
  skipped?: boolean;
}

/**
 * 方針を既存データへ遡及適用する（db:maintenance と自動メンテナンスから呼ぶ）。
 *
 * **毎晩そのまま流してはいけない**（2026-10-02 に直した）。以前は
 * `UPDATE posts SET fts_indexed = CASE … END` を **WHERE 無し**で流していたため、
 * 変わらない行でも 1 行ごとに `posts_au` トリガが発火し、その中の
 * `DELETE FROM posts_fts WHERE post_id = old.id` が（FTS5 の `post_id` は UNINDEXED なので）
 * **1 行ごとに FTS 全体を走査**していました（O(n²)。リレーで投稿が溜まったノードでは事実上終わらない）。
 *
 * いまは 2 段構え:
 *   1. **方針が前回と同じなら何もしない**（`fts_policy_applied` に適用済みの値を記録する）
 *   2. 変わったときは `WHERE fts_indexed <> …` で**変わる行だけ**を更新し、
 *      SQLite では FTS の同期トリガを外してから集合演算で索引を直す（削除パスと同じ形）
 *
 * `force: true` で 1 を飛ばせます（手動メンテナンスの「いま適用する」用）。
 */
export async function applyFtsPolicy(
  conn: AsyncSpicaDatabase,
  opts: { force?: boolean } = {},
): Promise<FtsPolicyResult> {
  const scope = await getFtsIndexScope(conn);
  const signature = `${scope}|${conn.kind}`;
  const applied = getServerSetting('fts_policy_applied');
  if (!opts.force && applied === signature) {
    const ftsRows = Number((await conn.prepare('SELECT COUNT(*) AS c FROM posts_fts').get() as any).c);
    return { toUnindex: 0, toIndex: 0, ftsRowsAfter: ftsRows, skipped: true };
  }

  const keepCondition = `
    is_local = 1 OR (
      '${scope}' = 'all' OR (
        '${scope}' = 'follows' AND (
          EXISTS (SELECT 1 FROM follows f WHERE f.following_url = posts.author_url AND f.status = 'accepted')
          OR EXISTS (SELECT 1 FROM posts lp WHERE lp.is_local = 1 AND lp.id = posts.in_reply_to)
        )
      )
    )`;
  const wanted = `CASE WHEN ${keepCondition} THEN 1 ELSE 0 END`;

  // SQLite は FTS の同期トリガが post_id を全走査するので、まとめて更新する間だけ外す
  // （PostgreSQL は posts_fts.post_id が主キーで索引が効くので、そのままトリガに任せる）
  const triggerSql =
    conn.kind === 'postgres'
      ? undefined
      : ((await conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_au'").get() as any)?.sql as
          | string
          | undefined);

  if (triggerSql) await conn.exec('DROP TRIGGER IF EXISTS posts_au');
  try {
    // **変わる行だけ**を更新する（変わらない行でトリガを起こさない）
    await conn.exec(`UPDATE posts SET fts_indexed = ${wanted} WHERE fts_indexed <> (${wanted})`);
  } finally {
    if (triggerSql) {
      await conn.exec('DROP TRIGGER IF EXISTS posts_au');
      await conn.exec(triggerSql);
    }
  }

  const toUnindex = Number(
    (await conn.prepare(`SELECT COUNT(*) AS c FROM posts WHERE fts_indexed = 0 AND id IN (SELECT post_id FROM posts_fts)`).get() as any).c,
  );
  const toIndex = Number(
    (await conn.prepare(`SELECT COUNT(*) AS c FROM posts WHERE fts_indexed = 1 AND id NOT IN (SELECT post_id FROM posts_fts)`).get() as any).c,
  );

  if (toUnindex > 0) {
    await conn.exec('DELETE FROM posts_fts WHERE post_id IN (SELECT id FROM posts WHERE fts_indexed = 0)');
  }
  if (toIndex > 0) {
    await conn.exec(`
      INSERT INTO posts_fts(post_id, content)
      SELECT id, content FROM posts
      WHERE fts_indexed = 1 AND id NOT IN (SELECT post_id FROM posts_fts)
    `);
  }
  // 過去の削除などで残っている孤立 FTS 行も掃除する
  await conn.exec('DELETE FROM posts_fts WHERE post_id NOT IN (SELECT id FROM posts)');

  const ftsRowsAfter = Number((await conn.prepare('SELECT COUNT(*) AS c FROM posts_fts').get() as any).c);
  // 適用済みを記録する（次回以降は方針が変わるまで何もしない）
  await setServerSetting('fts_policy_applied', signature).catch(() => undefined);
  return { toUnindex, toIndex, ftsRowsAfter, skipped: false };
}

/** 方針に反して保存されているリモートのブーストを削除する */
export async function applyAnnouncePolicy(conn: AsyncSpicaDatabase): Promise<{ toRemove: number; remaining: number }> {
  const policy = await getRemoteAnnouncePolicy(conn);
  let toRemove = 0;
  if (policy === 'none') {
    toRemove = Number((await conn.prepare('SELECT COUNT(*) AS c FROM announces WHERE is_local = 0').get() as any).c);
    if (toRemove > 0) await conn.exec('DELETE FROM announces WHERE is_local = 0');
  } else if (policy === 'follows') {
    toRemove = Number(
      (
        await conn
          .prepare(
            `SELECT COUNT(*) AS c FROM announces WHERE is_local = 0
               AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.following_url = announces.user_id AND f.status = 'accepted')`,
          )
          .get() as any
      ).c,
    );
    if (toRemove > 0) {
      await conn.exec(`
        DELETE FROM announces WHERE is_local = 0
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.following_url = announces.user_id AND f.status = 'accepted')
      `);
    }
  }
  const remaining = Number((await conn.prepare('SELECT COUNT(*) AS c FROM announces').get() as any).c);
  return { toRemove, remaining };
}
