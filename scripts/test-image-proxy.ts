import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// 画像プロキシの検証
//
//   1. タイムライン応答のリモート画像 URL が署名付きプロキシ URL に置き換わる
//      （アイコン・添付・本文 HTML。ローカルのメディアは置き換えない）
//   2. /proxy は署名が無い/不正だと 403（開放プロキシにならない）
//   3. 画像は取得して 2 回目以降はキャッシュから返す（相手への通信は 1 回だけ）
//   4. 画像以外のコンテンツは 502
//   5. 無効化すると置き換えも /proxy も止まる
//   6. 管理 API でキャッシュを整理・全削除できる
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_image_proxy.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3696;
const REMOTE_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const REMOTE_ORIGIN = `http://127.0.0.1:${REMOTE_PORT}`;
const REMOTE_ACTOR = `${REMOTE_ORIGIN}/users/eve`;
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});
// プロキシのキャッシュディレクトリも消しておく
for (const dir of [path.resolve(ROOT_DIR, 'server', 'data', 'proxy-cache'), path.resolve(ROOT_DIR, 'data', 'proxy-cache')]) {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

// 1x1 の PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
}

async function assertPortFree(port: number): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3700 のように空きポートを指定してください。`);
}

async function waitForServer(url: string, maxRetries = 60): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

function signInboxRequest(body: string, keyId: string, privateKeyPem: string): Record<string, string> {
  const host = `localhost:${PORT}`;
  const date = new Date().toUTCString();
  const digest = `SHA-256=${crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')}`;
  const contentType = 'application/activity+json';
  const signingString = [
    '(request-target): post /inbox',
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`,
  ].join('\n');
  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  const signature = signer.sign(privateKeyPem, 'base64');
  return {
    Host: host,
    Date: date,
    Digest: digest,
    'Content-Type': contentType,
    Signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="${signature}"`,
  };
}

/** 署名の計算（サーバーと同じ手順をテスト側で再現する） */
function signProxyUrl(url: string, instancePrivateKeyPem: string): string {
  const secret = crypto.createHash('sha256').update(`image-proxy:${instancePrivateKeyPem}`).digest('hex');
  return crypto.createHmac('sha256', secret).update(url).digest('base64url').slice(0, 22);
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 画像プロキシ 検証テスト');
  console.log(`   server=${PORT} / 疑似リモート=${REMOTE_PORT}`);
  console.log('====================================================\n');

  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let server: ChildProcess | null = null;
  let remote: http.Server | null = null;
  const remoteHits: Record<string, number> = {};

  try {
    await assertPortFree(PORT);
    await assertPortFree(REMOTE_PORT);

    // ── 疑似リモートサーバー（画像と HTML を返す）──────────────
    remote = http.createServer((req, res) => {
      const url = req.url || '/';
      remoteHits[url] = (remoteHits[url] || 0) + 1;
      if (url.startsWith('/icon.png') || url.startsWith('/inline.png') || url.startsWith('/media.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
        return res.end(PNG);
      }
      if (url.startsWith('/page.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>not an image</body></html>');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((resolve) => remote!.listen(REMOTE_PORT, '127.0.0.1', resolve));
    console.log('✅ 疑似リモートサーバー起動\n');

    // ── Spica 起動（ローカル取得を許可して SSRF ガードを通す）──
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Image Proxy Test',
        RATE_LIMIT_DISABLED: 'true',
        ALLOW_PRIVATE_REMOTE_FETCH: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'alice', agreedToRules: true }),
    });
    const alice = await reg.json();
    const token = alice.sessionToken as string;
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    db.exec('PRAGMA busy_timeout = 10000');
    // インスタンス鍵は遅延生成されるため、署名の検証時点で読み直す
    const instanceKey = (): string =>
      String((db.prepare("SELECT private_key_pem FROM instance_actor WHERE id = 'instance'").get() as any)?.private_key_pem || '');

    const keys = generateTestKeyPair();
    db.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', '127.0.0.1', 'eve', '', ?, '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ACTOR, `${REMOTE_ORIGIN}/icon.png`, `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, keys.publicKeyPem, new Date().toISOString());
    db.prepare(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES ('f-eve', ?, ?, ?, 1, 'accepted', ?)
       ON CONFLICT(follower_url, following_url) DO UPDATE SET status = 'accepted'`,
    ).run(alice.user.actorUrl, REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, new Date().toISOString());

    // リモート投稿（添付画像 + 本文内の画像 + アイコン）
    const noteId = `${REMOTE_ACTOR}/notes/img1`;
    const activity = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ACTOR}/activities/img1`,
      type: 'Create',
      actor: REMOTE_ACTOR,
      to: [PUBLIC],
      object: {
        id: noteId,
        type: 'Note',
        attributedTo: REMOTE_ACTOR,
        content: `<p>画像つき <img src="${REMOTE_ORIGIN}/inline.png" alt="インライン"></p>`,
        published: new Date().toISOString(),
        to: [PUBLIC],
        attachment: [{ type: 'Document', mediaType: 'image/png', url: `${REMOTE_ORIGIN}/media.png`, name: '添付の説明' }],
      },
    };
    const body = JSON.stringify(activity);
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body });
    await sleep(700);

    // ── 1. 応答の URL 置き換え ─────────────────────────────
    console.log('🖼️ [1] タイムライン応答の URL がプロキシ経由になる');
    const timeline = await (await fetch(`${BASE}/api/timeline?mode=home&limit=10`, { headers: auth })).json();
    const item = (Array.isArray(timeline) ? timeline : []).find((p: any) => p.id === noteId);
    check('投稿が届いている', Boolean(item), true);

    const icon = String(item?.author_icon || '');
    check('アイコンが /proxy 経由', icon.startsWith('/proxy?url='), true);
    check('アイコンの署名が付いている', /[?&]s=[A-Za-z0-9_-]{22}$/.test(icon), true);
    check('元 URL が url パラメータに入る', decodeURIComponent(icon.match(/url=([^&]+)/)?.[1] || ''), `${REMOTE_ORIGIN}/icon.png`);

    const attachment = (item?.media_attachments || [])[0];
    check('添付画像が /proxy 経由', String(attachment?.url || '').startsWith('/proxy?url='), true);
    check('添付の alt（説明）は保持される', attachment?.description ?? attachment?.name ?? '', '添付の説明');
    check('本文内の <img> も /proxy 経由', /<img[^>]+src="\/proxy\?url=/.test(String(item?.content || '')), true);

    // ローカル投稿は置き換えない
    const localPost = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: 'ローカルの投稿' }),
    })).json();
    const localTimeline = await (await fetch(`${BASE}/api/timeline?mode=local&limit=10`, { headers: auth })).json();
    const localItem = (Array.isArray(localTimeline) ? localTimeline : []).find((p: any) => p.id === localPost.id);
    check('ローカル投稿のアイコンは置き換えない', String(localItem?.author_icon || '').startsWith('/proxy'), false);

    // ── 2. 署名検証 ────────────────────────────────────────
    console.log('\n🔒 [2] 署名が無い / 不正なリクエストは拒否');
    const noSig = await fetch(`${BASE}/proxy?url=${encodeURIComponent(`${REMOTE_ORIGIN}/icon.png`)}`);
    check('署名なしは 403', noSig.status, 403);
    const badSig = await fetch(`${BASE}/proxy?url=${encodeURIComponent(`${REMOTE_ORIGIN}/icon.png`)}&s=invalidinvalidinvalidi`);
    check('不正な署名は 403', badSig.status, 403);

    // ── 3. 取得とキャッシュ ────────────────────────────────
    console.log('\n💾 [3] 画像を取得し、2 回目はキャッシュから返す');
    const hitsBefore = remoteHits['/icon.png'] || 0;
    const first = await fetch(`${BASE}${icon}`);
    const firstBody = Buffer.from(await first.arrayBuffer());
    check('プロキシ経由で画像が取れる', first.status, 200);
    check('Content-Type が維持される', first.headers.get('content-type'), 'image/png');
    check('バイト列が一致する', firstBody.equals(PNG), true);
    check('1 回目はキャッシュミス', first.headers.get('x-proxy-cache'), 'MISS');
    check('nosniff が付く', first.headers.get('x-content-type-options'), 'nosniff');
    check('相手サーバーへ 1 回取得した', (remoteHits['/icon.png'] || 0) - hitsBefore, 1);

    const second = await fetch(`${BASE}${icon}`);
    const secondBody = Buffer.from(await second.arrayBuffer());
    check('2 回目はキャッシュヒット', second.headers.get('x-proxy-cache'), 'HIT');
    check('相手サーバーへの再取得は無い', (remoteHits['/icon.png'] || 0) - hitsBefore, 1);
    check('2 回目も同じバイト列', secondBody.equals(PNG), true);

    const statsBefore = await (await fetch(`${BASE}/api/admin/maintenance`, { headers: auth })).json();
    check('管理画面の統計にプロキシ情報が出る', statsBefore.imageProxy.enabled, true);
    check('キャッシュ件数が記録される', statsBefore.imageProxy.files >= 1, true);

    // ── 4. 画像以外は拒否 ──────────────────────────────────
    console.log('\n🚫 [4] 画像以外のコンテンツは通さない');
    const pageUrl = `${REMOTE_ORIGIN}/page.html`;
    const pageRes = await fetch(`${BASE}/proxy?url=${encodeURIComponent(pageUrl)}&s=${signProxyUrl(pageUrl, instanceKey())}`);
    check('HTML は 502', pageRes.status, 502);

    // ── 5. 無効化 ──────────────────────────────────────────
    console.log('\n⏸️ [5] 無効にすると置き換えも /proxy も止まる');
    const off = await fetch(`${BASE}/api/admin/maintenance/settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ imageProxy: false }),
    });
    check('設定を保存できる', off.status, 200);
    const offTimeline = await (await fetch(`${BASE}/api/timeline?mode=home&limit=10`, { headers: auth })).json();
    const offItem = (Array.isArray(offTimeline) ? offTimeline : []).find((p: any) => p.id === noteId);
    check('無効時は元の URL に戻る', String(offItem?.author_icon || ''), `${REMOTE_ORIGIN}/icon.png`);
    const offProxy = await fetch(`${BASE}${icon}`);
    check('無効時の /proxy は 404', offProxy.status, 404);

    await fetch(`${BASE}/api/admin/maintenance/settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ imageProxy: true }),
    });

    // ── 6. キャッシュ整理 ──────────────────────────────────
    console.log('\n🧹 [6] 管理 API でキャッシュを整理できる');
    const cleared = await fetch(`${BASE}/api/admin/image-proxy/cache`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ clear: true }),
    });
    const clearedBody = await cleared.json();
    check('全削除できる', cleared.status, 200);
    check('削除件数が返る', clearedBody.result.removed >= 1, true);
    check('統計が 0 になる', clearedBody.stats.files, 0);

    // 削除後はもう一度取得できる（キャッシュは再生成される）
    const hitsBefore2 = remoteHits['/icon.png'] || 0;
    const refetch = await fetch(`${BASE}${icon}`);
    check('削除後も配信できる', refetch.status, 200);
    check('キャッシュミスとして再取得する', refetch.headers.get('x-proxy-cache'), 'MISS');
    check('相手へ再取得した', (remoteHits['/icon.png'] || 0) - hitsBefore2, 1);
  } finally {
    try { server?.kill('SIGTERM'); } catch {}
    await sleep(600);
    try { server?.kill('SIGKILL'); } catch {}
    await new Promise<void>((resolve) => remote?.close(() => resolve()) ?? resolve());
  }

  console.log('');
  if (failures === 0) {
    console.log('✅ すべてのテストに成功しました');
  } else {
    console.log(`❌ ${failures} 件のテストに失敗しました`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('テスト実行中にエラー:', err);
  process.exit(1);
});
