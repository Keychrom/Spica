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
  /** 未処理の例外・拒否でも同じ後始末をするか（既定 true。テストでは false にして観測する） */
  handleUnhandled?: boolean;
}

/**
 * シャットダウン処理を組み立てる（実行はしない）。
 * テストから直接呼べるようにハンドラを返す形にしている。
 *
 * `reason` はログ用の名前、`exitCode` は終了コード（クラッシュ由来なら 1）。
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (reason: string, exitCode?: number) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const forceExitMs = deps.forceExitMs ?? 10000;
  let isShuttingDown = false;

  return function gracefulShutdown(reason: string, exitCode = 0): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Shutdown] ${reason} を受信しました。安全に終了します...`);

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
        exit(exitCode);
      });
  };
}

/**
 * プロセスのシグナルと、未処理の例外・拒否に登録する（本番の起動処理から呼ぶ）。
 *
 * 未処理の拒否を拾う理由: Node の既定はどちらも即プロセス終了で、後始末（予約投稿の
 * ロック解放・WAL チェックポイント・SSE のクローズ）が走らない。拾って**同じ後始末を
 * してから**非ゼロで終われば、systemd の再起動と合わせて復帰が早く、原因もログに残る。
 * （ルートハンドラ側は asyncHandler / try で塞いであるので、ここは最後の網）
 */
export function registerGracefulShutdown(deps: GracefulShutdownDeps): void {
  const handler = createGracefulShutdown(deps);
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));

  if (deps.handleUnhandled === false) return;

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[Fatal] 未処理の Promise 拒否:', err?.stack || err);
    handler('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err: Error) => {
    console.error('[Fatal] 未捕捉の例外:', err?.stack || err);
    handler('uncaughtException', 1);
  });
}
