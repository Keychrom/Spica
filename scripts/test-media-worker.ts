/**
 * メディア処理ワーカー（sharp / ffmpeg）の検査
 *
 * - ループバック HTTP の認証・画像変換・不正データの扱い
 * - クライアント経由の変換と、接続できないときのインライン・フォールバック
 *
 * ffmpeg が無い環境では動画サムネイルは null になる（それは正常）。
 */
import { startMediaWorkerServer } from '../server/src/mediaWorkerServer.js';
import { processImageBuffer, processVideoPoster } from '../server/src/mediaWorkerClient.js';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${name}: ${String(actual)}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: 期待値 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
  }
}

// 1x1 の PNG（sharp が読める最小の画像）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3fWQAAAABJRU5ErkJggg==',
  'base64',
);
const TOKEN = 'test-token';

const handle = await startMediaWorkerServer({ port: 0, host: '127.0.0.1', token: TOKEN });
const base = `http://127.0.0.1:${handle.port}`;
const post = (path: string, body: Buffer, headers: Record<string, string> = {}, token = TOKEN) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });

try {
  console.log('🧪 メディア処理ワーカー');
  const health = await fetch(`${base}/health`);
  const healthBody: any = await health.json().catch(() => null);
  check('health が応答する', health.status, 200);
  check('health が ok を返す', healthBody?.ok, true);
  check('ffmpeg の有無を返す', typeof healthBody?.ffmpeg, 'boolean');

  const noAuth = await post('/image', PNG, { 'x-mimetype': 'image/png' }, '');
  check('トークン無しは 401', noAuth.status, 401);

  const imageRes = await post('/image', PNG, { 'x-mimetype': 'image/png' });
  const imageData: any = await imageRes.json();
  check('画像が変換される', imageData?.converted, true);
  const webp = Buffer.from(String(imageData?.buffer || ''), 'base64');
  check('WebP のシグネチャ', webp.subarray(8, 12).toString('ascii'), 'WEBP');
  check('返した size が実体と一致', imageData?.size, webp.length);

  const badRes = await post('/image', Buffer.from('not an image'), { 'x-mimetype': 'image/png' });
  const badData: any = await badRes.json();
  check('変換できない画像は converted=false', badData?.converted, false);

  const target = { url: base, token: TOKEN, timeoutMs: 10_000 };
  const viaClient = await processImageBuffer(PNG, 'image/png', target);
  check('クライアント経由で変換できる', Boolean(viaClient?.buffer.length), true);
  check('クライアント経由でも WebP', viaClient?.buffer.subarray(8, 12).toString('ascii'), 'WEBP');

  const fallback = await processImageBuffer(PNG, 'image/png', {
    url: 'http://127.0.0.1:1',
    token: '',
    timeoutMs: 1_000,
  });
  check('接続できなければインラインで変換する', Boolean(fallback?.buffer.length), true);
  check('フォールバックも WebP', fallback?.buffer.subarray(8, 12).toString('ascii'), 'WEBP');

  const poster = await processVideoPoster(Buffer.from('not a video'), 'clip.mp4', target);
  check('壊れた動画はサムネイル無し（ffmpeg 任せ）', poster, null);

  const missing = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
  check('知らないパスは 404', missing.status, 404);
} finally {
  await handle.close();
}

console.log('');
console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
