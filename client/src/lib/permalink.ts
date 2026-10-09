/**
 * 投稿の行き先（パス）と共有 URL（サーバーの決め方に合わせる）。
 *
 * - ローカル投稿の正規 ID は `${origin}/users/<user>/posts/<id>`。**この正規 ID がそのまま共有 URL**で、
 *   サーバーはこのパスに OGP 付きの HTML を返す。
 * - リモート投稿の正規 ID は他サーバーを指すので、このインスタンスの `/?post=<正規 ID>` を使う
 *   （サーバー側の `postPermalink` と同じ規則）。
 *
 * ⚠️ 正規 ID 自体が URL なので、`/users/<user>/posts/<正規 ID>` のように**二重に URL を組まない**。
 *    開いても辿り着けず、クローラにもカードが出ない（旧フロントエンドで踏んだ）。
 */

/** ローカル投稿の正規 ID からパス部分（`/users/<user>/posts/<id>`）を取り出す。他は null */
export function localPostPath(canonicalId: string): string | null {
  const origin = window.location.origin;
  if (!canonicalId.startsWith(`${origin}/users/`)) return null;
  return canonicalId.slice(origin.length);
}

/** アプリ内の行き先（`<a href>` と navigate 用。必ず `/` で始まる） */
export function postPath(post: { id?: string }): string {
  const id = post?.id || '';
  const local = localPostPath(id);
  if (local) return local;
  return `/?post=${encodeURIComponent(id)}`;
}

/** 共有 URL（絶対 URL。ローカルはサーバーが OGP を返す正規 URL、リモートは `/?post=`） */
export function postPermalink(post: { id?: string }): string {
  return `${window.location.origin}${postPath(post)}`;
}

/** `/users/<user>/posts/<id>` のパスから正規 ID を組み立てる（パーマリンクを開いたとき用） */
export function canonicalPostIdFromPath(user: string, postPathId: string): string {
  return `${window.location.origin}/users/${user}/posts/${postPathId}`;
}
