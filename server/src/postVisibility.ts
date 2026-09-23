import { adb, db } from './db.js';

/**
 * 投稿の公開範囲
 *   public    : 連合を含めて公開
 *   local     : 自ノード内のみ（連合配信しない）
 *   followers : フォロワー限定（承認済みフォロワーのみ閲覧・配信）
 *
 * ※ ダイレクトメッセージ（DM / specified）は方針として実装しない。
 *    1対1のメッセージ機能を提供すると、ノード運営が「他人の通信を媒介する事業」と
 *    評価されうるため、運営者に電気通信事業法上の義務（届出・通信の秘密の保持・
 *    秘密の漏洩防止）が及ぶおそれがある。
 *    'followers' はフォロワー全員が対象で、DM の代用にはならない。
 */
export type PostVisibility = 'public' | 'local' | 'followers';

export function normalizeVisibility(raw: unknown): PostVisibility {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'followers' || value === 'private') {
    return 'followers';
  }
  if (value === 'local' || value === 'home' || value === 'unlisted') {
    return 'local';
  }
  return 'public';
}

interface PostVisibilityFields {
  visibility?: string | null;
  author_url?: string | null;
}

/**
 * viewer が author の承認済みフォロワーか（または本人か）
 */
export function isViewerAuthorizedForAuthor(authorActorUrl: string | null, viewerActorUrl: string | null): boolean {
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
    const row = db
      .prepare("SELECT 1 FROM follows WHERE follower_url = ? AND following_url = ? AND status = 'accepted'")
      .get(viewerActorUrl, authorActorUrl);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 単一の投稿を viewer が閲覧できるか。
 * 'followers' のみ制限し、'public' / 'local' は従来どおり許可する。
 */
export function canViewPost(post: PostVisibilityFields, viewerActorUrl: string | null): boolean {
  if (normalizeVisibility(post.visibility) !== 'followers') {
    return true;
  }
  return isViewerAuthorizedForAuthor(post.author_url ?? null, viewerActorUrl);
}

/**
 * 一覧から閲覧できない投稿を除外する。
 * フォロー関係は「対象となる投稿の著者」をまとめて1クエリで解決するため、
 * 行数が多くてもクエリは1回で済む。
 */
export function filterVisiblePosts<T extends PostVisibilityFields>(rows: T[], viewerActorUrl: string | null): T[] {
  const restrictedAuthors = new Set<string>();
  for (const row of rows) {
    if (normalizeVisibility(row.visibility) === 'followers' && row.author_url) {
      restrictedAuthors.add(row.author_url);
    }
  }
  if (restrictedAuthors.size === 0) {
    return rows;
  }

  const allowedAuthors = new Set<string>();
  if (viewerActorUrl) {
    const authors = [...restrictedAuthors];
    const placeholders = authors.map(() => '?').join(',');
    try {
      const followed = db
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
    const row = await adb.prepare('SELECT visibility FROM posts WHERE id = ?').get(postId) as
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
