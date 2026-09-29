/**
 * 🧪 堅牢性の検査（複数プロセス・外部入力・大量配送に耐えるか）
 *
 * ここで守っているのは「静かに壊れないこと」です。どれも、動いているように見えたまま
 * 壊れる種類のもの（他のリクエストの書き込みが消える / 配送が無制限に走る / 予約投稿が
 * 二重に出る / 遅いクライアントでメモリが尽きる）を対象にしています。
 *
 *   1. SQLite のトランザクションが、await をまたいでも他のリクエストを巻き込まない
 *   2. Redis が無くても排他ロックが効く（DB のロック。予約投稿の二重公開を防ぐ）
 *   3. 予約投稿の「公開中」フラグは 1 プロセスしか立てられない（+ 落ちたぶんを戻す）
 *   4. 外向き fetch は 1 ホップずつ検証し、タイムアウトで必ず打ち切る
 *   5. SSE は上限で断り、溢れた接続を抱え込まない
 *   6. フォロワーへの配送は sharedInbox に集約し、同時実行数を絞る
 *   7. アンケート投票のトランザクション（上の 1 の実利用箇所）が二重集計しない
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

const ROOT_DIR = process.cwd();
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3791;
const BASE = `http://localhost:${PORT}`;
const REMOTE_PORT = PORT + 1;
const REMOTE = `http://127.0.0.1:${REMOTE_PORT}`;
const TEST_DB = 'data_test_hardening.sqlite';
const SQLITE_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);
/** PostgreSQL でも回す（トランザクション以外は同じコード。ロックと claim は特に確かめたい） */
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

// db.ts のグローバル接続を使う検査（DB ロック・予約投稿）があるので、読み込む前に決めておく。
// PostgreSQL のときは DB_PATH を触らない（子プロセスも同じ DB を見る）。
process.env.PORT = String(PORT);
process.env.DOMAIN = `localhost:${PORT}`;
process.env.PROTOCOL = 'http';
if (!USE_PG) process.env.DB_PATH = SQLITE_PATH;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 環境に合わせた DB ハンドル（PostgreSQL ならテスト用 DB、SQLite ならテスト用ファイル） */
const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: SQLITE_PATH });

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (ok) passed++;
  else failed++;
}

console.log('🧪 === 🛡 堅牢性（トランザクション / ロック / 配送 / SSE） ===');
console.log(`   port=${PORT} / 相手役=${REMOTE_PORT}\n`);

for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(path.resolve(ROOT_DIR, 'server', `${TEST_DB}${suffix}`), { force: true });
  } catch {
    // 消せなくても続行
  }
}

const procs: ChildProcess[] = [];
const sleepUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
};

let server: ChildProcess | null = null;
let serverLog = '';
function startNode(extraEnv: Record<string, string> = {}): ChildProcess {
  serverLog = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env: {
      ...(process.env as Record<string, string>),
      PORT: String(PORT),
      BIND_HOST: '127.0.0.1',
      AUTO_MAINTENANCE: 'false',
      AUTO_BACKUP: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  server = proc;
  proc.stdout?.on('data', (d) => (serverLog += d.toString()));
  proc.stderr?.on('data', (d) => (serverLog += d.toString()));
  return proc;
}

async function waitForHttp(timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch {
      // まだ起動していない
    }
    await sleep(300);
  }
  throw new Error(`ノードが起動しませんでした:\n${serverLog}`);
}

async function stopNode(): Promise<void> {
  const proc = server;
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  const deadline = Date.now() + 8000;
  while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  server = null;
}

/** 相手役のインスタンス（フォロワーがいる服务器のつもり） */
interface RemoteStats {
  shared: number;
  personal: number;
  byPath: Map<string, number>;
  inFlight: number;
  maxInFlight: number;
  total: number;
  bodies: string[];
}
const remote: RemoteStats = {
  shared: 0,
  personal: 0,
  byPath: new Map(),
  inFlight: 0,
  maxInFlight: 0,
  total: 0,
  bodies: [],
};
let remoteServer: http.Server | null = null;

function startRemoteServer(delayMs = 0): Promise<void> {
  remoteServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', REMOTE);
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST') {
        remote.total++;
        remote.byPath.set(url.pathname, (remote.byPath.get(url.pathname) ?? 0) + 1);
        if (url.pathname === '/inbox') remote.shared++;
        if (url.pathname.endsWith('/inbox') && url.pathname !== '/inbox' && !url.pathname.startsWith('/shared-')) {
          remote.personal++;
        }
        if (body) remote.bodies.push(body);
        remote.inFlight++;
        remote.maxInFlight = Math.max(remote.maxInFlight, remote.inFlight);
        setTimeout(() => {
          remote.inFlight--;
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end('{}');
        }, delayMs);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => remoteServer!.listen(REMOTE_PORT, '127.0.0.1', () => resolve()));
}

try {
  // ── 1. SQLite のトランザクションが他のリクエストを巻き込まない ──────
  console.log('── 1. トランザクションの隔離（SQLite）──────────');
  const txDb = createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', 'data_test_hardening_tx.sqlite') });
  await txDb.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, v TEXT)');
  await txDb.prepare('DELETE FROM t').run();

  // リクエスト A: トランザクションの中で 1 行入れて、await をまたいでから失敗する
  const requestA = txDb
    .transaction(async () => {
      await txDb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('a', 'A');
      await sleep(80); // ← ここでイベントループが回る（他のリクエストの文が入り込む隙）
      throw new Error('わざと失敗させています');
    })
    .catch(() => 'rolled-back');

  await sleep(20);
  // リクエスト B: A のトランザクションの途中で別の行を入れる
  const requestB = txDb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('b', 'B');

  const [outcomeA] = await Promise.all([requestA, requestB]);
  const rows = (await txDb.prepare('SELECT id FROM t ORDER BY id').all()) as { id: string }[];
  check('A はロールバックされた', outcomeA, 'rolled-back');
  check('B の書き込みは残っている（A のロールバックに巻き込まれない）', rows.map((r) => r.id), ['b']);

  // トランザクションが同時に 2 つ走っても、直列化されて両方成功する
  await txDb.prepare('DELETE FROM t').run();
  await Promise.all([
    txDb.transaction(async () => {
      await txDb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('c1', '1');
      await sleep(30);
      await txDb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('c2', '2');
    }),
    txDb.transaction(async () => {
      await txDb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('d1', '1');
      await sleep(30);
      await txDb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('d2', '2');
    }),
  ]);
  const bothRows = (await txDb.prepare('SELECT id FROM t ORDER BY id').all()) as { id: string }[];
  check('同時のトランザクションは直列化されて両方入る', bothRows.map((r) => r.id), ['c1', 'c2', 'd1', 'd2']);
  await txDb.close();

  // ── 2. Redis が無くても排他ロックが効く ─────────────────────
  console.log('\n── 2. 排他ロック（DB フォールバック）──────────');
  const dbModule = await import('../server/src/db.js');
  await dbModule.initDatabase();
  const { acquireDbLock, withDbLock, getDbLockOwner } = await import('../server/src/dbLock.js');
  const { runExclusively } = await import('../server/src/redis.js');

  const first = await acquireDbLock('hardening-test', 60_000);
  check('1 つ目は取れる', first.acquired, true);
  const second = await acquireDbLock('hardening-test', 60_000);
  check('2 つ目は取れない（別プロセスのつもり）', second.acquired, false);
  check('持ち主が記録されている', Boolean(await getDbLockOwner('hardening-test')), true);

  await first.release();
  const afterRelease = await acquireDbLock('hardening-test', 60_000);
  check('解放後は取れる', afterRelease.acquired, true);

  // 期限切れのロックは奪える（持ったまま落ちたプロセスのぶんを取り戻す）
  await dbModule.db
    .prepare('UPDATE app_locks SET expires_at = ? WHERE key = ?')
    .run(new Date(Date.now() - 1000).toISOString(), 'hardening-test');
  const takeover = await acquireDbLock('hardening-test', 60_000);
  check('期限切れのロックは奪える', takeover.acquired, true);
  await takeover.release();
  await afterRelease.release();

  // runExclusively は Redis が無くても 1 回だけ実行する（以前は毎回実行していた）
  let ranCount = 0;
  const runTwice = await Promise.all([
    runExclusively('hardening-exclusive', 30_000, async () => {
      ranCount++;
      await sleep(100);
    }),
    runExclusively('hardening-exclusive', 30_000, async () => {
      ranCount++;
      await sleep(100);
    }),
  ]);
  check('Redis 無しでも 1 回だけ実行される', ranCount, 1);
  check('実行した側だけ true', runTwice.filter(Boolean).length, 1);

  let withLockRan = 0;
  await Promise.all([
    withDbLock('hardening-with', 30_000, async () => {
      withLockRan++;
      await sleep(50);
    }),
    withDbLock('hardening-with', 30_000, async () => {
      withLockRan++;
      await sleep(50);
    }),
  ]);
  check('withDbLock も 1 回だけ', withLockRan, 1);

  // ── 3. 予約投稿の公開は 1 プロセスだけが宣言できる ──────────────
  console.log('\n── 3. 予約投稿の宣言（二重公開の防止）──────────');
  // 予約投稿には実在する利用者が要る（外部キー）。鍵は要らないのでダミーで入れる
  const now = new Date().toISOString();
  await dbModule.db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
       VALUES ('sp-user', 'SP User', '', 'dummy', 'user', 0, 'dummy', 'dummy', ?)`,
    )
    .run(now);
  await dbModule.db
    .prepare(
      "INSERT OR REPLACE INTO scheduled_posts (id, user_id, content, scheduled_at, status, created_at, updated_at) VALUES ('sp-test', 'sp-user', '予約投稿の検査', ?, 'pending', ?, ?)",
    )
    .run(now, now, now);
  const claim = () =>
    dbModule.db
      .prepare("UPDATE scheduled_posts SET status = 'publishing', updated_at = ? WHERE id = 'sp-test' AND status = 'pending'")
      .run(new Date().toISOString());
  check('1 回目は宣言できる', Number((await claim()).changes ?? 0), 1);
  check('2 回目は宣言できない（他のプロセスが先に取った）', Number((await claim()).changes ?? 0), 0);

  // 公開中にプロセスが落ちた行（古い 'publishing'）は、定期処理が待機中へ戻して拾い直す
  const { processScheduledPosts } = await import('../server/src/scheduler.js');
  await dbModule.db
    .prepare("UPDATE scheduled_posts SET status = 'publishing', updated_at = ? WHERE id = 'sp-test'")
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  await processScheduledPosts();
  const recovered = (await dbModule.db.prepare("SELECT status, published_post_id FROM scheduled_posts WHERE id = 'sp-test'").get()) as any;
  check('放置された公開中は拾い直されて公開される', recovered?.status, 'published');
  check('公開された投稿の ID が記録される', typeof recovered?.published_post_id === 'string' && recovered.published_post_id.length > 0, true);

  // もう一度回しても二重に公開しない
  await processScheduledPosts();
  const publishedCount = (await dbModule.db
    .prepare("SELECT COUNT(*) AS c FROM posts WHERE user_id = 'sp-user'")
    .get()) as { c: number };
  check('二度目は公開しない（投稿は 1 件のまま）', Number(publishedCount.c), 1);
  await dbModule.db.prepare("DELETE FROM scheduled_posts WHERE id = 'sp-test'").run();
  await dbModule.db.prepare("DELETE FROM posts WHERE user_id = 'sp-user'").run();
  await dbModule.db.prepare("DELETE FROM users WHERE id = 'sp-user'").run();

  // ── 4. 外向き fetch（1 ホップずつ検証・タイムアウト）──────────
  console.log('\n── 4. 外向き fetch の安全策 ──────────');
  await startRemoteServer();
  const { safeFetch } = await import('../server/src/remoteFetchGuard.js');

  // 302 で file: へ飛ばす（http/https 以外は、開発モードでも必ず拒否される）
  const hopServer = http.createServer((req, res) => {
    if (req.url === '/to-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    if (req.url === '/to-ok') {
      res.writeHead(302, { Location: `${HOP}/final` });
      res.end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { Location: `${HOP}/loop` });
      res.end();
      return;
    }
    if (req.url === '/slow') {
      // 何も返さない（黒穴）
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('final-body');
  });
  await new Promise<void>((resolve) => hopServer.listen(REMOTE_PORT + 1, '127.0.0.1', () => resolve()));
  const HOP = `http://127.0.0.1:${REMOTE_PORT + 1}`;

  const followed = await safeFetch(`${HOP}/to-ok`);
  check('リダイレクトは追う（GET）', await followed.text(), 'final-body');

  let refused = '';
  try {
    await safeFetch(`${HOP}/to-file`);
  } catch (err: any) {
    refused = String(err?.message || err);
  }
  check('リダイレクト先も検証する（file: は拒否）', refused.includes('安全でない'), true);

  let tooMany = '';
  try {
    await safeFetch(`${HOP}/loop`, { maxRedirects: 2 });
  } catch (err: any) {
    tooMany = String(err?.message || err);
  }
  check('リダイレクトの回数に上限がある', tooMany.includes('リダイレクト'), true);

  const startedAt = Date.now();
  let timedOut = '';
  try {
    await safeFetch(`${HOP}/slow`, { timeoutMs: 1000 });
  } catch (err: any) {
    timedOut = String(err?.name || err?.message || err);
  }
  const elapsed = Date.now() - startedAt;
  check('黒穴の相手でも打ち切る', elapsed < 5000, true);
  check('打ち切りは例外になる', timedOut.length > 0, true);

  // 署名した POST は（署名が宛先と食い違うので）リダイレクトを追わない
  const postRes = await safeFetch(`${HOP}/to-ok`, { method: 'POST', body: 'x' });
  check('POST は追わない（302 がそのまま返る）', postRes.status, 302);
  hopServer.close();
  remoteServer?.close();

  // ── 5. SSE の上限 ─────────────────────────────────────────
  console.log('\n── 5. SSE の上限（溢れたら断る）──────────');
  startNode({ SSE_MAX_CLIENTS: '2' });
  await waitForHttp();

  const openStream = async (): Promise<{ ok: boolean; status: number; body?: string }> => {
    const res = await fetch(`${BASE}/api/streaming?streams=local`, { headers: { Accept: 'text/event-stream' } });
    if (res.status !== 200) return { ok: false, status: res.status, body: await res.text() };
    // 開いたままにする（読まない）
    void res.body?.getReader().read();
    return { ok: true, status: res.status };
  };
  const s1 = await openStream();
  const s2 = await openStream();
  const s3 = await openStream();
  check('上限までは繋がる（1 本目）', s1.status, 200);
  check('上限までは繋がる（2 本目）', s2.status, 200);
  check('上限を超えると 503 で断る', s3.status, 503);
  check('断り方が「存在しない」ではない', String(s3.body || '').includes('混み合'), true);
  await sleep(300);
  const healthAtCap = (await (await fetch(`${BASE}/health`)).json()) as any;
  check('接続数が上限を超えていない', healthAtCap.sseClients, 2);

  // ── 6. フォロワー配送（sharedInbox への集約 + 同時実行数の制限）────
  console.log('\n── 6. フォロワー配送の形 ──────────');
  // 利用者を 1 人作る（配送の送信者になる）
  const registerRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'hardening-user', name: 'Hardening User', agreedToRules: true }),
  });
  const { sessionToken } = (await registerRes.json()) as { sessionToken?: string };
  check('利用者を作れる', Boolean(sessionToken), true);

  await stopNode();

  // フォロワーを直接入れる（同じサーバーのフォロワー 6 人 + 別々のサーバー 6 人）
  const seed = openDb();
  const nowIso = new Date().toISOString();
  for (let i = 0; i < 6; i++) {
    const actorUrl = `${REMOTE}/users/a${i}`;
    await seed
      .prepare(
        'INSERT OR REPLACE INTO remote_actors (id, username, domain, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(actorUrl, `a${i}`, '127.0.0.1', `${REMOTE}/users/a${i}/inbox`, `${REMOTE}/inbox`, `${actorUrl}#key`, 'dummy', nowIso);
    await seed
      .prepare('INSERT OR REPLACE INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(`f-a${i}`, actorUrl, `${BASE}/users/hardening-user`, `${REMOTE}/users/a${i}/inbox`, 'accepted', nowIso);
  }
  for (let i = 0; i < 6; i++) {
    const actorUrl = `${REMOTE}/users/b${i}`;
    await seed
      .prepare(
        'INSERT OR REPLACE INTO remote_actors (id, username, domain, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(actorUrl, `b${i}`, '127.0.0.1', `${REMOTE}/users/b${i}/inbox`, `${REMOTE}/shared-${i}/inbox`, `${actorUrl}#key`, 'dummy', nowIso);
    await seed
      .prepare('INSERT OR REPLACE INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(`f-b${i}`, actorUrl, `${BASE}/users/hardening-user`, `${REMOTE}/users/b${i}/inbox`, 'accepted', nowIso);
  }
  await seed.close();

  // 配送の同時実行数を 2 に絞り、相手は 150ms かかるサーバーにする
  await startRemoteServer(150);
  startNode({ DELIVERY_CONCURRENCY: '2', SSE_MAX_CLIENTS: '2' });
  await waitForHttp();

  const postRes2 = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content: '配送の形を確かめる投稿' }),
  });
  check('投稿できる', [200, 201].includes(postRes2.status), true);

  const delivered = await sleepUntil(() => remote.total >= 7, 30000);
  check('全員ぶんが配送される（同じサーバーは 1 本に集約）', remote.total, 7);
  check('同じサーバーのフォロワー 6 人は共有 inbox に 1 回だけ', remote.byPath.get('/inbox'), 1);
  check('個人 inbox には送らない', remote.personal, 0);
  check('別々のサーバーは 6 回', [0, 1, 2, 3, 4, 5].map((i) => remote.byPath.get(`/shared-${i}/inbox`)), [1, 1, 1, 1, 1, 1]);
  check('同時実行数は設定した 2 以下', remote.maxInFlight <= 2, true);
  check('配送は実行された（待ち時間を含む）', delivered && remote.maxInFlight >= 2, true);
  check('署名付きの POST が届いている', remote.bodies.some((b) => b.includes('hardening-user')), true);

  // ── 7. アンケート投票のトランザクション ──────────────────────
  console.log('\n── 7. アンケート投票（トランザクションの実利用）──────────');
  const pollRes = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content: 'アンケート', poll: { choices: ['A', 'B', 'C'], multiple: true, expiresIn: 3600 } }),
  });
  const pollPost = (await pollRes.json()) as any;
  check('アンケート付きで投稿できる', Boolean(pollPost?.id), true);

  // 2 択に同時に投票する（トランザクションの中で 2 行入る）
  const voteRes = await fetch(`${BASE}/api/posts/${encodeURIComponent(pollPost.id)}/poll/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ choices: [0, 2] }),
  });
  check('投票できる', voteRes.status, 200);

  const voteDb = openDb();
  // アンケート本体の ID は投稿 ID とは別（polls.post_id で引く）
  const pollRow = (await voteDb.prepare('SELECT id FROM polls WHERE post_id = ?').get(pollPost.id)) as { id: string } | undefined;
  check('アンケートが保存されている', Boolean(pollRow?.id), true);
  const votes = (await voteDb
    .prepare('SELECT choice_index FROM poll_votes WHERE poll_id = ? ORDER BY choice_index')
    .all(pollRow?.id)) as { choice_index: number }[];
  check('選んだ 2 つだけが入る（二重に入らない）', votes.map((v) => v.choice_index), [0, 2]);
  const counts = (await voteDb
    .prepare('SELECT choice_index, votes_count FROM poll_choices WHERE poll_id = ? ORDER BY choice_index')
    .all(pollRow?.id)) as { choice_index: number; votes_count: number }[];
  check('集計も 2 つだけ +1 されている', counts.map((c) => c.votes_count), [1, 0, 1]);
  await voteDb.close();
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  console.error(serverLog.slice(-2000));
  failed++;
} finally {
  remoteServer?.close();
  for (const proc of procs) {
    if (proc.exitCode === null) {
      proc.kill();
      const deadline = Date.now() + 8000;
      while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
  if (!USE_PG) {
    for (const suffix of ['', '-wal', '-shm']) {
      for (const name of [TEST_DB, 'data_test_hardening_tx.sqlite']) {
        try {
          fs.rmSync(path.resolve(ROOT_DIR, 'server', `${name}${suffix}`), { force: true });
        } catch {
          // 消せなくても続行
        }
      }
    }
  }
}

console.log('\n====================================================');
console.log(`  成功 ${passed} / 失敗 ${failed}`);
if (failed > 0) {
  console.log('❌ 堅牢性の検査: 失敗がありました');
  process.exit(1);
}
console.log('🎊 堅牢性の検査: すべて成功');

// この検査はアプリのモジュール（定期処理・ストリーミング）を読み込むので、
// ハートビートの interval が残ってプロセスが終わらない。後始末をして明示的に終える。
try {
  const { db } = await import('../server/src/db.js');
  await db.checkpoint().catch(() => {});
  await db.close().catch(() => {});
} catch {
  // すでに閉じている
}
process.exit(0);
