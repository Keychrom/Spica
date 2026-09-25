import crypto from 'node:crypto';

/**
 * 連合に公開する ID（URI）の生成。
 *
 * 以前は投稿 ID を `${actorUrl}/posts/${Date.now()}`（ミリ秒）で作っていたため、
 * **同じミリ秒に 2 件作ると主キーがぶつかって 400 になる**。負荷試験で毎秒 733 投稿のとき
 * 1.5% が `UNIQUE constraint failed: posts.id` で失敗した。人が使う分にはまず起きないが、
 * 連合の受信が burst したときは同じ経路を通る。
 *
 * 通知（`notif_...`）やメディア（`media_...`）の ID は最初から
 * `Date.now()` + ランダム 4 バイトだったので、同じ形に揃える。
 * ミリ秒を残しておくのは、ログや保存順を見たときに前後関係が分かるため。
 */
function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** ローカル投稿の ID（＝連合で公開する URI） */
export function localPostId(actorUrl: string): string {
  return `${actorUrl}/posts/${uniqueSuffix()}`;
}

/**
 * リモートの活動に `id` が無いときのフォールバック。
 * 例: `fallbackActivityId(actorUrl, 'reactions')`
 */
export function fallbackActivityId(baseUrl: string, kind: string): string {
  return `${baseUrl}/${kind}/${uniqueSuffix()}`;
}
