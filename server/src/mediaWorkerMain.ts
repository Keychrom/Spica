/**
 * メディア処理専用プロセスの起動入口。
 *
 *   MEDIA_WORKER_PORT=3101 node dist/mediaWorkerMain.js
 *
 * Web 側は `MEDIA_WORKER_URL=http://127.0.0.1:3101` を設定する。
 * DB / Redis / Express は初期化しない（画像と動画の変換だけを行う）。
 */
import { startMediaWorkerServer } from './mediaWorkerServer.js';
import { isFfmpegAvailable } from './videoProcessor.js';

const port = parseInt(process.env.MEDIA_WORKER_PORT || '3101', 10);
const host = process.env.MEDIA_WORKER_HOST || '127.0.0.1';
const token = (process.env.MEDIA_WORKER_TOKEN || '').trim();
const maxBytes = (() => {
  const parsed = parseInt(process.env.MEDIA_WORKER_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

if (!Number.isFinite(port) || port <= 0) {
  console.error('[MediaWorker] MEDIA_WORKER_PORT が不正です:', process.env.MEDIA_WORKER_PORT);
  process.exit(1);
}

const handle = await startMediaWorkerServer({ port, host, token, maxBytes });
const ffmpeg = await isFfmpegAvailable();
console.log(`[MediaWorker] listening on http://${host}:${handle.port} (ffmpeg: ${ffmpeg ? 'yes' : 'no'})`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[MediaWorker] ${signal} を受けたので停止します`);
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
