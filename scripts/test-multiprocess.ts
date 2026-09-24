/**
 * 🧪 2 プロセス（同一ノード）の統合検証
 *
 * 「複数プロセスで動かす」ための仕組みは単体では検査済みだが、**実際に 2 つのノードを並べて**
 * 確かめたことは無かった。このスイートがそれをやる。
 *
 *   1. 2 つのノードが同じ DB を見て起動する（`/health` が両方 ok）
 *   2. レート制限がプロセスをまたいで共有される（Redis が必要）
 *   3. リアルタイム更新（SSE）がプロセスをまたぐ（Redis が必要）
 *   4. 設定の変更が他プロセスへ伝わる（Redis が必要・同じ DB が必要）
 *   5. **予約投稿が二重に公開されない**（Redis のロック。同じ DB が必要）
 *   6. **配送が二重に送られない**（DB の条件付き UPDATE。同じ DB が必要）
 *
 * 前提: PostgreSQL（`DB_DRIVER=postgres` + `TEST_DATABASE_URL`）なら同じ DB を共有して全項目。
 * SQLite のときはノードごとに別ファイルを使い、共有 DB が要る項目はスキップする
 * （SQLite を 2 プロセスで共有するのは想定外の使い方なので、無理に試さない）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

const ROOT_DIR = process.cwd();
const PORT_A = 3771;
const PORT_B = 3772;
const INBOX_PORT = 3773;
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
const TEST_REDIS_URL = (process.env.TEST_REDIS_URL || '').trim();
const USE_PG = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);
/** 同じ DB を 2 プロセスで見るのは PostgreSQL のときだけ（SQLite はノードごとに分ける） */
const SHARED_DB = USE_PG;
const PREFIX = `spicemtest${process.pid}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (ok) passed++;
  else failed++;
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`  ⏭️  ${name}: スキップ（${reason}）`);
}

/**
 * `/api/auth` への請求回数を数える（レート制限は 20 回/分で、登録も 1 回として数えられる）。
 * レート制限の検査は**最後**に置く（実行するとその窓が埋まるため）。
 */
let authRequestCount = 0;
async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  authRequestCount++;
  return fetch(url, init);
}

const sqlitePath = (suffix: string) => path.resolve(ROOT_DIR, 'server', `data_test_mp_${suffix}.sqlite`);

console.log('🧪 === 🧵 2 プロセス（同一ノード）の統合検証 ===');
console.log(`   A=${PORT_A} / B=${PORT_B}`);
console.log(`   DB: ${USE_PG ? 'PostgreSQL（2 プロセスで共有）' : 'SQLite（ノードごとに別ファイル）'}`);
console.log(`   Redis: ${TEST_REDIS_URL ? 'あり（プロセス間で共有）' : 'なし'}\n`);

for (const f of ['a', 'b']) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${sqlitePath(f)}${suffix}`, { force: true });
    } catch {
      // 消せなくても続行
    }
  }
}

const procs: ChildProcess[] = [];
let inboxHits = 0;
let inboxServer: http.Server | null = null;

/** 配送先の偽 inbox（何回叩かれたかを数える） */
function startInboxServer(): Promise<void> {
  return new Promise((resolve) => {
    inboxServer = http.createServer((req, res) => {
      if (req.method === 'POST') inboxHits++;
      req.resume();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    inboxServer.listen(INBOX_PORT, '127.0.0.1', () => resolve());
  });
}

function nodeEnv(port: number, dbSuffix: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DOMAIN: `localhost:${port}`,
    PROTOCOL: 'http',
    INSTANCE_NAME: `MP ${port}`,
    AUTO_MAINTENANCE: 'false',
    AUTO_BACKUP: 'false',
    ...(TEST_REDIS_URL ? { REDIS_URL: TEST_REDIS_URL, REDIS_PREFIX: PREFIX } : {}),
  };
  delete env.RATE_LIMIT_DISABLED; // レート制限を効かせて共有を確かめる
  if (USE_PG) {
    env.DB_DRIVER = 'postgres';
    env.DATABASE_URL = process.env.TEST_DATABASE_URL as string;
  } else {
    env.DB_PATH = sqlitePath(dbSuffix);
    delete env.DB_DRIVER;
    delete env.DATABASE_URL;
  }
  return env;
}

async function startNode(port: number, dbSuffix: string): Promise<{ proc: ChildProcess; log: () => string }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env: nodeEnv(port, dbSuffix),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  let log = '';
  proc.stdout?.on('data', (d) => (log += d.toString()));
  proc.stderr?.on('data', (d) => (log += d.toString()));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.status === 200 || res.status === 503) return { proc, log: () => log };
    } catch {
      // まだ起動していない
    }
    await sleep(300);
  }
  throw new Error(`ノード (${port}) が起動しませんでした:\n${log}`);
}

/** SSE を開いて、条件に合うイベントが来るまで読む */
async function waitForSseNote(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    const reader = res.body?.getReader();
    if (!reader) return false;
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += Buffer.from(value).toString('utf8');
      if (buffer.includes('event: note')) return true;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// 共有 DB を直接見るためのハンドル（投入と確認に使う。アプリとは別の接続）
const seedDb = createAsyncDatabase({
  driver: USE_PG ? 'postgres' : undefined,
  connectionString: USE_PG ? (process.env.TEST_DATABASE_URL as string) : undefined,
  dbPath: sqlitePath('a'),
});

try {
  await startInboxServer();
  const a = await startNode(PORT_A, 'a');
  const b = await startNode(PORT_B, 'b');

  // ── 1. 2 つのノードが起動する ─────────────────────────────
  console.log('── 1. 2 ノードの起動 ──────────');
  const healthA = (await (await fetch(`${BASE_A}/health`)).json()) as any;
  const healthB = (await (await fetch(`${BASE_B}/health`)).json()) as any;
  check('A が応答する', healthA.status, 'ok');
  check('B が応答する', healthB.status, 'ok');
  if (TEST_REDIS_URL) {
    check('A が Redis に繋がっている', healthA.redis?.ready, true);
    check('B が Redis に繋がっている', healthB.redis?.ready, true);
    check('2 ノードが同じ接頭辞を使う', [healthA.redis?.prefix, healthB.redis?.prefix], [PREFIX, PREFIX]);
  } else {
    skip('Redis の接続確認', 'TEST_REDIS_URL 未設定');
  }

  // 管理者を 1 人作る（セッションは DB にあるので B でも使える）
  const registerRes = await authFetch(`${BASE_A}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'mp-admin', name: 'MP Admin', agreedToRules: true }),
  });
  const sessionToken = ((await registerRes.json()) as any).sessionToken as string;
  check('A で登録できた', Boolean(sessionToken), true);

  // ── 2. SSE がプロセスをまたぐ ─────────────────────────────
  console.log('\n── 2. リアルタイム更新（プロセスをまたぐ）──────────');
  if (TEST_REDIS_URL) {
    // 共有 DB なら A のセッションで B にも投稿できる。別 DB のときは B 側にも利用者を作る
    let posterToken = sessionToken;
    if (!SHARED_DB) {
      const regB = await authFetch(`${BASE_B}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'mp-admin-b', name: 'MP Admin B', agreedToRules: true }),
      });
      posterToken = ((await regB.json()) as any).sessionToken as string;
      check('B でも登録できる', Boolean(posterToken), true);
    }
    const ssePromise = waitForSseNote(`${BASE_A}/api/streaming?streams=local`, 10000);
    await sleep(500); // SSE の登録待ち
    const postRes = await fetch(`${BASE_B}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${posterToken}` },
      body: JSON.stringify({ content: `プロセスをまたぐ配信の検証 ${Date.now()}` }),
    });
    check('B で投稿できる', postRes.ok, true);
    check('B の投稿が A の SSE に届く', await ssePromise, true);
  } else {
    skip('SSE の越境配信', 'TEST_REDIS_URL 未設定');
  }

  // ── 3. 設定の変更が他プロセスへ伝わる ─────────────────────
  console.log('\n── 3. 設定の反映（プロセスをまたぐ）──────────');
  if (TEST_REDIS_URL && SHARED_DB) {
    const beforeB = (await (await fetch(`${BASE_B}/api/server-info`)).json()) as any;
    const newName = `MP Test ${Date.now()}`;
    const setRes = await fetch(`${BASE_A}/api/admin/server-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ name: newName }),
    });
    check('A で設定を変更できた', setRes.ok, true);
    await sleep(1500); // 通知 → 読み直し
    const afterB = (await (await fetch(`${BASE_B}/api/server-info`)).json()) as any;
    check('B の応答が変わった（通知で読み直した）', afterB.name, newName);
    check('変更前は別の名前だった', beforeB.name !== newName, true);
  } else {
    skip('設定の反映', TEST_REDIS_URL ? '同じ DB を見ていない（SQLite はノードごとに別ファイル）' : 'TEST_REDIS_URL 未設定');
  }

  // ── 4. 予約投稿が二重に公開されない ───────────────────────
  console.log('\n── 4. 予約投稿（二重公開しない）──────────');
  if (TEST_REDIS_URL && SHARED_DB) {
    const marker = `予約投稿の二重公開チェック ${Date.now()}`;
    const nowIso = new Date(Date.now() - 60_000).toISOString(); // 1 分前に予約したことにする
    await seedDb
      .prepare(
        `INSERT INTO scheduled_posts (id, user_id, content, visibility, scheduled_at, status, created_at)
         VALUES (?, ?, ?, 'public', ?, 'pending', ?)`,
      )
      .run(`mp_sched_${Date.now()}`, 'mp-admin', marker, nowIso, nowIso);
    // スケジューラは 10 秒間隔。両方のノードが同じ予約を見ているので、ロックが無ければ二重投稿になる
    await sleep(16000);
    const count = (await seedDb.prepare('SELECT COUNT(*) AS c FROM posts WHERE content = ?').get(marker)) as { c: number };
    check('公開されたのは 1 回だけ', Number(count.c), 1);
    check('A のログに二重公開が無い', a.log().includes('[Scheduler] ✅ Scheduled post published'), true);
  } else {
    skip('予約投稿の二重公開', SHARED_DB ? 'TEST_REDIS_URL 未設定' : '同じ DB を見ていない');
  }

  // ── 5. 配送が二重に送られない ─────────────────────────────
  console.log('\n── 5. 配送の二重送信（条件付き UPDATE）──────────');
  if (SHARED_DB) {
    const nowIso = new Date().toISOString();
    await seedDb
      .prepare(
        `INSERT INTO outbox_deliveries (id, activity_id, activity_type, inbox_url, activity, sender_user_id, use_instance_actor, attempts, next_attempt_at, status, created_at, updated_at)
         VALUES (?, '', 'Create', ?, ?, NULL, 1, 1, ?, 'pending', ?, ?)`,
      )
      .run(
        `mp_delivery_${Date.now()}`,
        `http://127.0.0.1:${INBOX_PORT}/inbox`,
        JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Create', actor: `${BASE_A}/users/mp-admin` }),
        nowIso,
        nowIso,
        nowIso,
      );
    // 両ノードに「いますぐ再送」を同時に投げる
    const adminToken = sessionToken;
    inboxHits = 0;
    await Promise.all(
      [BASE_A, BASE_B].map((base) =>
        fetch(`${base}/api/admin/delivery-queue/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: '{}',
        }),
      ),
    );
    await sleep(3000);
    check('偽 inbox が叩かれたのは 1 回だけ', inboxHits, 1);
    const delivered = (await seedDb.prepare("SELECT COUNT(*) AS c FROM outbox_deliveries WHERE status = 'delivered'").get()) as { c: number };
    check('配信済みになっている', Number(delivered.c) >= 1, true);
  } else {
    skip('配送の二重送信', '同じ DB を見ていない（SQLite はノードごとに別ファイル）');
  }
  // ── 6. レート制限がプロセスをまたいで共有される（最後に実行する）──────
  console.log('\n── 6. レート制限（プロセス間の共有）──────────');
  if (TEST_REDIS_URL) {
    const login = (base: string) =>
      authFetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }),
      });
    // 上限は 20 回/分（同じ IP・同じ接頭辞）。登録で使った分を差し引いた数だけ通る
    const expectedAllowed = Math.max(20 - authRequestCount, 0);
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push((await login(BASE_A)).status);
      if (statuses[statuses.length - 1] === 429) break;
    }
    check(`登録の分を除いて上限まで通る（${expectedAllowed} 回）`, statuses.filter((s) => s !== 429).length, expectedAllowed);
    check('上限を超えると 429', statuses[statuses.length - 1], 429);
    check('B でも 429（カウンタが共有されている）', (await login(BASE_B)).status, 429);
  } else {
    skip('レート制限の共有', 'Redis が無いと共有できない（既定のドキュメントどおり）');
  }
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  failed++;
} finally {
  for (const proc of procs) {
    if (proc.exitCode === null) {
      proc.kill();
    }
  }
  for (const proc of procs) {
    const deadline = Date.now() + 8000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  if (inboxServer) await new Promise<void>((resolve) => inboxServer!.close(() => resolve()));
  try {
    await seedDb.close();
  } catch {
    // 握る
  }
  for (const f of ['a', 'b']) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${sqlitePath(f)}${suffix}`, { force: true });
      } catch {
        // 消せなくても続行
      }
    }
  }
}

console.log('');
console.log('====================================================');
if (failed === 0) {
  console.log(`🎊 2 プロセスの統合検証: ${passed} 件成功${skipped > 0 ? `（${skipped} 件スキップ）` : ''}`);
  process.exit(0);
}
console.log(`❌ ${passed} 件成功 / ${failed} 件失敗`);
process.exit(1);
