/**
 * 🧪 プロセスの役割（PROCESS_ROLE）の検証
 *
 * Spica は既定で「HTTP も定期処理も 1 プロセス」で動くが、`PROCESS_ROLE` で分けられる。
 * 分けたときに**取り違えが起きないこと**をここで確かめる（docs/ARCHITECTURE.md）。
 *
 *   1. web    … HTTP を開き、定期処理（予約投稿・配送再送・ジョブ）は動かさない
 *   2. worker … HTTP を開かず（ポートを掴まず）、定期処理だけを動かす
 *   3. all    … 未設定のときは今までどおり 1 プロセスで両方やる（既定の回帰確認）
 *   4. PostgreSQL（同じ DB を共有）のときだけ、web 1 + worker 2 を**同時に**動かし、
 *      積まれた仕事がちょうど 1 回だけ実行されることを確かめる
 *
 * SQLite のときは同じファイルを同時に開かない（web を止めてから worker を起動する）。
 * 1 ファイルを複数プロセスで共有するのは SQLite の想定外の使い方なので、無理に試さない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase, type AsyncSpicaDatabase } from '../server/src/db/asyncDriver.js';

const ROOT_DIR = process.cwd();
const BASE_PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3781;
const WEB_PORT = BASE_PORT;
const WORKER_PORT = BASE_PORT + 1;
const ALL_PORT = BASE_PORT + 2;

const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);
/** 定期処理の間隔。短くして検査を速くする（既定は 予約 10 秒 / 配送 60 秒 / ジョブ 15 秒） */
const INTERVAL_MS = 2000;
/** 「動かなかった」と判断するまでに待つ時間（間隔の 3 倍 + 余裕） */
const QUIET_WAIT_MS = INTERVAL_MS * 3 + 1500;

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

const sqlitePath = (name: string) => path.resolve(ROOT_DIR, 'server', `data_test_roles_${name}.sqlite`);

console.log('🧪 === 🧩 プロセスの役割（PROCESS_ROLE） ===');
console.log(`   web=${WEB_PORT} / worker=${WORKER_PORT} / all=${ALL_PORT}`);
console.log(`   DB: ${USE_PG ? 'PostgreSQL（同じ DB を共有）' : 'SQLite（同じファイルを役割ごとに順に使う）'}\n`);

for (const name of ['shared', 'all']) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${sqlitePath(name)}${suffix}`, { force: true });
    } catch {
      // 消せなくても続行
    }
  }
}

const procs: ChildProcess[] = [];

/** 起動するノードの環境変数。役割以外は全部同じにする */
function nodeEnv(options: { role?: string; port: number; dbName: string }): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(options.port),
    BIND_HOST: '127.0.0.1',
    DOMAIN: `localhost:${options.port}`,
    PROTOCOL: 'http',
    INSTANCE_NAME: `ROLES ${options.role || 'all'}`,
    SCHEDULER_INTERVAL_MS: String(INTERVAL_MS),
    DELIVERY_INTERVAL_MS: String(INTERVAL_MS),
    JOB_INTERVAL_MS: String(INTERVAL_MS),
    AUTO_MAINTENANCE: 'false',
    AUTO_BACKUP: 'false',
  };
  delete env.RATE_LIMIT_DISABLED;
  if (options.role) env.PROCESS_ROLE = options.role;
  else delete env.PROCESS_ROLE;
  if (USE_PG) {
    env.DB_DRIVER = 'postgres';
    env.DATABASE_URL = process.env.TEST_DATABASE_URL as string;
    delete env.DB_PATH;
  } else {
    env.DB_PATH = sqlitePath(options.dbName);
    delete env.DB_DRIVER;
    delete env.DATABASE_URL;
  }
  return env;
}

interface Node {
  proc: ChildProcess;
  log: () => string;
}

function spawnNode(env: Record<string, string>): Node {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  let log = '';
  proc.stdout?.on('data', (d) => (log += d.toString()));
  proc.stderr?.on('data', (d) => (log += d.toString()));
  return { proc, log: () => log };
}

/** ログに現れるのを待つ（HTTP を開かない worker の起動確認に使う） */
async function waitForLog(node: Node, pattern: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (node.log().includes(pattern)) return;
    if (node.proc.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`ログに現れませんでした: ${pattern}\n--- 出力 ---\n${node.log()}`);
}

async function waitForHttp(port: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch {
      // まだ起動していない
    }
    await sleep(300);
  }
  throw new Error(`ノード (${port}) が起動しませんでした`);
}

async function stopNode(node: Node): Promise<void> {
  if (node.proc.exitCode !== null) return;
  node.proc.kill();
  const deadline = Date.now() + 8000;
  while (node.proc.exitCode === null && Date.now() < deadline) await sleep(100);
  if (node.proc.exitCode === null) node.proc.kill('SIGKILL');
}

/**
 * テストプロセスから直接 DB を見る。
 * SQLite のときは 1 回ごとに開いて閉じる（開きっぱなしでノードと 2 プロセスにしない）。
 */
async function withDb<T>(dbName: string, fn: (handle: AsyncSpicaDatabase) => Promise<T>): Promise<T> {
  const handle = USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ dbPath: sqlitePath(dbName) });
  try {
    return await fn(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}

interface JobRow {
  id: string;
  attempts: number;
  status: string;
}

/** 検査で積んだぶんだけを見る（payload の URL に検査ごとの印を入れてある） */
async function readPreviewJobs(handle: AsyncSpicaDatabase, marker: string): Promise<JobRow[]> {
  return (await handle
    .prepare("SELECT id, attempts, status FROM jobs WHERE kind = 'link_preview' AND payload LIKE ? ORDER BY created_at")
    .all(`%${marker}%`)) as JobRow[];
}

/** うまくいかなかったときに理由が分かるよう、時刻まで出して並べる */
async function dumpPreviewJobs(handle: AsyncSpicaDatabase, marker: string): Promise<string> {
  const rows = (await handle
    .prepare(
      "SELECT id, attempts, status, next_attempt_at, updated_at, last_error FROM jobs WHERE kind = 'link_preview' AND payload LIKE ? ORDER BY created_at",
    )
    .all(`%${marker}%`)) as any[];
  return rows
    .map((r) => `      ${r.id} attempts=${r.attempts} status=${r.status} next=${r.next_attempt_at} updated=${r.updated_at} err=${r.last_error}`)
    .join('\n');
}

/** ジョブが積まれるのを待つ（投稿時の即時取得が失敗してから積まれる） */
async function waitForJobs(dbName: string, marker: string, expected: number, timeoutMs = 20000): Promise<JobRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: JobRow[] = [];
  while (Date.now() < deadline) {
    rows = await withDb(dbName, (handle) => readPreviewJobs(handle, marker));
    if (rows.length >= expected) return rows;
    await sleep(500);
  }
  return rows;
}

/** すべてのジョブが条件を満たすまで待つ（満たした時点の行を返す） */
async function waitForJobsSatisfying(
  dbName: string,
  marker: string,
  count: number,
  predicate: (rows: JobRow[]) => boolean,
  timeoutMs = 25000,
): Promise<JobRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: JobRow[] = [];
  while (Date.now() < deadline) {
    rows = await withDb(dbName, (handle) => readPreviewJobs(handle, marker));
    if (rows.length >= count && predicate(rows)) return rows;
    await sleep(500);
  }
  return rows;
}

/**
 * 利用者を 1 人作って URL 付きの投稿を 1 件する。
 * 戻り値はジョブを見分けるための印（投稿本文の URL に入る）。
 */
async function registerAndPost(port: number, prefix: string, count = 1): Promise<string> {
  const stamp = `${prefix}-${Date.now().toString(36)}`;
  const registerRes = await fetch(`http://localhost:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `role-${stamp}`, name: `Role ${stamp}`, agreedToRules: true }),
  });
  const { sessionToken } = (await registerRes.json()) as { sessionToken?: string };
  if (!sessionToken) throw new Error(`登録できませんでした (${registerRes.status})`);

  for (let i = 0; i < count; i++) {
    const postRes = await fetch(`http://localhost:${port}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ content: `役割の検査 ${i} https://example.invalid/${stamp}-${i}` }),
    });
    if (postRes.status !== 200 && postRes.status !== 201) {
      throw new Error(`投稿できませんでした (${postRes.status})`);
    }
  }
  return stamp;
}

try {
  // ── 0. 同時起動（インスタンス鍵の競合）──────────────────────
  console.log('── 0. 2 プロセスを同時に起動する ──────────');
  if (!USE_PG) {
    skip(
      '同じ DB を 2 プロセスで同時に立ち上げる検査',
      'SQLite は 1 ファイルを同時に開かない方針（PostgreSQL で回すと実行される）',
    );
  } else {
    // 同じ DB を 2 プロセスが同時に立ち上げる。インスタンス鍵は起動時に 1 度だけ作るので、
    // ここが競合すると鍵が 2 つになる（片方で署名した Activity が相手に通らなくなる）
    const racePortA = BASE_PORT + 3;
    const racePortB = BASE_PORT + 4;
    const raceA = spawnNode(nodeEnv({ role: 'web', port: racePortA, dbName: 'pg' }));
    const raceB = spawnNode(nodeEnv({ role: 'web', port: racePortB, dbName: 'pg' }));
    await Promise.all([waitForHttp(racePortA), waitForHttp(racePortB)]);

    const actorA = (await (await fetch(`http://localhost:${racePortA}/actor`)).json()) as any;
    const actorB = (await (await fetch(`http://localhost:${racePortB}/actor`)).json()) as any;
    check('同時でも両方立ち上がる', [actorA.type, actorB.type], ['Application', 'Application']);
    check(
      'インスタンス鍵は 1 つに落ち着く（同じ公開鍵を配る）',
      actorA.publicKey?.publicKeyPem === actorB.publicKey?.publicKeyPem &&
        typeof actorA.publicKey?.publicKeyPem === 'string',
      true,
    );
    await stopNode(raceA);
    await stopNode(raceB);
  }

  // ── 1. PROCESS_ROLE=web ───────────────────────────────────
  console.log('── 1. PROCESS_ROLE=web（HTTP だけ）──────────');
  const web = spawnNode(nodeEnv({ role: 'web', port: WEB_PORT, dbName: 'shared' }));
  await waitForHttp(WEB_PORT);

  const webHealth = (await (await fetch(`http://localhost:${WEB_PORT}/health`)).json()) as any;
  check('web は HTTP を開く', webHealth.status, 'ok');
  check('/health が役割を返す', webHealth.role, 'web');
  check('起動バナーに役割が出る', web.log().includes('🧩 Role: web'), true);
  check('予約投稿ワーカーを起動しない', web.log().includes('[Scheduler]'), false);
  check('配送再送ワーカーを起動しない', web.log().includes('[Delivery Queue]'), false);
  check('ジョブワーカーを起動しない', web.log().includes('[Jobs]'), false);

  const webMark = await registerAndPost(WEB_PORT, 'web');
  const seeded = await waitForJobs('shared', webMark, 1);
  check('投稿でプレビュー取得のジョブが積まれる', seeded.length >= 1, true);
  check('積まれた直後は未実行', seeded[0]?.attempts, 0);

  await sleep(QUIET_WAIT_MS);
  const whileWebRuns = await withDb('shared', (handle) => readPreviewJobs(handle, webMark));
  check('web は積まれた仕事を実行しない', whileWebRuns[0]?.attempts, 0);
  check('状態は pending のまま', whileWebRuns[0]?.status, 'pending');
  await stopNode(web);

  // ── 2. PROCESS_ROLE=worker（同じ DB）────────────────────────
  console.log('\n── 2. PROCESS_ROLE=worker（定期処理だけ）──────────');
  const worker = spawnNode(nodeEnv({ role: 'worker', port: WORKER_PORT, dbName: 'shared' }));
  await waitForLog(worker, '🧰 Spica worker is running!');

  check('worker の起動バナーが出る', worker.log().includes('PROCESS_ROLE=worker'), true);
  check('worker は HTTP のバナーを出さない', worker.log().includes('✨ Spica is running!'), false);
  check('予約投稿ワーカーを起動する', worker.log().includes('[Scheduler]'), true);
  check('配送再送ワーカーを起動する', worker.log().includes('[Delivery Queue]'), true);
  check('ジョブワーカーを起動する', worker.log().includes('[Jobs]'), true);

  const workerPortOpen = await fetch(`http://localhost:${WORKER_PORT}/health`).then(
    () => true,
    () => false,
  );
  check('worker はポートを掴まない（HTTP を開かない）', workerPortOpen, false);

  const picked = await waitForJobsSatisfying('shared', webMark, 1, (rows) => rows[0]?.attempts >= 1);
  check('worker が web の積んだ仕事を実行する', (picked[0]?.attempts ?? 0) >= 1, true);
  check('実行したのは 1 回だけ', picked[0]?.attempts, 1);
  await stopNode(worker);

  // ── 3. 既定（PROCESS_ROLE 未設定 = all）─────────────────────
  console.log('\n── 3. 既定（all・今までどおり）──────────');
  const all = spawnNode(nodeEnv({ port: ALL_PORT, dbName: 'all' }));
  await waitForHttp(ALL_PORT);

  const allHealth = (await (await fetch(`http://localhost:${ALL_PORT}/health`)).json()) as any;
  check('未設定なら役割は all', allHealth.role, 'all');
  check('HTTP を開く', allHealth.status, 'ok');
  check('予約投稿ワーカーを起動する', all.log().includes('[Scheduler]'), true);
  check('配送再送ワーカーを起動する', all.log().includes('[Delivery Queue]'), true);
  check('ジョブワーカーを起動する', all.log().includes('[Jobs]'), true);

  const allMark = await registerAndPost(ALL_PORT, 'all');
  const allJobs = await waitForJobsSatisfying('all', allMark, 1, (rows) => rows[0]?.attempts >= 1);
  check('1 プロセスでも自分の仕事を実行する', (allJobs[0]?.attempts ?? 0) >= 1, true);
  await stopNode(all);

  // ── 4. web 1 + worker 2 の同時運転（PostgreSQL のみ）─────────
  console.log('\n── 4. web 1 + worker 2 の同時運転 ──────────');
  if (!USE_PG) {
    skip(
      '同じ DB を共有して同時に動かす検査',
      'SQLite は 1 ファイルを同時に開かない方針（PostgreSQL で回すと実行される）',
    );
  } else {
    const web2 = spawnNode(nodeEnv({ role: 'web', port: WEB_PORT, dbName: 'pg' }));
    const workerA = spawnNode(nodeEnv({ role: 'worker', port: WORKER_PORT, dbName: 'pg' }));
    const workerB = spawnNode(nodeEnv({ role: 'worker', port: WORKER_PORT + 1, dbName: 'pg' }));
    await waitForHttp(WEB_PORT);
    await waitForLog(workerA, '🧰 Spica worker is running!');
    await waitForLog(workerB, '🧰 Spica worker is running!');

    // web 側で 4 件積む（URL を変えて dedupe に当たらないようにする）
    const pgStart = Date.now();
    const pgMark = await registerAndPost(WEB_PORT, 'pg', 4);
    const fourJobs = await waitForJobs('pg', pgMark, 4);
    check('web が積んだ 4 件が worker から見える', fourJobs.length, 4);
    const allQueuedAt = Date.now();

    const claimed = await waitForJobsSatisfying('pg', pgMark, 4, (rows) => rows.every((r) => r.attempts >= 1));
    check('2 つの worker がすべて実行する', claimed.every((r) => r.attempts >= 1), true);
    const allClaimedAt = Date.now();

    // 1 回実行すると次の試行は 30 秒後（バックオフ）。その間に二重実行が無いことを確かめる
    await sleep(INTERVAL_MS * 3);
    const after = await withDb('pg', (handle) => readPreviewJobs(handle, pgMark));
    const attempts = after.map((r) => r.attempts);
    console.log(
      `     （積み終わり ${allQueuedAt - pgStart}ms / 全部が実行されるまで ${allClaimedAt - allQueuedAt}ms / 確認まで ${Date.now() - allClaimedAt}ms）`,
    );
    if (attempts.some((a) => a !== 1)) {
      console.log('     内訳:');
      console.log(await withDb('pg', (handle) => dumpPreviewJobs(handle, pgMark)));
    }
    check('同じ仕事を二重に実行しない（試行回数は 1 のまま）', attempts, [1, 1, 1, 1]);

    const webStillOk = (await (await fetch(`http://localhost:${WEB_PORT}/health`)).json()) as any;
    check('worker が動いている間も web は応答する', webStillOk.status, 'ok');
    check('web の役割は web のまま', webStillOk.role, 'web');

    await stopNode(web2);
    await stopNode(workerA);
    await stopNode(workerB);
  }
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  failed++;
} finally {
  for (const proc of procs) {
    if (proc.exitCode === null) {
      proc.kill();
      const deadline = Date.now() + 8000;
      while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
  if (!USE_PG) {
    for (const name of ['shared', 'all']) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${sqlitePath(name)}${suffix}`, { force: true });
        } catch {
          // 消せなくても続行
        }
      }
    }
  }
}

console.log('\n====================================================');
console.log(`  成功 ${passed} / 失敗 ${failed}${skipped ? ` / スキップ ${skipped}` : ''}`);
if (failed > 0) {
  console.log('❌ プロセスの役割テスト: 失敗がありました');
  process.exit(1);
}
console.log('🎊 プロセスの役割テスト: すべて成功');
