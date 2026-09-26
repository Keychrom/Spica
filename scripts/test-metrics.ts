/**
 * `/metrics`（Prometheus 形式）の検証 (`npx tsx scripts/test-metrics.ts`)
 *
 * 検査すること:
 *   1. `METRICS_TOKEN` 未設定なら 404（存在しない扱い）
 *   2. 設定時はトークン必須（無し・誤りは 401、正しければ 200）
 *   3. 形式が Prometheus として読める（`名前[{ラベル}] 値` の行）
 *   4. リクエストを数えている（叩いた分だけカウンタが増える）
 *   5. アプリの状態が出ている（SSE・配送・ジョブ・キャッシュ・メモリ・ハンドル）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_A = 3960; // トークンあり
const PORT_B = 3961; // トークンなし
const TOKEN = 'test-metrics-token';
const DB_A = path.join(ROOT_DIR, 'server', `data_test_metrics_a.sqlite`);
const DB_B = path.join(ROOT_DIR, 'server', `data_test_metrics_b.sqlite`);

let passed = 0;
let failed = 0;
const procs: ChildProcess[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: 期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function get(url: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

async function startNode(dbPath: string, port: number, token?: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DOMAIN: `localhost:${port}`,
    PROTOCOL: 'http',
    DB_PATH: dbPath,
    AUTO_MAINTENANCE: 'false',
    AUTO_BACKUP: 'false',
    RATE_LIMIT_DISABLED: 'true',
    INSTANCE_NAME: `metrics ${port}`,
  };
  delete env.DB_DRIVER;
  delete env.DATABASE_URL;
  delete env.METRICS_TOKEN;
  delete env.REDIS_URL;
  if (token) env.METRICS_TOKEN = token;

  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT_DIR, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  let log = '';
  proc.stdout?.on('data', (d) => (log += d.toString()));
  proc.stderr?.on('data', (d) => (log += d.toString()));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const res = await get(`http://127.0.0.1:${port}/health`);
    if (res.status === 200) return;
    await sleep(400);
  }
  throw new Error(`サーバーが起動しませんでした (port ${port}):\n${log.slice(-500)}`);
}

/** Prometheus のテキストとして妥当か（コメント以外は `名前[{ラベル}] 数値`） */
function validPrometheusLines(text: string): { bad: string[]; names: Set<string> } {
  const bad: string[] = [];
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[\d.eE+]+)$/.exec(trimmed);
    if (!match) {
      bad.push(trimmed.slice(0, 80));
      continue;
    }
    names.add(match[1]);
  }
  return { bad, names };
}

async function main(): Promise<void> {
  console.log('🧪 /metrics（Prometheus 形式）の検証');
  await startNode(DB_A, PORT_A, TOKEN);
  await startNode(DB_B, PORT_B);

  console.log('\n--- 1. アクセス制御 ---');
  check('トークン未設定なら 404', (await get(`http://127.0.0.1:${PORT_B}/metrics`)).status, 404);
  check('トークン無しでは 401', (await get(`http://127.0.0.1:${PORT_A}/metrics`)).status, 401);
  check('誤ったトークンでは 401', (await get(`http://127.0.0.1:${PORT_A}/metrics`, 'wrong')).status, 401);

  console.log('\n--- 2. 形式と内容 ---');
  const first = await get(`http://127.0.0.1:${PORT_A}/metrics`, TOKEN);
  check('正しいトークンなら 200', first.status, 200);
  const { bad, names } = validPrometheusLines(first.body);
  check('すべての行が Prometheus の形式', bad, []);
  for (const name of [
    'spica_up',
    'spica_uptime_seconds',
    'spica_db_up',
    'spica_sse_clients',
    'spica_http_requests_total',
    'spica_http_request_duration_seconds_sum',
    'spica_http_request_duration_seconds_count',
    'spica_delivery_queue_pending',
    'spica_jobs_pending',
    'spica_timeline_cache_hits_total',
    'spica_process_resident_memory_bytes',
    'spica_process_active_handles',
  ]) {
    check(`${name} が出ている`, names.has(name), true);
  }
  check('HELP / TYPE のコメントも出ている', first.body.includes('# TYPE spica_up gauge'), true);

  console.log('\n--- 3. 数えている ---');
  const before = Number(/spica_http_requests_total\{status="2xx"\} (\d+)/.exec(first.body)?.[1] ?? '0');
  const durationBefore = Number(/spica_http_request_duration_seconds_count (\d+)/.exec(first.body)?.[1] ?? '0');
  await get(`http://127.0.0.1:${PORT_A}/api/server-info`);
  await get(`http://127.0.0.1:${PORT_A}/health`);
  const second = await get(`http://127.0.0.1:${PORT_A}/metrics`, TOKEN);
  const after = Number(/spica_http_requests_total\{status="2xx"\} (\d+)/.exec(second.body)?.[1] ?? '0');
  const durationAfter = Number(/spica_http_request_duration_seconds_count (\d+)/.exec(second.body)?.[1] ?? '0');
  // before の取得自体（/metrics）も数えられるので、+1 以上増えていればよい
  check('2xx のカウンタが増える', after >= before + 3, true);
  check('応答時間の件数も増える', durationAfter >= durationBefore + 3, true);
  check('DB に問い合わせられている', second.body.includes('spica_db_up 1'), true);

  for (const proc of procs) {
    if (proc.exitCode === null) proc.kill();
  }
  await sleep(500);

  console.log(`\n${failed === 0 ? '🎉' : '❌'} 成功 ${passed} / 失敗 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ 検査中にエラー:', err?.message || err);
  for (const proc of procs) if (proc.exitCode === null) proc.kill();
  process.exit(1);
});
