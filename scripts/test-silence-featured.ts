import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// サイレンス（silence）と featured コレクションの検証
//
//   1. Actor 文書に featured が入り、/users/:id/collections/featured で
//      ピン留め投稿が公開される（Mastodon / Misskey から見える）
//   2. 非公開（local 限定 / フォロワー限定）のピン留めは公開コレクションに出ない
//   3. サイレンス: そのサーバーの投稿はタイムライン・検索・通知から消えるが
//      データは残り、通信（Inbox）も 403 にならない（配送は継続）
//   4. ブロック（suspend）: 403 で遮断し、キャッシュも削除される
//   5. 管理 API で強度を登録・取得できる
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_silence_featured.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3695;
const BASE = `http://localhost:${PORT}`;
const REMOTE_ACTOR = 'https://remote.test/users/eve';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

/** seed 用の接続（アプリと同じドライバ。PostgreSQL でも同じ検査が流せる） */
const seedDb = createAsyncDatabase({
  driver: process.env.DB_DRIVER,
  connectionString: process.env.DATABASE_URL,
  dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB),
});

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

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 サイレンス / featured コレクション 検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let server: ChildProcess | null = null;

  const startServer = async (): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Silence Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    return child;
  };

  try {
    await assertPortFree(PORT);
    server = await startServer();
    console.log('✅ サーバー起動完了\n');

    // --- 準備 ---
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'alice', agreedToRules: true }),
    });
    const alice = await reg.json();
    const token = alice.sessionToken as string;
    const actorUrl = alice.user.actorUrl as string;
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const keys = generateTestKeyPair();
    await seedDb.exec('PRAGMA busy_timeout = 10000');
    await seedDb.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', 'remote.test', 'eve', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, keys.publicKeyPem, new Date().toISOString());

    const makeLocalPost = async (content: string, visibility?: string) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(visibility ? { content, visibility } : { content }),
      });
      return (await res.json()).id as string;
    };
    const togglePin = async (postId: string) => {
      const res = await fetch(`${BASE}/api/posts/pin/toggle`, { method: 'POST', headers: auth, body: JSON.stringify({ postId }) });
      return { status: res.status, body: await res.json() };
    };
    const deliverNote = async (id: string, content: string) => {
      const activity = {
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${REMOTE_ACTOR}/activities/${encodeURIComponent(id)}`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        to: [PUBLIC],
        object: { id, type: 'Note', attributedTo: REMOTE_ACTOR, content, published: new Date().toISOString(), to: [PUBLIC] },
      };
      const body = JSON.stringify(activity);
      return fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body });
    };
    const fetchCollection = async (url: string) => {
      const res = await fetch(url, { headers: { Accept: 'application/activity+json' } });
      return { status: res.status, body: await res.json() };
    };
    const postExists = async (id: string) => Number((await seedDb.prepare('SELECT COUNT(*) AS c FROM posts WHERE id = ?').get(id) as any).c);

    // alice が eve をフォロー（ホームタイムラインに出る状態にしておく）
    await seedDb.prepare(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES ('f-eve', ?, ?, ?, 1, 'accepted', ?)
       ON CONFLICT(follower_url, following_url) DO UPDATE SET status = 'accepted'`,
    ).run(alice.user.actorUrl, REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, new Date().toISOString());

    // リモート投稿も索引する（検索に出る状態にしてからサイレンスの効果を見る）
    await fetch(`${BASE}/api/admin/content-policy`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ftsIndexScope: 'all' }),
    });

    const home = async () => {
      const rows = await (await fetch(`${BASE}/api/timeline?mode=home&limit=50`, { headers: auth })).json();
      return (Array.isArray(rows) ? rows : rows.posts || []).map((p: any) => p.id);
    };

    // ------------------------------------------------------------------
    console.log('📌 [1] featured コレクション: ピン留め投稿を連合先から見えるようにする');
    const post1 = await makeLocalPost('ピン留めする投稿');
    const actorDoc = await fetchCollection(actorUrl);
    check('Actor に featured が含まれる', actorDoc.body.featured, `${actorUrl}/collections/featured`);

    const empty = await fetchCollection(`${actorUrl}/collections/featured`);
    check('ピン留め前は空のコレクション', empty.body.totalItems, 0);
    check('コレクションの type', empty.body.type, 'OrderedCollection');

    const pin = await togglePin(post1);
    check('ピン留めできる', pin.body.pinned, true);

    const withPin = await fetchCollection(`${actorUrl}/collections/featured`);
    check('ピン留め投稿がコレクションに入る', withPin.body.totalItems, 1);
    check('orderedItems はノートの URL', withPin.body.orderedItems[0], post1);

    console.log('\n📌 [2] 非公開のピン留めは公開コレクションに出ない');
    const localOnly = await makeLocalPost('ローカル限定のピン留め', 'local');
    const followersOnly = await makeLocalPost('フォロワー限定のピン留め', 'followers');
    await togglePin(localOnly);
    await togglePin(followersOnly);
    await sleep(200);
    const filtered = await fetchCollection(`${actorUrl}/collections/featured`);
    check('公開ピンのみ掲載される', filtered.body.totalItems, 1);
    check('ローカル限定は含まれない', filtered.body.orderedItems.includes(localOnly), false);
    check('フォロワー限定は含まれない', filtered.body.orderedItems.includes(followersOnly), false);

    // 後片付け（公開ピンだけ解除）
    await togglePin(localOnly);
    await togglePin(followersOnly);

    console.log('\n📌 [3] ピン解除でコレクションから消える');
    await togglePin(post1);
    await sleep(200);
    const afterUnpin = await fetchCollection(`${actorUrl}/collections/featured`);
    check('解除後は空になる', afterUnpin.body.totalItems, 0);

    // ------------------------------------------------------------------
    console.log('\n🔇 [4] サイレンス登録: 通信は維持し、表示から隠す');
    // まず基準（サイレンス前）を測る
    const before1 = await deliverNote(`${REMOTE_ACTOR}/notes/s0`, 'サイレンス前の投稿');
    await sleep(600);
    check('サイレンス前は受信できる', before1.status >= 200 && before1.status < 300, true);
    check('サイレンス前はホームに出る', (await home()).includes(`${REMOTE_ACTOR}/notes/s0`), true);
    const searchBefore = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent('サイレンス前の投稿')}`, { headers: auth })).json();
    check('サイレンス前は検索でも見つかる', (searchBefore.posts || []).map((p: any) => p.id).includes(`${REMOTE_ACTOR}/notes/s0`), true);

    const silent = await fetch(`${BASE}/api/admin/blocks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ domain: 'remote.test', reason: 'テスト用', severity: 'silence' }),
    });
    const silentBody = await silent.json();
    check('サイレンスを登録できる', silent.status, 201);
    check('強度が silence で返る', silentBody.severity, 'silence');
    check('サイレンスではデータを消さない', silentBody.purgeStats ?? null, null);

    const deliver1 = await deliverNote(`${REMOTE_ACTOR}/notes/s1`, 'サイレンス対象の投稿');
    check('サイレンス中でも受信は 2xx（配送は継続）', deliver1.status >= 200 && deliver1.status < 300, true);
    await sleep(600);
    check('投稿データは残る', await postExists(`${REMOTE_ACTOR}/notes/s1`), 1);

    const homeIds = await home();
    check('既存の投稿もホームから消える', homeIds.includes(`${REMOTE_ACTOR}/notes/s0`), false);
    check('新しい投稿もホームに出ない', homeIds.includes(`${REMOTE_ACTOR}/notes/s1`), false);

    const search = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent('サイレンス対象')}`, { headers: auth })).json();
    const searchIds = (search.posts || []).map((p: any) => p.id);
    check('検索にも出ない', searchIds.includes(`${REMOTE_ACTOR}/notes/s1`), false);

    const blocks = await (await fetch(`${BASE}/api/admin/blocks`, { headers: auth })).json();
    const listed = (Array.isArray(blocks) ? blocks : blocks.blocks || []).find((b: any) => b.domain === 'remote.test');
    check('一覧の強度が silence', listed?.severity, 'silence');

    // 反応（Like）は受理され通知も記録されるが、一覧には出さない
    const reactionTarget = await makeLocalPost('サイレンス中のリアクション対象');
    const likeBody = JSON.stringify({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ACTOR}/activities/like-silenced`,
      type: 'Like',
      actor: REMOTE_ACTOR,
      object: reactionTarget,
    });
    const likeRes = await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(likeBody, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body: likeBody });
    check('サイレンス中でもリアクションは受理される', likeRes.status >= 200 && likeRes.status < 300, true);
    await sleep(600);
    const reactionNotifCount = Number((await seedDb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'reaction'").get() as any).c);
    check('通知としては記録される', reactionNotifCount >= 1, true);
    const notifList = await (await fetch(`${BASE}/api/notifications`, { headers: auth })).json();
    const reactionNotifs = (Array.isArray(notifList) ? notifList : notifList.notifications || []).filter((n: any) => n.type === 'reaction');
    check('通知一覧には出ない', reactionNotifs.length, 0);

    // ------------------------------------------------------------------
    console.log('\n🚫 [5] ブロック（suspend）へ切替: 遮断してデータも消す');
    await fetch(`${BASE}/api/admin/blocks/remote.test`, { method: 'DELETE', headers: auth });
    await sleep(200);
    const suspend = await fetch(`${BASE}/api/admin/blocks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ domain: 'remote.test', reason: 'テスト用', severity: 'suspend', purgeData: true }),
    });
    const suspendBody = await suspend.json();
    check('ブロックを登録できる', suspend.status, 201);
    check('強度が suspend で返る', suspendBody.severity, 'suspend');
    check('ブロックではキャッシュを削除する', (suspendBody.purgeStats?.posts ?? 0) >= 1, true);
    await sleep(300);
    check('投稿データが消える', await postExists(`${REMOTE_ACTOR}/notes/s1`), 0);

    const deliver2 = await deliverNote(`${REMOTE_ACTOR}/notes/s2`, 'ブロック対象の投稿');
    check('ブロック中は 403 で拒否', deliver2.status, 403);
    await sleep(300);
    check('ブロック中の投稿は保存されない', await postExists(`${REMOTE_ACTOR}/notes/s2`), 0);

    console.log('\n🔁 [6] 解除後は元に戻る');
    const unblock = await fetch(`${BASE}/api/admin/blocks/remote.test`, { method: 'DELETE', headers: auth });
    check('解除できる', unblock.status, 200);
    await sleep(200);
    // ブロック時にアクターキャッシュも消えているため、再取得された状態を再現する
    await seedDb.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', 'remote.test', 'eve', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, keys.publicKeyPem, new Date().toISOString());
    const deliver3 = await deliverNote(`${REMOTE_ACTOR}/notes/s3`, '解除後の投稿');
    await sleep(500);
    check('解除後は受信できる', deliver3.status >= 200 && deliver3.status < 300, true);
    check('解除後の投稿は保存される', await postExists(`${REMOTE_ACTOR}/notes/s3`), 1);
  } finally {
    try { server?.kill('SIGTERM'); } catch {}
    await sleep(800);
    try { server?.kill('SIGKILL'); } catch {}
    await seedDb.close().catch(() => {});
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
