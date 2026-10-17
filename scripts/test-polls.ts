import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// アンケート（投票）の連合の検査
//
//   [1] 自サーバーのアンケート: 投票・二重投票の禁止・得票数の Update(Question) 配信
//       （自サーバーのアンケートでは「票そのもの」を送らない = 原典でも二重に数えない）
//   [2] 受信: リモートからの票（Create(Note) inReplyTo=アンケート）を数える
//       ＋ 投票者へ最新の得票数を返す（返さないと投票した側に自分の票が入らない）
//   [3] 受信: Update(Question) の得票数の取り込み
//       （多い方を採用・二重に数えない・「編集済み」にしない・並び順が違っても名前で照合）
//   [4] 送信: リモートのアンケートへの票を原典へ送る（選択肢は index ではなくテキストで送る）
//   [5] Update(Person) はプロフィール更新として効く（本人以外からのものは拒否）
//
// ポートは TEST_PORT で変更可能（既定 3667）。捕捉サーバーは +1 を使う。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_polls.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3667;
const CAPTURE_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;

const EVE = 'https://remote.test/users/eve'; // リモートのアンケートの作者
const FRANK = 'https://remote.test/users/frank'; // リモートの投票者
const MALLORY = 'https://remote.test/users/mallory'; // なりすまし役
const REMOTE_POST_ID = 'https://remote.test/users/eve/posts/3001';

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

/** PostgreSQL でも回せる（run-suites-pg.sh から呼ばれたときは DB_DRIVER=postgres） */
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB) });

async function row(sql: string, ...params: any[]): Promise<any> {
  const conn = openDb();
  try {
    return await conn.prepare(sql).get(...params);
  } finally {
    await conn.close().catch(() => {});
  }
}

async function all(sql: string, ...params: any[]): Promise<any[]> {
  const conn = openDb();
  try {
    return (await conn.prepare(sql).all(...params)) as any[];
  } finally {
    await conn.close().catch(() => {});
  }
}

async function exec(sql: string, ...params: any[]): Promise<void> {
  const conn = openDb();
  try {
    await conn.prepare(sql).run(...params);
  } finally {
    await conn.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
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
  if (inUse) {
    throw new Error(
      `ポート ${port} では既にサーバーが応答しています。稼働中のインスタンスへ書き込まないよう中断しました。\n` +
      `空きポートを指定して実行してください:  TEST_PORT=3667 npx tsx scripts/test-polls.ts`,
    );
  }
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

async function waitForPortFree(port: number, maxRetries = 20): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await assertPortFree(port);
      return;
    } catch {
      await sleep(300);
    }
  }
}

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

/** 受信側と同じ書式で HTTP Signature を付ける */
function signInboxRequest(body: string, keyId: string, privateKeyPem: string): Record<string, string> {
  const host = DOMAIN;
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

/** 送信側（Spica）からの配送を受ける偽の受信箱 */
const captured: { path: string; body: any; signed: boolean }[] = [];
function startCaptureServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = raw;
        try { body = JSON.parse(raw); } catch {}
        captured.push({ path: req.url || '/', body, signed: Boolean(req.headers['signature']) });
        res.statusCode = 202;
        res.end('{}');
      });
    });
    server.listen(CAPTURE_PORT, '127.0.0.1', () => resolve(server));
  });
}

const activitiesTo = (fragment: string): any[] =>
  captured.filter((c) => c.path.includes(fragment)).map((c) => c.body);

/** 指定の形の配信が届くまで少し待つ（配送は非同期なので即座には来ない） */
async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = fn();
    if (found) return found;
    await sleep(150);
  }
  return null;
}

/** アンケートの得票数（タイムライン経由＝画面が見るのと同じ形）を読む */
async function timelinePoll(base: string, postId: string): Promise<any | null> {
  const res = await fetch(`${base}/api/timeline?mode=local&limit=50`);
  const list = (await res.json().catch(() => null)) as any[] | null;
  return Array.isArray(list) ? (list.find((p) => p?.id === postId)?.poll ?? null) : null;
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 アンケート（投票）の連合の検査');
  console.log(`   server=${PORT} capture=${CAPTURE_PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let capture: http.Server | null = null;
  let completed = false;
  const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);

  try {
    await assertPortFree(PORT);
    await assertPortFree(CAPTURE_PORT);
    capture = await startCaptureServer();

    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN,
        PROTOCOL: 'http',
        DB_PATH: dbPath,
        INSTANCE_NAME: 'Poll Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const api = async (
      method: string,
      endpoint: string,
      token?: string,
      body?: unknown,
    ): Promise<{ status: number; data: any }> => {
      const res = await fetch(`${BASE}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data };
    };

    const aliceReg = await api('POST', '/api/auth/register', undefined, { id: 'alice', name: 'Alice', agreedToRules: true });
    const alice = aliceReg.data.sessionToken as string;
    const bobReg = await api('POST', '/api/auth/register', undefined, { id: 'bob', name: 'Bob', agreedToRules: true });
    const bob = bobReg.data.sessionToken as string;
    if (!alice || !bob) throw new Error('登録に失敗しました');

    // リモートの登場人物を仕込む（inbox は捕捉サーバーへ向ける）
    const eveKeys = generateTestKeyPair();
    const frankKeys = generateTestKeyPair();
    const malloryKeys = generateTestKeyPair();
    const seedActor = async (id: string, username: string, keys: { publicKeyPem: string }, inbox: string) => {
      await exec(
        `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET inbox_url = excluded.inbox_url, public_key_pem = excluded.public_key_pem, public_key_id = excluded.public_key_id`,
        id, username, 'remote.test', username, '', '', '', inbox, null, `${id}#main-key`, keys.publicKeyPem, new Date().toISOString(),
      );
    };
    await seedActor(EVE, 'eve', eveKeys, `http://localhost:${CAPTURE_PORT}/eve/inbox`);
    await seedActor(FRANK, 'frank', frankKeys, `http://localhost:${CAPTURE_PORT}/frank/inbox`);
    await seedActor(MALLORY, 'mallory', malloryKeys, `http://localhost:${CAPTURE_PORT}/mallory/inbox`);

    // eve は alice のフォロワー（自サーバーのアンケートの更新が届く相手）
    await exec(
      'INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at) VALUES (?,?,?,?,0,?,?)',
      `follow-${EVE}`, EVE, `http://${DOMAIN}/users/alice`, `http://localhost:${CAPTURE_PORT}/eve/inbox`, 'accepted', new Date().toISOString(),
    );

    const sendActivity = async (actorUrl: string, privateKeyPem: string, activity: unknown) => {
      const body = JSON.stringify(activity);
      const headers = signInboxRequest(body, `${actorUrl}#main-key`, privateKeyPem);
      const res = await fetch(`${BASE}/inbox`, { method: 'POST', headers, body });
      if (res.status >= 400) {
        const text = await res.clone().text().catch(() => '');
        console.log(`    ℹ️ inbox 応答 ${res.status}: ${text.slice(0, 300)}`);
      }
      return res;
    };

    // 受信する形は Misskey / Mastodon と同じ（1 票 = Create(Note) inReplyTo=アンケート、name が選択肢）
    const sendVote = (postId: string, text: string) =>
      sendActivity(FRANK, frankKeys.privateKeyPem, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${postId}#votes/${crypto.randomUUID()}/activity`,
        type: 'Create',
        actor: FRANK,
        to: [EVE],
        object: {
          id: `${postId}#votes/${crypto.randomUUID()}`,
          type: 'Note',
          attributedTo: FRANK,
          inReplyTo: postId,
          name: text,
          to: [EVE],
          published: new Date().toISOString(),
        },
      });

    // ======================================================================
    console.log('\n📊 [1] 自サーバーのアンケート（投票と得票数の配信）');

    const created = await api('POST', '/api/posts', alice, {
      content: '好きな果物は？',
      visibility: 'public',
      poll: { choices: ['りんご', 'みかん', 'ぶどう'], multiple: false, expires_in: 86400 },
    });
    check('アンケート付きで投稿できる', created.status, 201);
    const localPollPostId = created.data?.id as string;
    check('選択肢が 3 つ返る', created.data?.poll?.choices?.length, 3);
    check('最初は 0 票', created.data?.poll?.total_votes, 0);

    // 期限: expires_in（スネークケース）と expiresIn（キャメルケース）の両方を受ける。
    // Web クライアントが expiresIn を送っていて「常に無期限」になっていた回帰の検査
    const snakeExpiresAt = Date.parse(String(created.data?.poll?.expires_at || ''));
    check('expires_in で期限が付く', Number.isFinite(snakeExpiresAt), true);
    check('期限は約 1 日後', Math.abs(snakeExpiresAt - Date.now() - 86400_000) < 60_000, true);

    const camelPoll = await api('POST', '/api/posts', alice, {
      content: '期限つき（camelCase）',
      visibility: 'public',
      poll: { choices: ['はい', 'いいえ'], multiple: false, expiresIn: 1800 },
    });
    const camelExpiresAt = Date.parse(String(camelPoll.data?.poll?.expires_at || ''));
    check('expiresIn（キャメル）でも期限が付く', Number.isFinite(camelExpiresAt), true);
    check('期限は約 30 分後', Math.abs(camelExpiresAt - Date.now() - 1800_000) < 60_000, true);

    const noExpiryPoll = await api('POST', '/api/posts', alice, {
      content: '期限なし',
      visibility: 'public',
      poll: { choices: ['はい', 'いいえ'], multiple: false },
    });
    check('指定が無ければ期限は付かない', noExpiryPoll.data?.poll?.expires_at, null);

    const bobVote = await api('POST', `/api/posts/${encodeURIComponent(localPollPostId)}/poll/vote`, bob, { choices: [1] });
    check('投票できる', bobVote.status, 200);
    check('票が入る', bobVote.data?.poll?.total_votes, 1);
    check('選んだ選択肢に +1', bobVote.data?.poll?.choices?.[1]?.votes_count, 1);
    check('自分の投票が分かる', bobVote.data?.poll?.my_voted, true);

    const twice = await api('POST', `/api/posts/${encodeURIComponent(localPollPostId)}/poll/vote`, bob, { choices: [0] });
    check('同じ人が二度は投票できない', twice.status, 400);

    const multiple = await api('POST', `/api/posts/${encodeURIComponent(localPollPostId)}/poll/vote`, bob, { choices: [0, 1] });
    check('単一選択で複数は選べない', multiple.status, 400);

    const invalid = await api('POST', `/api/posts/${encodeURIComponent(localPollPostId)}/poll/vote`, bob, { choices: [9] });
    check('無い選択肢は拒否される', invalid.status, 400);

    // フォロワー（eve）へ Update(Question) が飛ぶ
    const localUpdate = await waitFor(() =>
      activitiesTo('/eve/inbox').find((a) => a?.type === 'Update' && a?.object?.id === localPollPostId));
    check('得票数の Update(Question) がフォロワーへ届く', Boolean(localUpdate), true);
    check('届いた Update の得票数', localUpdate?.object?.oneOf?.[1]?._misskey_votes, 1);
    check('届いた Update の votersCount', localUpdate?.object?.votersCount, 1);
    check('配送には署名が付く', captured.find((c) => c.body === localUpdate)?.signed, true);

    // 自サーバーのアンケートでは「票そのもの」を送らない（原典と二重に数えないため）
    const voteNotesToEve = activitiesTo('/eve/inbox').filter(
      (a) => a?.type === 'Create' && typeof a?.object?.id === 'string' && a.object.id.includes('#votes/'),
    );
    check('自サーバーのアンケートでは票そのものを送らない', voteNotesToEve.length, 0);

    // ======================================================================
    console.log('\n📥 [2] 受信: リモートからの票');

    const remoteVote = await sendVote(localPollPostId, 'ぶどう');
    check('リモートからの票を受け付ける', remoteVote.status, 200);
    await sleep(300);
    const afterRemote = await timelinePoll(BASE, localPollPostId);
    check('リモートの票が数えられている', afterRemote?.total_votes, 2);
    check('選んだ選択肢に +1（ぶどう）', afterRemote?.choices?.[2]?.votes_count, 1);

    const dupeVote = await sendVote(localPollPostId, 'ぶどう');
    check('同じ人の同じ選択肢の票は二重に数えない', dupeVote.status, 200);
    await sleep(300);
    check('票数は増えていない（画面が見る形でも）', (await timelinePoll(BASE, localPollPostId))?.total_votes, 2);

    // 投票した側（frank）へ最新の得票数を返す（返さないと投票した画面に自分の票が入らない）
    const backToFrank = await waitFor(() =>
      activitiesTo('/frank/inbox').find((a) => a?.type === 'Update' && a?.object?.id === localPollPostId));
    check('投票者へ最新の得票数を返す', Boolean(backToFrank), true);
    check('返した得票数が一致する', backToFrank?.object?.oneOf?.[2]?._misskey_votes, 1);

    // ======================================================================
    console.log('\n🗳️ [3] 受信: Update(Question) の得票数の取り込み');

    const now = new Date().toISOString();
    await exec(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
       VALUES (?,?,?,?,?,?,0,'public',?)`,
      REMOTE_POST_ID, 'eve@remote.test', 'Eve', EVE, '@eve@remote.test', 'リモートのアンケート', now,
    );
    const remotePollId = `poll_seed_${crypto.randomUUID()}`;
    await exec('INSERT INTO polls (id, post_id, multiple, expires_at, created_at) VALUES (?,?,0,NULL,?)', remotePollId, REMOTE_POST_ID, now);
    await exec('INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES (?,?,0,?,0)', `c0_${remotePollId}`, remotePollId, '赤');
    await exec('INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES (?,?,1,?,0)', `c1_${remotePollId}`, remotePollId, '青');

    const pollRow = async () => {
      const choices = await all('SELECT text, votes_count FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC', remotePollId);
      return choices.map((c) => `${c.text}:${c.votes_count}`).join(',');
    };

    const q1 = await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_POST_ID}/update/${Date.now()}`,
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: REMOTE_POST_ID,
        type: 'Question',
        attributedTo: EVE,
        content: 'リモートのアンケート',
        votersCount: 4,
        oneOf: [
          { name: '赤', type: 'Note', replies: { type: 'Collection', totalItems: 3 } },
          { name: '青', type: 'Note', replies: { type: 'Collection', totalItems: 1 } },
        ],
      },
    });
    check('Update(Question) を受け付ける', q1.status, 200);
    await sleep(300);
    check('得票数を取り込む', await pollRow(), '赤:3,青:1');
    check('「編集済み」にはしない', (await row('SELECT edited_at FROM posts WHERE id = ?', REMOTE_POST_ID))?.edited_at ?? null, null);

    // 同じ Update をもう一度（再送）→ 二重に数えない
    await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_POST_ID}/update/${Date.now()}`,
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: REMOTE_POST_ID,
        type: 'Question',
        attributedTo: EVE,
        content: 'リモートのアンケート',
        votersCount: 4,
        oneOf: [
          { name: '赤', type: 'Note', replies: { type: 'Collection', totalItems: 3 } },
          { name: '青', type: 'Note', replies: { type: 'Collection', totalItems: 1 } },
        ],
      },
    });
    await sleep(300);
    check('再送で二重に数えない', await pollRow(), '赤:3,青:1');

    // 古い（少ない）得票数の Update では減らさない
    await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_POST_ID}/update/${Date.now()}`,
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: REMOTE_POST_ID,
        type: 'Question',
        attributedTo: EVE,
        content: 'リモートのアンケート',
        votersCount: 1,
        oneOf: [{ name: '赤', type: 'Note', replies: { type: 'Collection', totalItems: 1 } }],
      },
    });
    await sleep(300);
    check('古い得票数では減らさない', await pollRow(), '赤:3,青:1');

    // 並び順が違っても名前で照合する（index で合わせると取り違える）
    await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_POST_ID}/update/${Date.now()}`,
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: REMOTE_POST_ID,
        type: 'Question',
        attributedTo: EVE,
        content: 'リモートのアンケート',
        votersCount: 15,
        oneOf: [
          { name: '青', type: 'Note', replies: { type: 'Collection', totalItems: 9 } },
          { name: '赤', type: 'Note', replies: { type: 'Collection', totalItems: 6 } },
        ],
      },
    });
    await sleep(300);
    check('並び順が違っても名前で照合する', await pollRow(), '赤:6,青:9');

    // Misskey 形（_misskey_votes）も読む
    await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_POST_ID}/update/${Date.now()}`,
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: REMOTE_POST_ID,
        type: 'Question',
        attributedTo: EVE,
        content: 'リモートのアンケート',
        votersCount: 20,
        oneOf: [
          { name: '赤', _misskey_votes: 11 },
          { name: '青', _misskey_votes: 9 },
        ],
      },
    });
    await sleep(300);
    check('Misskey 形（_misskey_votes）も読む', await pollRow(), '赤:11,青:9');

    // 作者以外からの Update(Question) は無視する
    await sendActivity(MALLORY, malloryKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_POST_ID}/update/${Date.now()}`,
      type: 'Update',
      actor: MALLORY,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: REMOTE_POST_ID,
        type: 'Question',
        attributedTo: MALLORY,
        content: 'のっとり',
        votersCount: 999,
        oneOf: [
          { name: '赤', _misskey_votes: 999 },
          { name: '青', _misskey_votes: 0 },
        ],
      },
    });
    await sleep(300);
    check('作者以外の Update(Question) は無視する', await pollRow(), '赤:11,青:9');

    // 知らない投稿の Update(Question) は無視する（落ちない）
    const unknownQ = await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://remote.test/activities/unknown',
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: 'https://remote.test/users/eve/posts/9999',
        type: 'Question',
        attributedTo: EVE,
        oneOf: [{ name: '赤', _misskey_votes: 1 }],
      },
    });
    check('知らない投稿の Update(Question) でも落ちない', unknownQ.status, 200);

    // ======================================================================
    console.log('\n📮 [4] 送信: リモートのアンケートへの票を原典へ送る');

    const remoteVoteByBob = await api('POST', `/api/posts/${encodeURIComponent(REMOTE_POST_ID)}/poll/vote`, bob, { choices: [1] });
    check('リモートのアンケートにも投票できる', remoteVoteByBob.status, 200);
    check('手元の表示にも入る', remoteVoteByBob.data?.poll?.choices?.[1]?.votes_count, 10);

    const deliveredVote = await waitFor(() =>
      activitiesTo('/eve/inbox').find((a) => a?.type === 'Create' && a?.object?.inReplyTo === REMOTE_POST_ID));
    check('原典（作者）へ票が届く', Boolean(deliveredVote), true);
    check('票の形は Note', deliveredVote?.object?.type, 'Note');
    check('選択肢はテキストで送る', deliveredVote?.object?.name, '青');
    check('Misskey と同じく #votes/ を含む id', String(deliveredVote?.object?.id || '').includes('#votes/'), true);
    check('宛先は原典の作者', (deliveredVote?.to || []).includes(EVE), true);
    check('票の配送にも署名が付く', captured.find((c) => c.body === deliveredVote)?.signed, true);
    check('票そのものは 1 票だけ（複数送らない）', activitiesTo('/eve/inbox').filter(
      (a) => a?.type === 'Create' && a?.object?.inReplyTo === REMOTE_POST_ID,
    ).length, 1);

    // 複数選択のアンケートは選んだ数だけ送る（相手は name ごとに数える）
    const MULTI_POST_ID = 'https://remote.test/users/eve/posts/3002';
    const multiPollId = `poll_multi_${crypto.randomUUID()}`;
    await exec(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
       VALUES (?,?,?,?,?,?,0,'public',?)`,
      MULTI_POST_ID, 'eve@remote.test', 'Eve', EVE, '@eve@remote.test', '複数選択のアンケート', new Date().toISOString(),
    );
    await exec('INSERT INTO polls (id, post_id, multiple, expires_at, created_at) VALUES (?,?,1,NULL,?)', multiPollId, MULTI_POST_ID, new Date().toISOString());
    for (const [idx, text] of ['A', 'B', 'C'].entries()) {
      await exec('INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES (?,?,?,?,0)', `m${idx}_${multiPollId}`, multiPollId, idx, text);
    }
    const multiVote = await api('POST', `/api/posts/${encodeURIComponent(MULTI_POST_ID)}/poll/vote`, bob, { choices: [0, 2] });
    check('複数選択のアンケートに 2 つ選んで投票できる', multiVote.status, 200);
    check('選んだ 2 つに +1', [multiVote.data?.poll?.choices?.[0]?.votes_count, multiVote.data?.poll?.choices?.[2]?.votes_count], [1, 1]);
    const multiDelivered = await waitFor(() => {
      const list = activitiesTo('/eve/inbox').filter((a) => a?.object?.inReplyTo === MULTI_POST_ID);
      return list.length >= 2 ? list : null;
    });
    check('選んだ数だけ票を送る', multiDelivered?.map((a) => a.object.name).sort(), ['A', 'C']);

    // 期限切れのアンケートには投票できない（回帰）
    const expiredPostId = 'https://remote.test/users/eve/posts/3003';
    const expiredPollId = `poll_expired_${crypto.randomUUID()}`;
    await exec(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
       VALUES (?,?,?,?,?,?,0,'public',?)`,
      expiredPostId, 'eve@remote.test', 'Eve', EVE, '@eve@remote.test', '終了したアンケート', new Date().toISOString(),
    );
    await exec('INSERT INTO polls (id, post_id, multiple, expires_at, created_at) VALUES (?,?,0,?,?)', expiredPollId, expiredPostId, '2020-01-01T00:00:00.000Z', new Date().toISOString());
    await exec('INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES (?,?,0,?,0)', `e0_${expiredPollId}`, expiredPollId, 'はい');
    await exec('INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES (?,?,1,?,0)', `e1_${expiredPollId}`, expiredPollId, 'いいえ');
    const expiredVote = await api('POST', `/api/posts/${encodeURIComponent(expiredPostId)}/poll/vote`, bob, { choices: [0] });
    check('期限切れのアンケートには投票できない', expiredVote.status, 400);

    // ======================================================================
    console.log('\n👤 [5] Update(Person) はプロフィール更新として効く');

    const profileUpdate = await sendActivity(EVE, eveKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${EVE}#updates/${Date.now()}`,
      type: 'Update',
      actor: EVE,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: { id: EVE, type: 'Person', name: 'Eve 改', summary: '新しい自己紹介' },
    });
    check('Update(Person) を受け付ける', profileUpdate.status, 200);
    await sleep(300);
    const eveRow = await row('SELECT name, summary FROM remote_actors WHERE id = ?', EVE);
    check('表示名が更新される', eveRow?.name, 'Eve 改');
    check('自己紹介が更新される', eveRow?.summary, '新しい自己紹介');

    await sendActivity(FRANK, frankKeys.privateKeyPem, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${EVE}#updates/${Date.now()}-spoof`,
      type: 'Update',
      actor: FRANK,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: { id: EVE, type: 'Person', name: 'なりすまし', summary: 'のっとり' },
    });
    await sleep(300);
    const eveAfterSpoof = await row('SELECT name, summary FROM remote_actors WHERE id = ?', EVE);
    check('本人以外からのプロフィール更新は拒否する', [eveAfterSpoof?.name, eveAfterSpoof?.summary], ['Eve 改', '新しい自己紹介']);

    completed = true;
  } finally {
    console.log('');
    if (server) {
      server.kill('SIGTERM');
      await waitForPortFree(PORT, 6);
      if (!server.killed) {
        try { server.kill('SIGKILL'); } catch {}
      }
    }
    if (capture) capture.close();
  }

  [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
    for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  });

  console.log('');
  if (!completed) {
    console.error('❌ テストを最後まで実行できませんでした（上のエラーを確認してください）');
  } else if (failures === 0) {
    console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
  } else {
    console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
  }
  process.exit(completed && failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
