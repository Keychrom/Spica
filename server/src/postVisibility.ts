import { db } from './db.js';

/**
 * 投稿の公開範囲
 *   public    : 連合を含めて公開
 *   local     : 自ノード内のみ（連合配信しない）
 *   followers : フォロワー限定（承認済みフォロワーのみ閲覧・配信）
 *   direct    : DM（1対1のメッセージ）。`posts.recipients` の宛先と送信者だけが閲覧できる
 *
 * ※ DM はサーバー管理者の設定 `dm_enabled` が on のときだけ使う（docs/DM.md）。
 *    専用テーブルは作らず、`visibility = 'direct'` の投稿として保存する。
 *    タイムライン・検索・RSS・sitemap・OGP・エクスポートには**絶対に出さない**
 *    （各所の除外条件に `visibility != 'direct'` を足してある）。
 */
export type PostVisibility = 'public' | 'local' | 'followers' | 'direct';

export function normalizeVisibility(raw: unknown): PostVisibility {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'direct' || value === 'specified') {
    return 'direct';
  }
  if (value === 'followers' || value === 'private') {
    return 'followers';
  }
  if (value === 'local' || value === 'home' || value === 'unlisted') {
    return 'local';
  }
  return 'public';
}

/**
 * `posts.recipients`（JSON 配列）を安全に読む。
 * 壊れた JSON・配列でない値は空配列として扱う（例外は投げない）。
 */
export function parseRecipients(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

/** 比較用に actor URL の末尾スラッシュを落とす */
function trimActorUrl(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * viewer が「direct 投稿」の当事者（送信者 or 宛先）か。
 * 宛先でない第三者には本文も存在も見せない。
 */
export function isViewerAddressedByDirectPost(post: PostVisibilityFields, viewerActorUrl: string | null): boolean {
  const viewer = trimActorUrl(viewerActorUrl);
  if (!viewer) return false;
  if (trimActorUrl(post.author_url) === viewer) return true;
  return parseRecipients((post as PostVisibilityFields).recipients).some((recipient) => trimActorUrl(recipient) === viewer);
}

interface PostVisibilityFields {
  visibility?: string | null;
  author_url?: string | null;
  recipients?: string | null;
}

/**
 * viewer が author の承認済みフォロワーか（または本人か）
 */
export async function isViewerAuthorizedForAuthor(authorActorUrl: string | null, viewerActorUrl: string | null): Promise<boolean> {
  if (!authorActorUrl) {
    return true;
  }
  if (!viewerActorUrl) {
    return false;
  }
  if (authorActorUrl === viewerActorUrl) {
    return true;
  }
  try {
    const row = await db
      .prepare("SELECT 1 FROM follows WHERE follower_url = ? AND following_url = ? AND status = 'accepted'")
      .get(viewerActorUrl, authorActorUrl);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 単一の投稿を viewer が閲覧できるか。
 * 'followers' は承認済みフォロワーのみ、'direct' は送信者と宛先だけに許可する。
 * 'public' / 'local' は従来どおり許可する。
 */
export async function canViewPost(post: PostVisibilityFields, viewerActorUrl: string | null): Promise<boolean> {
  const visibility = normalizeVisibility(post.visibility);
  if (visibility === 'direct') {
    return isViewerAddressedByDirectPost(post, viewerActorUrl);
  }
  if (visibility !== 'followers') {
    return true;
  }
  return await isViewerAuthorizedForAuthor(post.author_url ?? null, viewerActorUrl);
}

/**
 * 一覧から閲覧できない投稿を除外する。
 * フォロー関係は「対象となる投稿の著者」をまとめて1クエリで解決するため、
 * 行数が多くてもクエリは1回で済む。
 *
 * 'direct' はフォロー関係では決まらないので、ここで宛先（recipients）を見て落とす。
 */
export async function filterVisiblePosts<T extends PostVisibilityFields>(rows: T[], viewerActorUrl: string | null): Promise<T[]> {
  const restrictedAuthors = new Set<string>();
  const directRows = new Set<T>();
  for (const row of rows) {
    const visibility = normalizeVisibility(row.visibility);
    if (visibility === 'direct') {
      // 宛先でなければ本文も存在も見せない
      if (!isViewerAddressedByDirectPost(row, viewerActorUrl)) directRows.add(row);
      continue;
    }
    if (visibility === 'followers' && row.author_url) {
      restrictedAuthors.add(row.author_url);
    }
  }
  if (restrictedAuthors.size === 0 && directRows.size === 0) {
    return rows;
  }

  const allowedAuthors = new Set<string>();
  if (viewerActorUrl && restrictedAuthors.size > 0) {
    const authors = [...restrictedAuthors];
    const placeholders = authors.map(() => '?').join(',');
    try {
      const followed = await db
        .prepare(
          `SELECT following_url FROM follows
           WHERE follower_url = ? AND status = 'accepted' AND following_url IN (${placeholders})`,
        )
        .all(viewerActorUrl, ...authors) as { following_url: string }[];
      for (const row of followed) {
        allowedAuthors.add(row.following_url);
      }
    } catch {
      // 取得に失敗した場合は制限側に倒す（見せてはいけないものを出さない）
    }
  }

  return rows.filter((row) => {
    if (directRows.has(row)) {
      return false;
    }
    if (normalizeVisibility(row.visibility) !== 'followers') {
      return true;
    }
    if (!row.author_url) {
      return true;
    }
    return row.author_url === viewerActorUrl || allowedAuthors.has(row.author_url);
  });
}

/**
 * リアルタイム配信（SSE）して良い投稿か。
 * 公開範囲が 'public' 以外の投稿は全クライアントへ配信しない（存在自体が漏れるため）。
 */
export async function isPublicPost(postId: string): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT visibility FROM posts WHERE id = ?').get(postId) as
      | { visibility?: string | null }
      | undefined;
    if (!row) {
      return true;
    }
    return normalizeVisibility(row.visibility) === 'public';
  } catch {
    return false;
  }
}
