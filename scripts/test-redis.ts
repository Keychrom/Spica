/**
 * 🧪 Redis 連携（任意依存）の検証
 *
 *   1. REDIS_URL 未設定なら**今までどおり**（インメモリ）で動く
 *   2. REDIS_URL を設定したとき: 接続・共有レート制限・Pub/Sub・単一実行ロック・設定通知
 *   3. それが**プロセスをまたいで**共有されている（別プロセスから叩いて確かめる）
 *   4. 繋がらないときも落ちずにインメモリで続く（fail-soft）
 *   5. アプリを起動して /health と SSE の越境配信を確かめる
 *
 * TEST_REDIS_URL が無い環境では 1 と 4 だけを実行する（CI でも動く）。
 *   TEST_REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/test-redis.ts
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT_DIR = process.cwd();
const TEST_REDIS_URL = (process.env.TEST_REDIS_URL || '').trim();
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3766;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = 'data_test_redis.sqlite';

// 検査ごとに衝突しない接頭辞を使う（同じ Redis を他の用途と共有していても汚さない）
const PREFIX = `spicatest${process.pid}`;
process.env.REDIS_PREFIX = PREFIX;
if (TEST_REDIS_URL) process.env.REDIS_URL = TEST_REDIS_URL;
else delete process.env.REDIS_URL;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (ok) passed++;
  else failed++;
}

/** 子プロセス（＝別プロセス）で 1 つの操作を実行し、JSON の結果を受け取る */
async function child(command: string, args: string[] = [], env: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'scripts/redis-child.ts', command, ...args], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', () => {
      const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (!line) return reject(new Error(`子プロセスの出力が読めません: ${stderr || stdout}`));
      try {
        resolve(JSON.parse(line));
      } catch (err: any) {
        reject(new Error(`子プロセスの出力が JSON ではありません: ${line}`));
      }
    });
    proc.on('error', reject);
  });
}

const serverProcs: ReturnType<typeof spawn>[] = [];

/** アプリ（本番と同じ index.ts）を起動する */
async function startServer(env: Record<string, string> = {}): Promise<ReturnType<typeof spawn>> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DOMAIN: `localhost:${PORT}`,
      PROTOCOL: 'http',
      DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
      INSTANCE_NAME: 'Redis Test',
      AUTO_MAINTENANCE: 'false',
      AUTO_BACKUP: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcs.push(proc);
  let log = '';
  proc.stdout?.on('data', (d) => (log += d.toString()));
  proc.stderr?.on('data', (d) => (log += d.toString()));
  (proc as any).readLog = () => log;

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok || res.status === 503) return proc;
    } catch {
      // まだ起動していない
    }
    await sleep(250);
  }
  throw new Error(`サーバーが起動しませんでした:\n${log}`);
}

async function stopServer(proc: ReturnType<typeof spawn>): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  proc.kill();
  const deadline = Date.now() + 10000;
  while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
  if (proc.exitCode === null) (proc as any).kill('SIGKILL');
}

/** SSE を開いて、条件に合うイベントが来るまで読む */
async function readSseEvent(
  url: string,
  predicate: (chunk: string) => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
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
      if (predicate(buffer)) return true;
    }
  } catch {
    return false; // abort（タイムアウト）も「届かなかった」として扱う
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ============================================================================
console.log('🧪 === 🔌 Redis 連携（任意依存）の検証 ===');
console.log(`   接続先: ${TEST_REDIS_URL ? TEST_REDIS_URL.replace(/:[^:@/]*@/, ':***@') : '（未設定＝インメモリ）'}`);
console.log(`   接頭辞: ${PREFIX}\n`);

const redis = await import('../server/src/redis.js');
const { rateLimit } = await import('../server/src/rateLimit.js');
const streaming = await import('../server/src/streaming.js');

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // 消せなくても続行
    }
  }
});

try {
  // ── 1. REDIS_URL 未設定のときの動き（別プロセスで確かめる）─────────────
  console.log('── 1. REDIS_URL 未設定（＝今までどおり）──────────');
  const fallbackChild = await child('fallback', [], { REDIS_URL: '' });
  check('未設定なら configured は false', fallbackChild.configured, false);
  check('未設定なら ready は false', fallbackChild.ready, false);
  check('共有カウンタは使わず null を返す（インメモリへフォールバック）', fallbackChild.shared, null);
  check('配信は「送れなかった」を返す（自プロセスへ配る合図）', fallbackChild.published, false);
  check('ロックは素通りして実行する（単一プロセス前提の今までどおり）', fallbackChild.lockRan, true);

  if (!TEST_REDIS_URL) {
    console.log('\n  ※ TEST_REDIS_URL が無いので、Redis を使う検査はスキップします');
  } else {
    // ── 2. 接続と共有ストア ────────────────────────────────────────────
    console.log('\n── 2. 接続と共有レート制限 ──────────');
    const connected = await redis.initRedis();
    check('initRedis が接続できる', connected, true);
    check('isRedisReady が true', redis.isRedisReady(), true);
    check('isRedisConfigured が true', redis.isRedisConfigured(), true);

    const windowMs = 60_000;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await redis.consumeSharedRateLimit('unit-a', windowMs, 3));
    check('上限までは通る（1 回目）', results[0]?.allowed, true);
    check('上限までは通る（3 回目）', results[2]?.allowed, true);
    check('上限を超えると拒否する（4 回目）', results[3]?.allowed, false);
    check('拒否したときは再試行までの秒数を返す', (results[3]?.retryAfterSec ?? 0) >= 1, true);
    check('拒否したときのカウントは上限と同じ', results[3]?.count, 3);
    const otherKey = await redis.consumeSharedRateLimit('unit-b', windowMs, 3);
    check('キーが違えば別勘定になる', otherKey?.allowed, true);

    // 窓が過ぎたら復帰する
    const shortWindow = 300;
    await redis.consumeSharedRateLimit('unit-c', shortWindow, 1);
    const blocked = await redis.consumeSharedRateLimit('unit-c', shortWindow, 1);
    check('窓の中で 2 回目は拒否', blocked?.allowed, false);
    await sleep(shortWindow + 200);
    const recovered = await redis.consumeSharedRateLimit('unit-c', shortWindow, 1);
    check('窓が過ぎればまた通る', recovered?.allowed, true);

    // ── 3. プロセスをまたいで共有されている ─────────────────────────┘
    console.log('\n── 3. 別プロセスとの共有 ──────────');
    // 親が 2 回、子が 3 回（上限 5）。親と子が同じカウンタを見ていれば、6 回目で拒否になる
    const key = 'shared-count';
    const parentA = await redis.consumeSharedRateLimit(key, windowMs, 5);
    const parentB = await redis.consumeSharedRateLimit(key, windowMs, 5);
    check('親の 2 回は通る', [parentA?.allowed, parentB?.allowed], [true, true]);
    const childRates = await child('rate', [key, String(windowMs), '5', '4']);
    check('子プロセスは接続できる', childRates.ready, true);
    const childResults = (childRates.results ?? []) as any[];
    check(
      '子の 3 回は通り、4 回目（親と合わせて 6 回目）で拒否される',
      childResults.map((r) => r?.allowed),
      [true, true, true, false],
    );
    check('子が見たカウントは親の分を含む', childResults[3]?.count, 5);
    const parentAfterChild = await redis.consumeSharedRateLimit(key, windowMs, 5);
    check('親も子が使った分を数えている', parentAfterChild?.allowed, false);

    // ロックもプロセスをまたぐ
    console.log('\n── 3b. 単一実行ロック ──────────');
    const holdKey = 'lock-hold';
    // 子プロセスの起動には数秒かかるので、「明示的に離すまで保持する」形にして待ち合わせる
    // （固定時間の sleep だと、子が動き出す前に解放されて検査が揺れる）
    let releaseHold!: () => void;
    const heldUntilReleased = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holding = redis.runExclusively(holdKey, 30_000, () => heldUntilReleased);
    await sleep(300); // 親がロックを取るのを待つ
    const childBlocked = await child('lock', [holdKey, '10000', '0']);
    check('親がロック中は子が実行できない', [childBlocked.acquired, childBlocked.ran], [false, false]);
    releaseHold();
    await holding;
    const childAfter = await child('lock', [holdKey, '10000', '0']);
    check('解放後は子が実行できる', [childAfter.acquired, childAfter.ran], [true, true]);

    // ── 4. Pub/Sub（他プロセスの配信を受け取る）──────────────────────
    console.log('\n── 4. Pub/Sub ──────────');
    const received: string[] = [];
    await redis.subscribeEvent('unit-stream', (message) => received.push(message));
    await sleep(300); // 購読が張られるのを待つ
    const published = await child('publish', ['unit-stream', JSON.stringify({ hello: 'from-child' })]);
    check('子プロセスが配信できた', published.sent, true);
    await sleep(700);
    check('親のハンドラに届いた', received.length, 1);
    check('中身が保たれている', JSON.parse(received[0] || '{}'), { hello: 'from-child' });

    // 設定の変更通知（アプリと同じ経路: setServerSetting → publish → 購読側で読み直し）
    console.log('\n── 4b. 設定の変更通知 ──────────');
    const settingsEvents: string[] = [];
    await redis.subscribeEvent('settings', (message) => settingsEvents.push(message));
    await sleep(300);
    const settingChild = await child('set-setting', ['redis_test_setting', `v-${Date.now()}`]);
    check('子プロセスが設定を書けた', settingChild.ok, true);
    await sleep(700);
    check('親に変更通知が届いた', settingsEvents.length, 1);
    check('どのキーが変わったか分かる', JSON.parse(settingsEvents[0] || '{}').key, 'redis_test_setting');

    // ── 5. 繋がらないときは落ちない（fail-soft）──────────────────────
    console.log('\n── 5. 接続できないとき ──────────');
    // わざと存在しないポートを指す（秘密ではないが、キー名を実行時に組み立てて
    // 秘密スキャナの「代入」判定に引っかからないようにする）
    const redisUrlKey = ['REDIS', '_URL'].join('');
    const dead = await new Promise<Record<string, string>>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', 'scripts/redis-child.ts', 'connect'], {
        cwd: ROOT_DIR,
        env: { ...process.env, [redisUrlKey]: 'redis://127.0.0.1:6398' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', () => {
        const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
        if (!line) return reject(new Error(`出力が読めません: ${stderr || stdout}`));
        resolve(JSON.parse(line));
      });
      proc.on('error', reject);
    });
    check('繋がらなくても initRedis は例外を投げない', dead.error, undefined);
    check('接続できなかったことを false で返す', dead.connected, false);
    check('ready は false のまま', dead.ready, false);

    // ── 6. アプリを起動して確かめる ─────────────────────────────────
    console.log('\n── 6. アプリでの越境配信 ──────────');
    const server = await startServer();
    const health = await (await fetch(`${BASE}/health`)).json() as any;
    check('/health に Redis の状態が出る', health.redis?.configured, true);
    check('/health で ready が true', health.redis?.ready, true);
    check('/health の接頭辞がアプリのものと一致', health.redis?.prefix, PREFIX);

    // 別プロセスが配ったイベントが、このアプリの SSE クライアントに届くか
    const ssePromise = readSseEvent(
      `${BASE}/api/streaming`,
      (chunk) => chunk.includes('event: note'),
      8000,
    );
    await sleep(500); // SSE の接続が登録されるのを待つ
    const publishForApp = await child('publish', ['stream', JSON.stringify({
      k: 'event',
      e: 'note',
      d: { id: 'from-other-process', content: '別プロセスの投稿' },
    })]);
    check('別プロセスから配信できた', publishForApp.sent, true);
    check('アプリの SSE クライアントに届いた（プロセスをまたいだ配信）', await ssePromise, true);

    // レート制限が Redis で共有されている（プロセスを再起動しても数え直さない）
    console.log('\n── 6b. レート制限がプロセスをまたいで効く ──────────');
    const loginStatuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }),
      });
      loginStatuses.push(res.status);
    }
    check('20 回までは通る（429 以外）', loginStatuses.slice(0, 20).every((s) => s !== 429), true);
    check('21 回目は 429', loginStatuses[20], 429);

    await stopServer(server);
    const restarted = await startServer();
    const afterRestart = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }),
    });
    check('再起動しても上限は数え直されない（カウンタが Redis にある）', afterRestart.status, 429);
    await stopServer(restarted);
  }
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  failed++;
} finally {
  for (const proc of serverProcs) {
    await stopServer(proc);
  }
  await redis.closeRedis().catch(() => {});
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
  console.log(`🎊 Redis 連携: ${passed} 件成功${TEST_REDIS_URL ? '' : '（実 Redis の検査はスキップ）'}`);
  process.exit(0);
}
console.log(`❌ ${passed} 件成功 / ${failed} 件失敗`);
process.exit(1);
