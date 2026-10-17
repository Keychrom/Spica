/**
 * メディア処理専用ワーカー（sharp / ffmpeg）の HTTP サーバー。
 *
 * Web プロセスから `MEDIA_WORKER_URL` で呼ばれ、画像の WebP 変換・EXIF 除去と
 * 動画サムネイル生成だけを行う。**公開ポートは開かない**（既定は 127.0.0.1）。
 * `PROCESS_ROLE` とは独立した入口（`mediaWorkerMain.ts`）で起動する。
 */
import http from 'node:http';
import { convertImageToWebp } from './imageProcessor.js';
import { generateVideoPoster, isFfmpegAvailable } from './videoProcessor.js';

export interface MediaWorkerOptions {
  port: number;
  host?: string;
  /** 設定したときだけ Authorization: Bearer を要求する */
  token?: string;
  /** リクエスト本文の上限（バイト）。既定 64MB */
  maxBytes?: number;
}

export interface MediaWorkerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const error: any = new Error('リクエストが大きすぎます。');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

/**
 * ワーカーを起動する。`port: 0` で空きポートを取り、実際のポートを返す（テスト用）。
 */
export async function startMediaWorkerServer(options: MediaWorkerOptions): Promise<MediaWorkerHandle> {
  const token = (options.token || '').trim();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, ffmpeg: await isFfmpegAvailable() });
      }
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'POST' && url.pathname === '/image') {
        const mimetype = String(req.headers['x-mimetype'] || '');
        const buffer = await readBody(req, maxBytes);
        const converted = await convertImageToWebp(buffer, mimetype);
        if (!converted) return sendJson(res, 200, { converted: false });
        return sendJson(res, 200, {
          converted: true,
          mediaType: 'image/webp',
          size: converted.size,
          buffer: converted.buffer.toString('base64'),
        });
      }

      if (req.method === 'POST' && url.pathname === '/video-poster') {
        let originalname = 'video';
        try {
          originalname = decodeURIComponent(String(req.headers['x-originalname'] || 'video')) || 'video';
        } catch {
          originalname = 'video';
        }
        const buffer = await readBody(req, maxBytes);
        const poster = await generateVideoPoster({ buffer, originalname });
        return sendJson(res, 200, {
          poster: poster
            ? {
                buffer: poster.buffer.toString('base64'),
                mediaType: poster.mediaType,
                width: poster.width,
                height: poster.height,
                duration: poster.duration,
              }
            : null,
        });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err: any) {
      const status = Number(err?.statusCode) || 500;
      if (!res.headersSent) {
        sendJson(res, status, { error: err?.message || 'media worker error' });
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host || '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
