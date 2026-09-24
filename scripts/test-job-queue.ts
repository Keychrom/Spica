/**
 * 🧪 ジョブキュー・配送の割り当て・タイムラインキャッシュの検証
 *
 *   1. ジョブキュー: 積む / 取り出す / 宣言（claim）/ 成功・失敗・再試行・打ち切り
 *   2. 同じ仕事を二重に実行しない（並列に走らせても 1 回ずつ）
 *   3. 落ちたプロセスが掴んだままの行を戻す（滞留の復帰）
 *   4. 配送キューの割り当て（claimDelivery）と滞留の復帰
 *   5. タイムラインの読み取りキャッシュ（プロセス内・HTTP 越しに HIT/MISS）
 *   6. 投稿に URL があるとプレビュー取得のジョブが積まれる
 *
 * Redis は要らない（DB の条件付き UPDATE だけで多重実行を防ぐ）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT_DIR = process.cwd();
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3768;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = 'data_test_job_queue.sqlite';

process.env.PORT = String(PORT);
process.env.DOMAIN = `localhost:${PORT}`;
process.env.PROTOCOL = 'http';
process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);
// タイムラインキャッシュは既定で無効なので、この検査では明示的に有効にする
process.env.TIMELINE_CACHE_TTL_SEC = '30';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (ok) passed++;
  else failed++;
}

console.log('🧪 === 🧰 ジョブキュー / 配送の割り当て / タイムラインキャッシュ ===');
console.log(`   port=${PORT}\n`);

for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // 消せなくても続行
    }
  }
}

const jobs = await import('../server/src/jobs.js');
const delivery = await import('../server/src/deliveryQueue.js');
const timelineCache = await import('../server/src/timelineCache.js');
const dbModule = await import('../server/src/db.js');
// リンクプレビューのハンドラを登録させる（import の副作用）
await import('../server/src/linkPreview.js');

let server: ChildProcess | null = null;

try {
  await dbModule.initDatabase();
  const { db } = dbModule;

  // ── 1. ジョブキューの基本 ──────────────────────────────────
  console.log('── 1. ジョブキュー（積む・取り出す・宣言する）──────────');
  const seen: string[] = [];
  let failNext = 0;
  jobs.registerJobHandler('test_job', async (payload: { id: string }) => {
    if (failNext > 0) {
      failNext--;
      throw new Error('わざと失敗させています');
    }
    seen.push(payload.id);
  });

  const kinds = jobs.getJobKinds();
  check('ハンドラを登録できる（リンクプレビューも登録済み）', kinds.includes('test_job') && kinds.includes('link_preview'), true);

  const unregistered = await jobs.enqueueJob('no_such_kind', {});
  check('未登録の種類は積まない', unregistered, null);

  const jobId = await jobs.enqueueJob('test_job', { id: 'a' });
  check('ジョブを積める', typeof jobId === 'string' && jobId.startsWith('job_'), true);

  const due = await jobs.listDueJobs('test_job');
  check('期限が来たジョブが取れる', due.length, 1);
  check('状態は pending', due[0]?.status, 'pending');
  check('試行回数はまだ 0', due[0]?.attempts, 0);

  check('宣言できる（1 回目）', (await jobs.claimJob(due[0].id)).claimed, true);
  check('同じジョブは二度宣言できない', (await jobs.claimJob(due[0].id)).claimed, false);
  check('宣言中のジョブは期限切れ一覧に出ない', (await jobs.listDueJobs('test_job')).length, 0);

  await jobs.finishJob(due[0].id);
  const afterDone = (await db.prepare('SELECT status, dedupe_key FROM jobs WHERE id = ?').get(due[0].id)) as any;
  check('完了にできる', afterDone.status, 'done');

  // ── 2. 実行（成功・失敗・再試行・打ち切り）──────────────────
  console.log('\n── 2. 実行と再試行 ──────────');
  seen.length = 0;
  await jobs.enqueueJob('test_job', { id: 'b' });
  const first = await jobs.runJobsOnce('test_job');
  check('1 件実行できた', [first.processed, first.ok, first.failed], [1, 1, 0]);
  check('ハンドラに payload が渡る', seen, ['b']);

  failNext = 1;
  const failingId = await jobs.enqueueJob('test_job', { id: 'c' });
  const second = await jobs.runJobsOnce('test_job');
  check('失敗も記録する', [second.processed, second.ok, second.failed], [1, 0, 1]);
  const retryRow = (await db.prepare('SELECT status, attempts, last_error, next_attempt_at FROM jobs WHERE id = ?').get(failingId)) as any;
  check('待機中に戻る（再試行する）', retryRow.status, 'pending');
  check('試行回数が増える', retryRow.attempts, 1);
  check('理由が残る', retryRow.last_error.includes('わざと失敗'), true);
  check('次回は未来になっている', new Date(retryRow.next_attempt_at).getTime() > Date.now(), true);
  check('すぐには実行されない（バックオフ中）', (await jobs.listDueJobs('test_job')).length, 0);

  // 予定を前倒しして、上限まで失敗させる
  await db.prepare('UPDATE jobs SET next_attempt_at = ? WHERE id = ?').run(new Date().toISOString(), failingId);
  while (true) {
    const row = (await db.prepare('SELECT status, attempts, max_attempts FROM jobs WHERE id = ?').get(failingId)) as any;
    if (row.status === 'failed') break;
    failNext = 1;
    await jobs.runJobsOnce('test_job');
    if (row.attempts >= row.max_attempts) break;
    await db.prepare('UPDATE jobs SET next_attempt_at = ? WHERE id = ?').run(new Date().toISOString(), failingId);
  }
  const deadRow = (await db.prepare('SELECT status, attempts, max_attempts FROM jobs WHERE id = ?').get(failingId)) as any;
  check('上限まで失敗したら確定する', deadRow.status, 'failed');
  check('試行回数は上限どおり', deadRow.attempts, deadRow.max_attempts);

  // ── 3. 二重に積まない・二重に実行しない ────────────────────
  console.log('\n── 3. 重複の防止 ──────────');
  const d1 = await jobs.enqueueJob('test_job', { id: 'd' }, { dedupeKey: 'same-work' });
  const d2 = await jobs.enqueueJob('test_job', { id: 'd' }, { dedupeKey: 'same-work' });
  check('同じ dedupeKey は積まない', [typeof d1 === 'string', d2], [true, null]);
  seen.length = 0;
  await jobs.runJobsOnce('test_job');
  check('実行は 1 回だけ', seen, ['d']);
  const d3 = await jobs.enqueueJob('test_job', { id: 'd' }, { dedupeKey: 'same-work' });
  check('完了後は同じキーで積める（キーが外れる）', typeof d3 === 'string', true);

  // 並列に走らせても 1 件ずつ（10 件を同時実行 4 で）
  seen.length = 0;
  for (let i = 0; i < 10; i++) await jobs.enqueueJob('test_job', { id: `p${i}` });
  const parallel = await jobs.runJobsOnce('test_job', { limit: 20, concurrency: 4 });
  check('並列でも 1 件ずつ実行する（重複が無い）', [new Set(seen).size === seen.length, parallel.ok >= 10], [true, true]);

  // ── 4. 滞留の復帰 ─────────────────────────────────────────
  console.log('\n── 4. 滞留の復帰 ──────────');
  const stuckId = await jobs.enqueueJob('test_job', { id: 'stuck' });
  await jobs.claimJob(stuckId!);
  await db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), stuckId);
  check('古い running を待機中に戻す', (await jobs.reclaimStaleJobs()) >= 1, true);
  check('戻ったので実行できる', ((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(stuckId)) as any).status, 'pending');

  const stats = await jobs.getJobStats();
  check('集計が取れる（done がある）', stats.done >= 1, true);

  // ── 5. 配送キューの割り当て ───────────────────────────────
  console.log('\n── 5. 配送の割り当て（claim）──────────');
  const nowIso = new Date().toISOString();
  for (const id of ['dq1', 'dq2']) {
    await db
      .prepare(
        `INSERT INTO outbox_deliveries (id, activity_id, activity_type, inbox_url, activity, sender_user_id, use_instance_actor, attempts, next_attempt_at, status, created_at, updated_at)
         VALUES (?, '', 'Create', ?, '{}', NULL, 1, 1, ?, 'pending', ?, ?)`,
      )
      .run(id, `https://remote.example/inbox/${id}`, nowIso, nowIso, nowIso);
  }
  check('期限が来た配送が取れる', (await delivery.listDueDeliveries()).length >= 2, true);
  check('配送を宣言できる', await delivery.claimDelivery('dq1'), true);
  check('同じ配送は二度宣言できない', await delivery.claimDelivery('dq1'), false);
  await db.prepare("UPDATE outbox_deliveries SET updated_at = ? WHERE id = 'dq1'").run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  check('古い delivering を待機中に戻す', (await delivery.reclaimStaleDeliveries()) >= 1, true);
  const dqStats = await delivery.getDeliveryQueueStats();
  check('集計に処理中が入る', ['pending', 'delivering', 'delivered', 'failed'].every((k) => typeof (dqStats as any)[k] === 'number'), true);

  // ── 6. タイムラインキャッシュ（in-process）──────────────────
  console.log('\n── 6. タイムラインキャッシュ ──────────');
  timelineCache.clearTimelineCache();
  check('既定では有効', timelineCache.isTimelineCacheEnabled(), true);
  check('知らない鍵は null', await timelineCache.cacheGet('nope'), null);
  await timelineCache.cacheSet('k', [{ id: 'p1' }], 30);
  check('入れた値が取れる', await timelineCache.cacheGet('k'), [{ id: 'p1' }]);
  const cacheStats = timelineCache.getTimelineCacheStats();
  check('ヒットとミスを数える', [cacheStats.hits, cacheStats.misses], [1, 1]);
  check('バックエンドはプロセス内（Redis 未設定）', cacheStats.backend, 'memory');

  // ── 7. サーバー越し（HTTP + ジョブの積み込み）──────────────
  console.log('\n── 7. サーバー越しの確認 ──────────');
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DOMAIN: `localhost:${PORT}`,
      PROTOCOL: 'http',
      DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
      INSTANCE_NAME: 'Job Queue Test',
      RATE_LIMIT_DISABLED: 'true',
      AUTO_MAINTENANCE: 'false',
      AUTO_BACKUP: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout?.on('data', (d) => (log += d.toString()));
  server.stderr?.on('data', (d) => (log += d.toString()));
  const deadline = Date.now() + 45000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200 || res.status === 503) {
        up = true;
        break;
      }
    } catch {
      // まだ
    }
    await sleep(250);
  }
  if (!up) throw new Error(`サーバーが起動しませんでした:\n${log}`);

  const health = (await (await fetch(`${BASE}/health`)).json()) as any;
  check('/health にキャッシュの状態が出る', typeof health.timelineCache?.enabled, 'boolean');
  check('/health に SSE の接続数が出る', typeof health.sseClients, 'number');

  const registerRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'jobs-admin', name: 'Jobs Admin', agreedToRules: true }),
  });
  const sessionToken = ((await registerRes.json()) as any).sessionToken as string;
  if (!sessionToken) throw new Error('登録に失敗しました');

  const postRes = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content: 'キャッシュの検証用の投稿 #jobqueue' }),
  });
  check('投稿できる', postRes.ok, true);

  const timelineUrl = `${BASE}/api/timeline?mode=local&limit=20`;
  const cacheMiss = await fetch(timelineUrl, { headers: { Authorization: `Bearer ${sessionToken}` } });
  const firstBody = await cacheMiss.json();
  check('1 回目はキャッシュに無い（MISS）', cacheMiss.headers.get('x-timeline-cache'), 'MISS');
  const cacheHit = await fetch(timelineUrl, { headers: { Authorization: `Bearer ${sessionToken}` } });
  const secondBody = await cacheHit.json();
  check('2 回目はキャッシュから（HIT）', cacheHit.headers.get('x-timeline-cache'), 'HIT');
  check('中身は同じ', JSON.stringify(secondBody) === JSON.stringify(firstBody), true);

  // 投稿に URL があるとプレビュー取得のジョブが積まれる
  await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content: 'プレビューの検証 https://example.invalid/article' }),
  });
  // 即時取得を試みたうえで失敗したら積まれるので、少し待ってから確認する
  let previewJobs = { c: 0 };
  for (let i = 0; i < 20 && previewJobs.c === 0; i++) {
    await sleep(500);
    previewJobs = (await db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'link_preview'").get()) as { c: number };
  }
  check('URL 付きの投稿でプレビュー取得のジョブが積まれる', previewJobs.c >= 1, true);
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  failed++;
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    const deadline = Date.now() + 8000;
    while (server.exitCode === null && Date.now() < deadline) await sleep(100);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try {
    await dbModule.db.close();
  } catch {
    // 握る
  }
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.rmSync(path.resolve(ROOT_DIR, 'server', f), { force: true });
    } catch {
      // 消せなくても続行
    }
  }
}

console.log('');
console.log('====================================================');
if (failed === 0) {
  console.log(`🎊 ジョブキュー / 配送の割り当て / タイムラインキャッシュ: ${passed} 件成功`);
  process.exit(0);
}
console.log(`❌ ${passed} 件成功 / ${failed} 件失敗`);
process.exit(1);
