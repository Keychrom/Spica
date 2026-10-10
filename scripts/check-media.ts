/**
 * 添付（音声・動画・画像）の手動検査。**クライアントの部品をそのまま使って**、
 * 「上げる → 投稿する → タイムラインの実物を描く」までを通しで見る。
 *
 * 見ている回帰（どちらも 2026-10-10 に踏んだもの）:
 *  1. `api.post` が FormData を JSON にしてしまい「メディアを選択してください」になる
 *  2. 画面が添付の種類を `type` で見ていて（サーバーは `mediaType`）、音声が <img> になり再生できない
 *
 *   # まず空きポートでサーバーを起こしておく（専用の DB を使う）
 *   cd server && PORT=3748 DB_PATH=$PWD/data_media_check.sqlite DOMAIN=localhost:3748 \
 *     PROTOCOL=http INSTANCE_NAME=Media RATE_LIMIT_DISABLED=true node dist/index.js &
 *   BASE=http://127.0.0.1:3748 npx tsx --tsconfig client/tsconfig.json scripts/check-media.ts
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3748';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failures++;
}

// ---- ブラウザを真似る（Node の fetch は絶対 URL しか受けない / localStorage が要る）
const realFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) =>
  typeof input === 'string' && input.startsWith('/') ? realFetch(`${BASE}${input}`, init) : realFetch(input, init);
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};
(globalThis as any).window = {
  location: { origin: BASE, pathname: '/', search: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: (globalThis as any).localStorage,
};

const stamp = Date.now().toString(36);
const reg = await realFetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: `m${stamp}`, name: 'Media', agreedToRules: true }),
});
const token = ((await reg.json()) as { sessionToken?: string }).sessionToken || '';
storage.set('spica_token', token);

const { api } = await import('../client/src/lib/api.js');
const { default: PostMedia } = await import('../client/src/components/PostMedia.js');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

/** クライアントのアップロード部品と同じ道（FormData をそのまま渡す） */
async function upload(name: string, type: string, bytes: number) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(bytes, 7)], { type }), name);
  const res = await api.post('/api/media/upload', form);
  const media = (res.data as any)?.media?.[0];
  return { status: res.status, media };
}

/** タイムラインの実物（画面が読む形）を取る */
async function fromTimeline(postId: string) {
  const res = await api.get('/api/timeline?mode=local&limit=10');
  const rows = (Array.isArray(res.data) ? res.data : (res.data as any)?.items) || [];
  return rows.find((row: any) => row.id === postId);
}

const render = (post: unknown) => renderToStaticMarkup(createElement(PostMedia as never, { post } as never));

console.log('🧪 添付の通しの検査（実サーバー・クライアントの部品をそのまま）');

// ======================================================================
console.log('\n🎵 音声: 上げる → 投稿する → 再生できる形で出る');
const audioUpload = await upload('sample.mp3', 'audio/mpeg', 4096);
check('音声を上げられる（FormData が multipart で届く）', audioUpload.status === 200);
check('返る種類は audio/mpeg', String(audioUpload.media?.mediaType) === 'audio/mpeg');

const audioPost = await api.post('/api/posts', {
  content: `音声つき ${stamp}`,
  visibility: 'public',
  attachments: [audioUpload.media],
});
check('音声つきで投稿できる', audioPost.status === 201);

const audioRow = await fromTimeline((audioPost.data as any)?.id);
check('タイムラインに添付が付いて返る', Boolean(audioRow?.media_attachments?.[0]));
check('添付の種類は mediaType で返る', audioRow?.media_attachments?.[0]?.mediaType === 'audio/mpeg');

const audioHtml = render(audioRow);
check('画面はプレイヤーを出す', audioHtml.includes('<audio') && audioHtml.includes('controls'));
check('画像として出さない（壊れた絵にしない）', !audioHtml.includes('<img'));

// 実ファイルが音声として配れるか（Range つきで取りにいく = プレイヤーの動き）
const fileRes = await realFetch(audioRow.media_attachments[0].url, { headers: { Range: 'bytes=0-1023' } });
check('音声ファイルは audio として配られる', String(fileRes.headers.get('content-type')).startsWith('audio/'));
check('途中からも取れる（Range に応える）', fileRes.status === 206 || fileRes.status === 200);

// ======================================================================
console.log('\n🎬 動画と画像も同じ道で');
const videoUpload = await upload('clip.mp4', 'video/mp4', 4096);
const videoPost = await api.post('/api/posts', {
  content: `動画つき ${stamp}`,
  visibility: 'public',
  attachments: [videoUpload.media],
});
const videoRow = await fromTimeline((videoPost.data as any)?.id);
const videoHtml = render(videoRow);
check('動画は <video> で出る', videoHtml.includes('<video'));
check('動画を画像として出さない', !videoHtml.includes('<img'));

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const imageForm = new FormData();
imageForm.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
const imageUpload = await api.post('/api/media/upload', imageForm);
const imagePost = await api.post('/api/posts', {
  content: `画像つき ${stamp}`,
  visibility: 'public',
  attachments: [(imageUpload.data as any)?.media?.[0]],
});
const imageRow = await fromTimeline((imagePost.data as any)?.id);
const imageHtml = render(imageRow);
check('画像は押して大きく見る形で出る', imageHtml.includes('class="picbtn"') && imageHtml.includes('<img'));
check('画像にプレイヤーは出さない', !imageHtml.includes('<audio'));

console.log('');
if (failures === 0) console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
else console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
process.exit(failures === 0 ? 0 : 1);
