/**
 * メディア処理（sharp / ffmpeg）の委譲。
 *
 * `MEDIA_WORKER_URL` が設定されていれば専用プロセスへ投げ、未設定ならこのプロセスで処理する。
 * **ワーカーに繋がらないときはインラインへフォールバック**するので、アップロードは止まらない
 * （そのときは従来どおり Web プロセスが CPU を使う）。
 */
import { config } from './config.js';
import { convertImageToWebp } from './imageProcessor.js';
import { generateVideoPoster, type VideoPoster } from './videoProcessor.js';

export interface MediaWorkerTarget {
  url: string;
  token: string;
  timeoutMs: number;
}

function configuredTarget(): MediaWorkerTarget | null {
  if (!config.mediaWorkerUrl) return null;
  return {
    url: config.mediaWorkerUrl,
    token: config.mediaWorkerToken,
    timeoutMs: config.mediaWorkerTimeoutMs,
  };
}

async function postToWorker(
  target: MediaWorkerTarget,
  path: string,
  buffer: Buffer,
  headers: Record<string, string>,
): Promise<any> {
  const res = await fetch(`${target.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
      ...headers,
    },
    body: buffer,
    signal: AbortSignal.timeout(target.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * 画像を WebP に変換する（変換しない形式・失敗時は null）。
 * `target` はテスト用の上書き。通常は設定から決まる。
 */
export async function processImageBuffer(
  buffer: Buffer,
  mimetype: string,
  targetOverride?: MediaWorkerTarget,
): Promise<{ buffer: Buffer; size: number } | null> {
  const target = targetOverride ?? configuredTarget();
  if (!target) return convertImageToWebp(buffer, mimetype);

  try {
    const data = await postToWorker(target, '/image', buffer, { 'x-mimetype': mimetype });
    if (!data?.converted) return null;
    const converted = Buffer.from(String(data.buffer || ''), 'base64');
    if (converted.length === 0) throw new Error('空の変換結果');
    return { buffer: converted, size: converted.length };
  } catch (err: any) {
    console.warn(
      '[MediaWorker] 画像処理をワーカーへ渡せなかったため、このプロセスで処理します:',
      err?.message || err,
    );
    return convertImageToWebp(buffer, mimetype);
  }
}

/**
 * 動画のサムネイルを生成する（ffmpeg が無い・失敗時は null）。
 * `target` はテスト用の上書き。通常は設定から決まる。
 */
export async function processVideoPoster(
  buffer: Buffer,
  originalname: string,
  targetOverride?: MediaWorkerTarget,
): Promise<VideoPoster | null> {
  const target = targetOverride ?? configuredTarget();
  if (!target) return generateVideoPoster({ buffer, originalname });

  try {
    const data = await postToWorker(target, '/video-poster', buffer, {
      'x-originalname': encodeURIComponent(originalname),
    });
    if (!data?.poster) return null;
    const poster = Buffer.from(String(data.poster.buffer || ''), 'base64');
    if (poster.length === 0) throw new Error('空のサムネイル');
    return {
      buffer: poster,
      mediaType: String(data.poster.mediaType || 'image/webp'),
      width: data.poster.width ?? null,
      height: data.poster.height ?? null,
      duration: data.poster.duration ?? null,
    };
  } catch (err: any) {
    console.warn(
      '[MediaWorker] 動画サムネイルをワーカーへ渡せなかったため、このプロセスで処理します:',
      err?.message || err,
    );
    return generateVideoPoster({ buffer, originalname });
  }
}
