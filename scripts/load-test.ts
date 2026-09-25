/**
 * 負荷試験の道具（依存を増やさないため `node:http` を直接使う）
 *
 *   npx tsx scripts/load-test.ts --url http://localhost:3900 --token <session> [options]
 *
 * 主なオプション:
 *   --url <url>         対象（複数指定するとラウンドロビン＝ロードバランサ相当）
 *   --token <token>     認証トークン（ホームタイムラインと投稿に使う）
 *   --duration <sec>    測定時間（既定 40。この前に 5 秒のウォームアップを入れる）
 *   --concurrency <n>   同時に投げる数（既定 20）
 *   --write <比率>      書き込み（ローカル限定の投稿）の割合（既定 0.1）
 *   --home-share <比率> 読み物のうちホームタイムラインの割合（既定 0.55。0 にすると home を避ける）
 *   --all-share <比率>  ホームを除いた残りのうち連合タイムラインの割合（既定 0.35。0 で連合を外す）
 *   --sse <n>           測定中に開いておく SSE 接続の数（既定 0）
 *   --sample-pid <pid>  その PID の CPU / メモリを 5 秒ごとに記録（複数可）
 *   --sample-name <名前> その名前のプロセスをまとめて記録（例: postgres。複数可）
 *   --label <name>      結果の見出し
 *
 * 出すもの: 秒あたりのリクエスト数、レイテンシの中央値・p95・p99、エラー率、エンドポイント別の内訳、
 * 記録したプロセスの CPU / RSS。**同じマシンで負荷を掛けている**ので、その分は割り引いて読むこと。
 */
import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

interface Options {
  urls: string[];
  token: string;
  durationSec: number;
  concurrency: number;
  writeRatio: number;
  sseCount: number;
  samplePids: number[];
  sampleNames: string[];
  label: string;
  homeShare: number;
  allShare: number;
}

function parseArgs(argv: string[]): Options {
  const urls: string[] = [];
  const opts: Options = {
    urls,
    token: '',
    durationSec: 40,
    concurrency: 20,
    writeRatio: 0.1,
    sseCount: 0,
    samplePids: [],
    sampleNames: [],
    label: 'load test',
    homeShare: 0.55,
    allShare: 1 / 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') urls.push(next());
    else if (a === '--token') opts.token = next();
    else if (a === '--duration') opts.durationSec = Math.max(1, parseInt(next(), 10) || 40);
    else if (a === '--concurrency') opts.concurrency = Math.max(1, parseInt(next(), 10) || 20);
    else if (a === '--write') opts.writeRatio = Math.min(1, Math.max(0, parseFloat(next()) || 0));
    else if (a === '--home-share') opts.homeShare = Math.min(1, Math.max(0, parseFloat(next()) || 0));
    else if (a === '--all-share') opts.allShare = Math.min(1, Math.max(0, parseFloat(next()) || 0));
    else if (a === '--sse') opts.sseCount = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === '--sample-pid') opts.samplePids.push(parseInt(next(), 10));
    else if (a === '--sample-name') opts.sampleNames.push(next());
    else if (a === '--label') opts.label = next();
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.urls.length === 0) {
  console.error('❌ --url を 1 つ以上指定してください');
  process.exit(2);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(opts.concurrency * 2, 16) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sample {
  endpoint: string;
  ms: number;
  status: number;
  bytes: number;
}

function call(origin: string, path: string, init: { method?: string; body?: string; token?: string } = {}, attempts = 0): Promise<Sample> {
  return new Promise((resolve) => {
    const url = new URL(path, origin);
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        agent,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          ...(init.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(init.body) } : {}),
          'Accept-Encoding': 'gzip',
        },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk: Buffer) => (bytes += chunk.length));
        res.on('end', () => {
          resolve({
            endpoint: init.method === 'POST' ? `POST ${url.pathname}` : url.pathname + (url.search ? url.search.replace(/&cursor=[^&]*/, '') : ''),
            ms: Number(process.hrtime.bigint() - started) / 1e6,
            status: res.statusCode || 0,
            bytes,
          });
        });
      },
    );
    req.on('error', () => {
      // 使い回した接続をサーバーが先に閉じたときの ECONNRESET は、負荷試験側の
      // keep-alive の都合で起きる（サーバーの故障ではない）。1 度だけ黙って張り直す。
      if (req.reusedSocket && attempts < 2) {
        resolve(call(origin, path, init, attempts + 1));
        return;
      }
      resolve({
        endpoint: init.method === 'POST' ? `POST ${url.pathname}` : url.pathname,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        status: 0,
        bytes: 0,
      });
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** 重み付きで次のリクエストを選ぶ */
function pick(origin: string, random: number): { path: string; init: { method?: string; body?: string; token?: string } } {
  const hasToken = Boolean(opts.token);
  if (random < opts.writeRatio && hasToken) {
    const body = JSON.stringify({ content: `負荷試験の投稿 ${Math.random().toString(36).slice(2, 10)}`, visibility: 'local' });
    return { path: '/api/posts', init: { method: 'POST', body, token: opts.token } };
  }
  const read = (random - opts.writeRatio) / Math.max(1 - opts.writeRatio, 0.0001);
  // 読みの内訳を積み上げ式で決める。`--all-share 0` なら連合タイムラインを外した比較になる。
  const home = hasToken ? opts.homeShare : 0;
  const rest = 1 - home;
  const all = rest * opts.allShare;
  const others = rest - all;
  const table: [string, number][] = [
    ['/api/timeline?mode=home&limit=20', home],
    ['/api/timeline?mode=all&limit=20', all],
    ['/api/timeline?mode=local&limit=20', others * 0.5],
    ['/api/server-info', others * 0.3333],
    ['/health', others * 0.1667],
  ];
  let accumulated = 0;
  for (const [path, weight] of table) {
    accumulated += weight;
    if (read < accumulated) {
      const needsAuth = path.includes('/api/timeline');
      return { path, init: needsAuth ? { token: opts.token } : {} };
    }
  }
  return { path: '/health', init: {} };
}

// ── プロセスの観測（Windows の PowerShell。取れなくても試験は続ける）──────
interface ProcSample {
  at: number;
  cpuSec: number;
  rssBytes: number;
}
const procSamples = new Map<string, ProcSample[]>();

/** 同じ名前のプロセスをまとめて 1 つの値にする（PostgreSQL のように接続ごとに増える相手を測るため） */
function sampleProcesses(): void {
  if (opts.samplePids.length === 0 && opts.sampleNames.length === 0) return;
  try {
    const commands: string[] = [];
    for (const pid of opts.samplePids) {
      commands.push(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){'pid:${pid} '+$p.CPU+' '+$p.WorkingSet64}`);
    }
    for (const name of opts.sampleNames) {
      commands.push(
        `$all=Get-Process -Name ${name} -ErrorAction SilentlyContinue; if($all){'name:${name} '+(($all|Measure-Object CPU -Sum).Sum)+' '+(($all|Measure-Object WorkingSet64 -Sum).Sum)}`,
      );
    }
    const out = execFileSync('powershell', ['-NoProfile', '-Command', commands.join('; ')], { encoding: 'utf8', timeout: 20000 });
    const at = Date.now();
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\S+)\s+([\d.]+)\s+(\d+)$/.exec(line.trim());
      if (!m) continue;
      const list = procSamples.get(m[1]) ?? [];
      list.push({ at, cpuSec: parseFloat(m[2]), rssBytes: Number(m[3]) });
      procSamples.set(m[1], list);
    }
  } catch {
    // 観測できなくても続ける
  }
}

/** 測定中に開いておく SSE 接続（切断せずに読み続けるだけ） */
function openSse(origin: string): { events: () => number; close: () => void } {
  let events = 0;
  let closed = false;
  const url = new URL(`/api/streaming?streams=local,home,all${opts.token ? `&token=${encodeURIComponent(opts.token)}` : ''}`, origin);
  const req = http.request(
    { agent, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Accept: 'text/event-stream' } },
    (res) => {
      res.on('data', (chunk: Buffer) => {
        events += chunk.toString('utf8').split('event: ').length - 1;
      });
      res.on('end', () => (closed = true));
      res.on('error', () => (closed = true));
    },
  );
  req.on('error', () => (closed = true));
  req.end();
  return { events: () => events, close: () => req.destroy() };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ── 実行 ───────────────────────────────────────────────────────────────
console.log(`🧪 ${opts.label}`);
console.log(`   対象: ${opts.urls.join(', ')}`);
console.log(`   同時 ${opts.concurrency} / 測定 ${opts.durationSec} 秒 / 書き込み ${(opts.writeRatio * 100).toFixed(0)}% / ホーム ${(opts.homeShare * 100).toFixed(0)}% / 連合 ${(opts.allShare * 100).toFixed(0)}% / SSE ${opts.sseCount}`);

const sseClients = opts.sseCount > 0 ? Array.from({ length: opts.sseCount }, (_, i) => openSse(opts.urls[i % opts.urls.length])) : [];
if (sseClients.length > 0) await sleep(1500); // 接続が登録されるのを待つ

// ウォームアップ（1.5 秒）
const warmUntil = Date.now() + 1500;
let counter = 0;
async function worker(deadline: number, warm: boolean, samples: Sample[] | null): Promise<void> {
  while (Date.now() < deadline) {
    const origin = opts.urls[counter++ % opts.urls.length];
    const { path, init } = pick(origin, Math.random());
    const sample = await call(origin, path, init);
    if (!warm && samples) samples.push(sample);
  }
}

sampleProcesses();
await Promise.all(Array.from({ length: opts.concurrency }, () => worker(warmUntil, true, null)));

const measureUntil = Date.now() + opts.durationSec * 1000;
const startedAt = Date.now();
const sampler = setInterval(sampleProcesses, 5000);
const samples: Sample[] = [];
await Promise.all(Array.from({ length: opts.concurrency }, () => worker(measureUntil, false, samples)));
clearInterval(sampler);
sampleProcesses();

const elapsedSec = (Date.now() - startedAt) / 1000;
const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
const serverErrors = samples.filter((s) => s.status >= 500 || s.status === 0).length;
const clientErrors = samples.filter((s) => s.status >= 400 && s.status < 500).length;

const byEndpoint = new Map<string, { count: number; ms: number[]; errors: number }>();
for (const s of samples) {
  const entry = byEndpoint.get(s.endpoint) ?? { count: 0, ms: [], errors: 0 };
  entry.count++;
  entry.ms.push(s.ms);
  if (s.status >= 400 || s.status === 0) entry.errors++;
  byEndpoint.set(s.endpoint, entry);
}

console.log(`\n   リクエスト数: ${samples.length}（${(samples.length / elapsedSec).toFixed(1)} req/s）`);
console.log(`   レイテンシ: 中央値 ${percentile(latencies, 50).toFixed(1)}ms / p95 ${percentile(latencies, 95).toFixed(1)}ms / p99 ${percentile(latencies, 99).toFixed(1)}ms / 最大 ${(latencies.at(-1) ?? 0).toFixed(0)}ms`);
console.log(`   エラー: 5xx・接続失敗 ${serverErrors} 件 / 4xx ${clientErrors} 件`);
console.log('\n   エンドポイント別:');
for (const [endpoint, entry] of [...byEndpoint.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const ms = entry.ms.sort((a, b) => a - b);
  console.log(
    `     ${endpoint.padEnd(38)} ${String(entry.count).padStart(6)} 件  p50 ${percentile(ms, 50).toFixed(1).padStart(7)}ms  p95 ${percentile(ms, 95).toFixed(1).padStart(7)}ms  エラー ${entry.errors}`,
  );
}

if (sseClients.length > 0) {
  const events = sseClients.reduce((sum, c) => sum + c.events(), 0);
  console.log(`\n   SSE: ${sseClients.length} 接続を保持 / 受信イベント ${events} 件`);
  for (const c of sseClients) c.close();
}

if (procSamples.size > 0) {
  console.log('\n   プロセスの観測（5 秒ごと）:');
  const cores = os.cpus().length;
  for (const [key, list] of procSamples) {
    if (list.length < 2) {
      console.log(`     ${key}: 十分なサンプルが取れませんでした`);
      continue;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const seconds = (last.at - first.at) / 1000;
    const cpuPct = seconds > 0 ? ((last.cpuSec - first.cpuSec) / seconds / cores) * 100 : 0;
    const rssMb = list.reduce((sum, s) => sum + s.rssBytes, 0) / list.length / 1024 / 1024;
    console.log(`     ${key}: CPU 平均 ${cpuPct.toFixed(0)}%（全 ${cores} コア中）/ RSS 平均 ${rssMb.toFixed(0)}MB`);
  }
}

agent.destroy();
process.exit(serverErrors > 0 && serverErrors > samples.length * 0.01 ? 1 : 0);
