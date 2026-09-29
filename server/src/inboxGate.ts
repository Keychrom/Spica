import { config } from './config.js';

/**
 * Inbox の受け入れ制御（同時に処理する件数と、待たせる件数の上限）。
 *
 * ## なぜ要るか
 *
 * 受信の処理（署名検証・アクター取得・DB と FTS への書き込み・アンテナの照合・配信）は
 * **リクエストの中で**終わる。リレーから投稿がまとめて流れてくると、同じ数の処理が
 * 同時に走り、CPU・メモリ・DB の書き込みを奪い合って**画面の応答まで遅くなる**。
 *
 * ここでは「同時に処理する数」と「順番待ちに並べる数」を区切る:
 *   - 空きがあれば通す
 *   - 混んでいれば**少しだけ待たせる**（`waitMs` まで）
 *   - それでも空かなければ **503 を返す**
 *
 * `waitMs = 0` は「待たない」の意味（列に並べると、空きが出るまで永久に返らない
 * リクエストが生まれるため。0 のときは即 503）。
 *
 * 503 は連合の送信側が指数バックオフで送り直すので、取りこぼしにはならない
 * （Mastodon / Misskey も混雑時は 503 を返す）。
 *
 * ※ 受信を丸ごと非同期（ジョブ）にする案は別途。順序（Create と Delete など）の
 *    入れ替わりを招くので、まずここで**溢れさせない**ようにしている。
 */

export interface InboxGateOptions {
  /** 同時に処理する数 */
  max: number;
  /** 順番待ちに並べる数（これを超えたら即 503） */
  queueMax: number;
  /** 待たせる上限（ミリ秒。過ぎたら 503） */
  waitMs: number;
}

export interface InboxGate {
  /**
   * 処理の順番を取る。取れたら `release` を必ず呼ぶこと。
   * 取れなければ null（呼び出し側は 503 を返す）。
   */
  acquire(): Promise<(() => void) | null>;
  stats(): { active: number; waiting: number; shed: number };
}

export function createInboxGate(options: InboxGateOptions): InboxGate {
  const max = Math.max(1, Math.floor(options.max));
  const queueMax = Math.max(0, Math.floor(options.queueMax));
  const waitMs = Math.max(0, Math.floor(options.waitMs));

  let active = 0;
  let shed = 0;
  /** 順番待ち（先に入ったものから通す） */
  const waiting: { resolve: (release: (() => void) | null) => void; timer?: NodeJS.Timeout }[] = [];

  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      // 待っている人がいれば、1 つ通す
      const next = waiting.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        active++;
        next.resolve(makeRelease());
      }
    };
  }

  return {
    async acquire(): Promise<(() => void) | null> {
      if (active < max) {
        active++;
        return makeRelease();
      }
      // waitMs = 0 は「待たない」。並べても起こす仕組みが無いので、そのまま 503 にする
      if (waitMs <= 0) {
        shed++;
        return null;
      }
      // 混んでいる: 順番待ちに並ぶ（いっぱいなら溢れさせる）
      if (waiting.length >= queueMax) {
        shed++;
        return null;
      }
      return new Promise<(() => void) | null>((resolve) => {
        const entry: { resolve: (release: (() => void) | null) => void; timer?: NodeJS.Timeout } = {
          resolve: (release) => {
            entry.timer = undefined;
            resolve(release);
          },
        };
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          shed++;
          resolve(null);
        }, waitMs);
        entry.timer.unref?.();
        waiting.push(entry);
      });
    },
    stats: () => ({ active, waiting: waiting.length, shed }),
  };
}

/** アプリで使う既定のゲート（設定値で作る） */
export const inboxGate: InboxGate = createInboxGate({
  max: config.inboxConcurrency,
  queueMax: config.inboxQueueMax,
  waitMs: config.inboxQueueWaitMs,
});
