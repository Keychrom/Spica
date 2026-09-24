import type { Server } from 'node:http';
import { db } from './db.js';
import { stopScheduler } from './scheduler.js';
import { closeAllStreams } from './streaming.js';
import { closeRedis } from './redis.js';

/**
 * グレースフルシャットダウン
 *
 *   SIGTERM / SIGINT を受けたら、新規受付を止め、SSE を閉じ、
 *   WAL をチェックポイントしてから終了する（次回起動を綺麗にする）。
 *
 * ※ シグナルの配送は POSIX（Linux / macOS）環境でのみ有効。
 *   Windows では Node がシグナルを配送できず強制終了になるが、
 *   SQLite は WAL なのでデータは壊れない（チェックポイントは次回起動時に行われる）。
 */

export interface GracefulShutdownDeps {
  /** HTTP サーバー（close / closeAllConnections を使う） */
  server: Pick<Server, 'close' | 'closeAllConnections'> | { close: () => void; closeAllConnections?: () => void };
  /** 終了コードを受け取るフック（既定は process.exit） */
  exit?: (code: number) => void;
  /** 強制終了までの猶予（ミリ秒・既定 10000） */
  forceExitMs?: number;
}

/**
 * シャットダウン処理を組み立てる（実行はしない）。
 * テストから直接呼べるようにハンドラを返す形にしている。
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const forceExitMs = deps.forceExitMs ?? 10000;
  let isShuttingDown = false;

  return function gracefulShutdown(signal: string): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Shutdown] ${signal} を受信しました。安全に終了します...`);

    const forceExit = setTimeout(() => {
      console.warn('[Shutdown] ⚠️ 時間内に終了できなかったため強制終了します');
      exit(1);
    }, forceExitMs);
    forceExit.unref?.();

    try {
      stopScheduler();
    } catch (err: any) {
      console.warn('[Shutdown] スケジューラの停止に失敗:', err?.message || err);
    }
    try {
      closeAllStreams();
    } catch (err: any) {
      console.warn('[Shutdown] SSE 接続のクローズに失敗:', err?.message || err);
    }

    // 新規受付を止め、開いている接続（SSE 等）は待たずに閉じる
    try {
      deps.server.close();
    } catch (err: any) {
      console.warn('[Shutdown] サーバーの停止に失敗:', err?.message || err);
    }
    try {
      deps.server.closeAllConnections?.();
    } catch {
      // 未対応の場合は無視
    }

    // DB の後始末。WAL をチェックポイントしてから接続を閉じる
    // （PostgreSQL では checkpoint は何もしない）。終了の完了は待つが、
    // 待ち続けて終われない場合に備えて上の forceExit が上限として働く。
    // Redis を使っていれば、購読を止めてから DB を閉じる。
    void closeRedis()
      .catch(() => {})
      .then(() => db.checkpoint())
      .catch(() => {})
      .then(() => db.close())
      .catch(() => {})
      .finally(() => {
        console.log('[Shutdown] ✅ 終了しました');
        exit(0);
      });
  };
}

/** プロセスのシグナルに登録する（本番の起動処理から呼ぶ） */
export function registerGracefulShutdown(deps: GracefulShutdownDeps): void {
  const handler = createGracefulShutdown(deps);
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
