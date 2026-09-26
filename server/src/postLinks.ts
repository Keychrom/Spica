import { config } from './config.js';

/**
 * 投稿の「人間が開く URL」。
 *
 * ローカル投稿の正規 URL は `${origin}/users/<user>/posts/<id>` で、これは
 * ActivityPub の解決用 URL でありながら HTML（OGP 付き）も返せる。つまり
 * **ローカル投稿は正規 URL をそのまま共有 URL に使える**。
 *
 * リモート投稿の正規 URL は他サーバーを指すので、このインスタンスの
 * `/?post=<正規 ID>` を使う（サーバー側で OGP を差し込む対象）。
 */
export function postPermalink(postId: string): string {
  const localPrefix = `${config.origin}/users/`;
  if (postId.startsWith(localPrefix)) {
    return postId;
  }
  return `${config.origin}/?post=${encodeURIComponent(postId)}`;
}

/** `/users/<user>/posts/<id>` のパスから正規 ID を組み立てる */
export function canonicalPostId(username: string, postPathId: string): string {
  return `${config.origin}/users/${username}/posts/${postPathId}`;
}
