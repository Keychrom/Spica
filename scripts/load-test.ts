/**
 * 負荷試験の道具（依存を増やさないため `node:http` を直接使う）
 *
 *   npx tsx scripts/load-test.ts --url http://localhost:3900 --token <session> [options]
 *
 * 主なオプション:
 *   --url <url>         対象（複数指定するとラウンドロビン＝ロードバランサ相当）
 *   --token <token>     認証トークン（ホームタイムラインと投稿に使う）
 *   --tokens <file>     複数ユーザーのトークン（1 行 1 つ）。ワーカーごとに別の利用者として振る舞う
 *   --duration <sec>    測定時間（既定 40。この前に 5 秒のウォームアップを入れる）
 *   --concurrency <n>   同時に投げる数（既定 20）
 *   --write <比率>      書き込み（ローカル限定の投稿）の割合（既定 0.1）
 *   --home-share <比率> 読み物のうちホームタイムラインの割合（既定 0.55。0 にすると home を避ける）
 *   --all-share <比率>  ホームを除いた残りのうち連合タイムラインの割合（既定 0.35。0 で連合を外す）
 *   --sse <n>           測定中に開いておく SSE 接続の数（既定 0）
 *   --sample-pid <pid>  その PID の CPU / メモリを 5 秒ごとに記録（複数可）
 *   --sample-name <名前> その名前のプロセスをまとめて記録（例: postgres。複数可）
 *   --label <name>      結果の見出し
 *   --burst <件数>      受信の burst を測る（偽アクターの鍵を配るローカルサーバーを立て、署名付き Create を /inbox へ流す）
 *   --burst-concurrency <n>  burst を流す同時数（既定は --concurrency）
 *   --actor-count <n>   burst で使う偽アクターの数（既定 5）
 *   --probe <path>      burst 中に「画面の応答」を測る経路（既定 /api/timeline?mode=local&limit=20）
 *   --soak <秒>         連続稼働を見る（10 秒ごとに /health と RSS を記録して、最後に表で出す）
 *
 * 出すもの: 秒あたりのリクエスト数、レイテンシの中央値・p95・p99、エラー率、エンドポイント別の内訳、
 * 記録したプロセスの CPU / RSS。**同じマシンで負荷を掛けている**ので、その分は割り引いて読むこと。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

interface Options {
  urls: string[];
  token: string;
  tokenFile?: string;
  tokens: string[];
  durationSec: number;
  concurrency: number;
  writeRatio: number;
  sseCount: number;
  samplePids: number[];
  sampleNames: string[];
  label: string;
  homeShare: number;
  allShare: number;
  /** 受信の burst を流す件数（0 なら通常の負荷試験） */
  burstCount: number;
  /** burst を流すときの同時接続数（0 なら --concurrency と同じ） */
  burstConcurrency: number;
  /** burst で使う偽アクターの数（多いほど 1 件あたりのアクター解決が増える） */
  actorCount: number;
  /** 偽アクターを配るローカル HTTP サーバーのポート */
  actorPort: number;
  /** burst 中に「画面の応答」を測るためのプローブ（同じ経路を 200ms ごとに叩く） */
  probePath: string;
  /** 連続稼働を見る秒数（0 なら通常の測定）。10 秒ごとに /health を記録する */
  soakSec: number;
}

function parseArgs(argv: string[]): Options {
  const urls: string[] = [];
  const opts: Options = {
    urls,
    token: '',
    tokens: [],
    durationSec: 40,
    concurrency: 20,
    writeRatio: 0.1,
    sseCount: 0,
    samplePids: [],
    sampleNames: [],
    label: 'load test',
    homeShare: 0.55,
    allShare: 1 / 3,
    burstCount: 0,
    burstConcurrency: 0,
    actorCount: 5,
    actorPort: 3911,
    probePath: '/api/timeline?mode=local&limit=20',
    soakSec: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') urls.push(next());
    else if (a === '--token') opts.token = next();
    else if (a === '--tokens') opts.tokenFile = next();
    else if (a === '--duration') opts.durationSec = Math.max(1, parseInt(next(), 10) || 40);
    else if (a === '--concurrency') opts.concurrency = Math.max(1, parseInt(next(), 10) || 20);
    else if (a === '--write') opts.writeRatio = Math.min(1, Math.max(0, parseFloat(next()) || 0));
    else if (a === '--home-share') opts.homeShare = Math.min(1, Math.max(0, parseFloat(next()) || 0));
    else if (a === '--all-share') opts.allShare = Math.min(1, Math.max(0, parseFloat(next()) || 0));
    else if (a === '--sse') opts.sseCount = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === '--sample-pid') opts.samplePids.push(parseInt(next(), 10));
    else if (a === '--sample-name') opts.sampleNames.push(next());
    else if (a === '--label') opts.label = next();
    else if (a === '--burst') opts.burstCount = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === '--burst-concurrency') opts.burstConcurrency = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === '--actor-count') opts.actorCount = Math.max(1, parseInt(next(), 10) || 5);
    else if (a === '--actor-port') opts.actorPort = Math.max(1, parseInt(next(), 10) || 3911);
    else if (a === '--probe') opts.probePath = next();
    else if (a === '--soak') opts.soakSec = Math.max(10, parseInt(next(), 10) || 600);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.tokenFile) {
  // 1 行 1 トークン。ワーカーごとに別の利用者として振る舞わせる
  opts.tokens = fs
    .readFileSync(opts.tokenFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (opts.tokens.length === 0) {
    console.error('❌ --tokens のファイルが空です');
    process.exit(2);
  }
  opts.token = opts.tokens[0];
}
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

function call(
  origin: string,
  path: string,
  init: { method?: string; body?: string; token?: string; headers?: Record<string, string> } = {},
  attempts = 0,
): Promise<Sample> {
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
          ...(init.headers || {}),
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
function pick(origin: string, random: number, token?: string): { path: string; init: { method?: string; body?: string; token?: string } } {
  const activeToken = token ?? opts.token;
  const hasToken = Boolean(activeToken);
  if (random < opts.writeRatio && hasToken) {
    const body = JSON.stringify({ content: `負荷試験の投稿 ${Math.random().toString(36).slice(2, 10)}`, visibility: 'local' });
    return { path: '/api/posts', init: { method: 'POST', body, token: activeToken } };
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
      return { path, init: needsAuth ? { token: activeToken } : {} };
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

// ── 受信の burst（リレーからまとめて流れてきたときの測定）─────────────────
//
// 署名付きの Create を /inbox へ一斉に投げる。相手役のアクターはローカルの
// HTTP サーバーが配る（ノードが鍵を取得できるようにするため。`ALLOW_PRIVATE_REMOTE_FETCH`
// が有効な http 運用のノードが対象）。
//
// **burst 中に「画面の応答」がどうなるかを必ず一緒に測る**（プローブ）。
// 受信が速くても、その間タイムラインが 3 秒待たされるなら意味が違う。

interface ActorServer {
  origin: string;
  close: () => void;
}

async function startActorServer(keys: { publicKeyPem: string; privateKeyPem: string }[], runId: string): Promise<ActorServer> {
  const origin = `http://127.0.0.1:${opts.actorPort}`;
  const server = http.createServer((req, res) => {
    const match = /^\/users\/burst-[a-z0-9]+-(\d+)$/.exec(req.url || '');
    if (match) {
      const index = Number(match[1]) % keys.length;
      const id = Number(match[1]);
      const actorUrl = `${origin}/users/burst-${runId}-${id}`;
      res.writeHead(200, { 'Content-Type': 'application/activity+json' });
      res.end(
        JSON.stringify({
          '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
          id: actorUrl,
          type: 'Person',
          preferredUsername: `burst-${runId}-${id}`,
          inbox: `${actorUrl}/inbox`,
          publicKey: { id: `${actorUrl}#main-key`, owner: actorUrl, publicKeyPem: keys[index].publicKeyPem },
        }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(opts.actorPort, '127.0.0.1', () => resolve()));
  return { origin, close: () => server.close() };
}

/** 署名付きの Create を 1 件作る（ノートの URL は偽アクターのドメイン配下） */
async function buildSignedCreate(index: number, actorOrigin: string, target: string, runId: string): Promise<{ path: string; body: string; headers: Record<string, string> }> {
  const { signHeaders } = await import('../server/src/crypto.js');
  const keys = burstKeys as { publicKeyPem: string; privateKeyPem: string }[];
  const actorId = index % opts.actorCount;
  const actorUrl = `${actorOrigin}/users/burst-${runId}-${actorId}`;
  const noteId = `${actorUrl}/notes/${Date.now()}-${index}`;
  const activity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${noteId}/activity`,
    type: 'Create',
    actor: actorUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: actorUrl,
      content: `<p>burst ${index} ${Math.random().toString(36).slice(2, 10)}</p>`,
      published: new Date().toISOString(),
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [],
    },
  };
  const body = JSON.stringify(activity);
  const inboxUrl = `${target}/inbox`;
  const headers = signHeaders({
    method: 'POST',
    url: inboxUrl,
    body,
    keyId: `${actorUrl}#main-key`,
    privateKeyPem: keys[actorId].privateKeyPem,
  });
  return { path: '/inbox', body, headers };
}

let burstKeys: { publicKeyPem: string; privateKeyPem: string }[] | null = null;

/** /health を 1 回読む（認証付きなら詳細も返る） */
async function readHealth(origin: string): Promise<any> {
  const res = await fetch(`${origin}/health`, { headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {} });
  return res.json().catch(() => null);
}

async function runBurst(): Promise<void> {
  const target = opts.urls[0];
  const concurrency = opts.burstConcurrency || opts.concurrency;
  // 鍵は 1 回だけ作る（相手役が配る公開鍵と、署名に使う秘密鍵を同じ組にする）
  const { generateKeyPair } = await import('../server/src/crypto.js');
  const runId = Math.random().toString(36).slice(2, 8);
  burstKeys = Array.from({ length: opts.actorCount }, () => generateKeyPair());
  const actors = await startActorServer(burstKeys, runId);
  console.log(`🧪 ${opts.label}（受信の burst）`);
  console.log(`   対象: ${target} / 件数 ${opts.burstCount} / 同時 ${concurrency} / アクター ${opts.actorCount}（相手役: ${actors.origin}）`);

  // 事前に 1 件流して、アクターの鍵が取得できることを確かめる
  const warmup = await buildSignedCreate(0, actors.origin, target, runId);
  const warmupRes = await fetch(`${target}${warmup.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/activity+json', ...warmup.headers },
    body: warmup.body,
  });
  if (warmupRes.status === 401) {
    console.error('❌ 署名が検証されませんでした（ノード側の ALLOW_PRIVATE_REMOTE_FETCH / DOMAIN の設定を確認してください）');
    console.log(await warmupRes.text());
    actors.close();
    process.exit(2);
  }
  console.log(`   準備: 1 件目は HTTP ${warmupRes.status}（この後 ${opts.burstCount} 件を流します）`);

  const before = await readHealth(target);

  // 画面の応答を測るプローブ（burst の前後で比較する）
  const probeLatencies: { phase: 'before' | 'during' | 'after'; ms: number; status: number }[] = [];
  let probeStop = false;
  const probe = (async () => {
    const probeAgent = new http.Agent({ keepAlive: true });
    let phase: 'before' | 'during' | 'after' = 'before';
    while (!probeStop) {
      const started = process.hrtime.bigint();
      const sample = await call(opts.urls[0], opts.probePath, { token: opts.token || undefined });
      probeLatencies.push({ phase, ms: Number(process.hrtime.bigint() - started) / 1e6, status: sample.status });
      await sleep(200);
      if (phase === 'before' && burstStarted) phase = 'during';
      if (phase === 'during' && burstDone) phase = 'after';
    }
    probeAgent.destroy();
  })();

  // burst 前のベースラインを 3 秒取る
  await sleep(3000);
  burstStarted = true;
  const startedAt = Date.now();
  const burstSamples: Sample[] = [];
  let issued = 0;
  const workerCount = Math.min(concurrency, opts.burstCount);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = issued++;
        if (index >= opts.burstCount) return;
        const { path, body, headers } = await buildSignedCreate(index + 1, actors.origin, target, runId);
        const sample = await call(target, path, { method: 'POST', body, headers });
        burstSamples.push(sample);
      }
    }),
  );
  burstDone = true;
  const burstSec = (Date.now() - startedAt) / 1000;
  await sleep(3000); // 後片付け（書き込みの終わり）を待ってからプローブを止める
  probeStop = true;
  await probe;

  const after = await readHealth(target);
  const latencies = burstSamples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const s of burstSamples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const statuses = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}: ${count}`).join(' / ');

  console.log(`\n   受信: ${burstSamples.length} 件を ${burstSec.toFixed(1)} 秒（${(burstSamples.length / burstSec).toFixed(0)} 件/s）`);
  console.log(`   応答: ${statuses}`);
  console.log(
    `   受信のレイテンシ: 中央値 ${percentile(latencies, 50).toFixed(0)}ms / p95 ${percentile(latencies, 95).toFixed(0)}ms / p99 ${percentile(latencies, 99).toFixed(0)}ms`,
  );

  for (const phase of ['before', 'during', 'after'] as const) {
    const list = probeLatencies.filter((p) => p.phase === phase).map((p) => p.ms).sort((a, b) => a - b);
    if (list.length === 0) continue;
    console.log(
      `   画面の応答 (${phase === 'before' ? 'burst 前' : phase === 'during' ? 'burst 中' : 'burst 後'}): 中央値 ${percentile(list, 50).toFixed(0)}ms / p95 ${percentile(list, 95).toFixed(0)}ms / 最大 ${(list.at(-1) ?? 0).toFixed(0)}ms（${list.length} 回）`,
    );
  }

  if (before?.inbox || after?.inbox) {
    console.log(`   受け入れ制御: 前 ${JSON.stringify(before?.inbox)} → 後 ${JSON.stringify(after?.inbox)}`);
  }
  const beforePosts = before?.posts?.total ?? null;
  const afterPosts = after?.posts?.total ?? null;
  if (beforePosts !== null && afterPosts !== null) {
    console.log(`   投稿数: ${beforePosts} → ${afterPosts}（+${afterPosts - beforePosts}）`);
  }
  if (after?.db) {
    console.log(`   DB: ${(Number(after.db.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)}MB + WAL ${(Number(after.db.walBytes ?? 0) / 1024 / 1024).toFixed(1)}MB`);
  }
  if (after?.deliveryQueue || after?.jobs) {
    console.log(`   キュー: 配送 ${JSON.stringify(after.deliveryQueue)} / ジョブ ${JSON.stringify(after.jobs)}`);
  }
  actors.close();
  agent.destroy();
  process.exit(0);
}

let burstStarted = false;
let burstDone = false;

// ── 実行 ───────────────────────────────────────────────────────────────
console.log(`🧪 ${opts.label}`);
console.log(`   対象: ${opts.urls.join(', ')}`);
console.log(`   同時 ${opts.concurrency} / 測定 ${opts.durationSec} 秒 / 書き込み ${(opts.writeRatio * 100).toFixed(0)}% / ホーム ${(opts.homeShare * 100).toFixed(0)}% / 連合 ${(opts.allShare * 100).toFixed(0)}% / SSE ${opts.sseCount}`);

const sseClients = opts.sseCount > 0 ? Array.from({ length: opts.sseCount }, (_, i) => openSse(opts.urls[i % opts.urls.length])) : [];
if (sseClients.length > 0) await sleep(1500); // 接続が登録されるのを待つ

// burst モードはこちら（通常の読み書きミックスは走らせない）
if (opts.burstCount > 0) {
  await runBurst();
}

// soak（連続稼働）: `--soak <秒>` のときは、その間ずっと負荷を流しつつ
// 10 秒ごとに /health を記録して、増え方（RSS・WAL・キューの滞留）を見る
const soakSamples: { at: number; rssBytes: number; walBytes: number; dbBytes: number; jobs: number; delivery: number; sse: number; inbox: number }[] = [];
let soakTimer: NodeJS.Timeout | null = null;
if (opts.soakSec > 0) {
  opts.durationSec = opts.soakSec;
  const poll = async (): Promise<void> => {
    const health = await readHealth(opts.urls[0]);
    const rss = procSamples.size > 0 ? [...procSamples.values()].flat().at(-1)?.rssBytes ?? 0 : 0;
    soakSamples.push({
      at: Date.now(),
      rssBytes: rss,
      walBytes: Number(health?.db?.walBytes ?? 0),
      dbBytes: Number(health?.db?.sizeBytes ?? 0),
      jobs: Number(health?.jobs?.pending ?? 0),
      delivery: Number(health?.deliveryQueue?.pending ?? 0),
      sse: Number(health?.sseClients ?? 0),
      inbox: Number(health?.inbox?.active ?? 0) + Number(health?.inbox?.waiting ?? 0),
    });
  };
  await poll();
  soakTimer = setInterval(() => void poll(), 10000);
  console.log('   ※ soak モード: 10 秒ごとに /health を記録します（--sample-pid を付けると RSS も見えます）');
}

// ウォームアップ（1.5 秒）
const warmUntil = Date.now() + 1500;
let counter = 0;
async function worker(deadline: number, warm: boolean, samples: Sample[] | null, workerIndex = 0): Promise<void> {
  // 複数トークンを渡されたら、ワーカーごとに別の利用者として振る舞う（人数ぶんの偏りを見るため）
  const token = opts.tokens.length > 0 ? opts.tokens[workerIndex % opts.tokens.length] : opts.token;
  while (Date.now() < deadline) {
    const origin = opts.urls[counter++ % opts.urls.length];
    const { path, init } = pick(origin, Math.random(), token);
    const sample = await call(origin, path, init);
    if (!warm && samples) samples.push(sample);
  }
}

sampleProcesses();
await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(warmUntil, true, null, i)));

const measureUntil = Date.now() + opts.durationSec * 1000;
const startedAt = Date.now();
const sampler = setInterval(sampleProcesses, 5000);
const samples: Sample[] = [];
await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(measureUntil, false, samples, i)));
clearInterval(sampler);
sampleProcesses();

const elapsedSec = (Date.now() - startedAt) / 1000;
if (soakTimer) clearInterval(soakTimer);
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

if (soakSamples.length > 1) {
  console.log(`\n   連続稼働の記録（${soakSamples.length} 回・10 秒ごと）:`);
  console.log('     時刻    RSS    DB + WAL     ジョブ待ち  配送待ち  SSE  受信');
  for (const s of soakSamples) {
    const t = new Date(s.at).toTimeString().slice(0, 8);
    console.log(
      `     ${t}  ${(s.rssBytes / 1024 / 1024).toFixed(0).padStart(5)}MB  ${(s.dbBytes / 1024 / 1024).toFixed(0).padStart(5)}MB + ${(s.walBytes / 1024 / 1024).toFixed(1).padStart(5)}MB  ${String(s.jobs).padStart(6)}  ${String(s.delivery).padStart(6)}  ${String(s.sse).padStart(4)}  ${String(s.inbox).padStart(4)}`,
    );
  }
  const first = soakSamples[0];
  const last = soakSamples[soakSamples.length - 1];
  const minutes = (last.at - first.at) / 60000;
  // RSS は最初のサンプルが 0 のことがある（プロセスの観測が始まる前）ので、値がある最初を使う
  const firstWithRss = soakSamples.find((s) => s.rssBytes > 0);
  const rssDelta =
    firstWithRss !== undefined ? (last.rssBytes - firstWithRss.rssBytes) / 1024 / 1024 : null;
  console.log(
    `\n   増え方（${minutes.toFixed(1)} 分）: RSS ${rssDelta === null ? '—' : `${rssDelta >= 0 ? '+' : ''}${rssDelta.toFixed(0)}MB`} / WAL ${((last.walBytes - first.walBytes) / 1024 / 1024).toFixed(1)}MB / DB ${((last.dbBytes - first.dbBytes) / 1024 / 1024).toFixed(1)}MB`,
  );
  console.log(
    `   滞留の最大: ジョブ ${Math.max(...soakSamples.map((s) => s.jobs))} / 配送 ${Math.max(...soakSamples.map((s) => s.delivery))} / 受信 ${Math.max(...soakSamples.map((s) => s.inbox))}`,
  );
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
