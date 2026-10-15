/**
 * いま画面に出ているタイムラインを、サーバーへの申告（SSE の `streams`）に変換する。
 *
 * これがある理由: 申告しないとサーバーは「全部」とみなして連合の新着を全部送ってくる。
 * **表示していないタイムラインの新着で通知音が鳴る**（ホームを開いていても連合の受信で鳴る）し、
 * 読み直しも無駄に走る。表示中のタブに合わせて申告し直す。
 *
 * ⚠️ `none` はサーバー側（`server/src/streamRouting.ts` の `NO_STREAMS`）と同じ文字列。
 *    文字列を変えるときは両方直すこと（検査 `check:client-render` が突き合わせている）。
 */
import { decodePart, queryValue } from './router';

/** 新着を 1 件も受け取らない申告（タイムラインを出していない画面） */
export const NO_STREAMS = 'none';

/**
 * 画面の URL からストリームの申告を作る。
 * ・`/?mode=home|local|all` … そのタブ（`?mode=` が無ければ設定の既定タブ）
 * ・`/tags/<タグ>` … そのタグ
 * ・`/channels/<ID>` … そのチャンネル
 * ・`/?post=<ID>`（1 つのノートを開いている）やそれ以外の画面 … `none`
 */
export function streamsFor(path: string, defaultTimeline?: unknown): string[] {
  const pathOnly = path.split(/[?#]/)[0];
  if (pathOnly === '/') {
    // ノートを 1 つ開いているときはタイムラインではない
    if (queryValue(path, 'post')) return [NO_STREAMS];
    const mode = queryValue(path, 'mode') ?? (typeof defaultTimeline === 'string' ? defaultTimeline : 'home');
    return [mode === 'local' || mode === 'all' ? mode : 'home'];
  }
  if (pathOnly.startsWith('/tags/')) {
    const tag = decodePart(pathOnly.slice('/tags/'.length));
    return tag ? [`tag:${tag.toLowerCase()}`] : [NO_STREAMS];
  }
  if (pathOnly.startsWith('/channels/')) {
    const id = decodePart(pathOnly.slice('/channels/'.length));
    return id ? [`channel:${id}`] : [NO_STREAMS];
  }
  return [NO_STREAMS];
}

/** 申告を URL のクエリにする（未申告は「全部」とみなされるので、必ず何か入れる） */
export function streamQuery(streams: string[]): string {
  const list = streams.filter(Boolean);
  return list.length > 0 ? list.join(',') : NO_STREAMS;
}
