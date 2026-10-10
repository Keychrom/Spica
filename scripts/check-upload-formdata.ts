/**
 * 添付アップロードの手動検査。
 * クライアントの api 部品をそのまま使い、FormData が multipart で送られるかを見る
 * （2026-10-10: JSON に変換されていて「メディアを選択してください」になっていた回帰の検査）。
 *
 *   # まず空きポートでサーバーを起こしておく（専用の DB を使う）
 *   cd server && PORT=3745 DB_PATH=$PWD/data_upload_check.sqlite DOMAIN=localhost:3745 \
 *     PROTOCOL=http INSTANCE_NAME=Upload RATE_LIMIT_DISABLED=true node dist/index.js &
 *   npx tsx scripts/check-upload-formdata.ts
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3745';

// Node の fetch は絶対 URL しか受けない。ブラウザの「同じ origin」を真似て前置する
const realFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) =>
  typeof input === 'string' && input.startsWith('/') ? realFetch(`${BASE}${input}`, init) : realFetch(input, init);

// トークンを api 部品に渡す（ブラウザの localStorage を真似る）
const tokenRes = await realFetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: `alice${Date.now().toString(36)}`, name: 'Alice', agreedToRules: true }),
});
const token = ((await tokenRes.json()) as { sessionToken?: string }).sessionToken || '';
(globalThis as any).localStorage = {
  getItem: () => token,
  setItem: () => {},
  removeItem: () => {},
};

const { api, messageOf } = await import('../client/src/lib/api.js');

// 1x1 の PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const form = new FormData();
form.append('file', new Blob([png], { type: 'image/png' }), 'test.png');

const res = await api.post('/api/media/upload', form);
console.log('status:', res.status);
if (!res.ok) {
  console.log('❌ 失敗:', messageOf(res.data, '(理由不明)'));
  process.exit(1);
}
const data = res.data as { attachment?: { url?: string }; media?: { url?: string }[] };
const url = data.attachment?.url || data.media?.[0]?.url || '';
console.log('url:', url ? url.slice(0, 80) : '(なし)');
console.log(url ? '✅ 添付を上げられた' : '❌ URL が返らない');
process.exit(url ? 0 : 1);
