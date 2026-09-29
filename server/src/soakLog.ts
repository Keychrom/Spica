import { config } from './config.js';
import { db } from './db.js';
import { getDbSizeInfo } from './dbMaintenance.js';
import { getJobStats } from './jobs.js';
import { getDeliveryQueueStats } from './deliveryQueue.js';
import { getStreamClientCount } from './streaming.js';
import { inboxGate } from './inboxGate.js';

/**
 * 連続稼働の記録（soak log）。
 *
 * メモリの増え方・WAL の膨らみ・キューの滞留は**数時間〜数日**動かさないと見えません。
 * `SOAK_LOG_INTERVAL_MS` を設定すると、その間隔で 1 行だけログに残します
 * （`journalctl -u spica | grep '\[Soak\]'` で推移を追える）。
 *
 * **既定は無効（0）**です。負荷試験のときだけ入れる想定で、通常運用では何もしません。
 * 直近のサンプルは `/health`（認証あり）の `soak` でも見られます。
 */

export interface SoakSample {
  at: string;
  uptimeSec: number;
  rssMb: number;
  heapMb: number;
  dbMb: number;
  walMb: number;
  jobs: { pending: number; running: number; failed: number };
  delivery: { pending: number; delivering: number; failed: number };
  inbox: { active: number; waiting: number; shed: number };
  sse: number;
}

/** 直近のサンプル（24 時間ぶん。間隔が 5 分なら 288 件） */
const MAX_SAMPLES = 288;
const samples: SoakSample[] = [];
let timer: NodeJS.Timeout | null = null;

/** 1 回ぶんのサンプルを取って、ログに 1 行出す */
export async function takeSoakSample(): Promise<SoakSample> {
  const mem = process.memoryUsage();
  let dbMb = 0;
  let walMb = 0;
  try {
    const size = await getDbSizeInfo(config.dbPath, db);
    dbMb = size.dbBytes / 1024 / 1024;
    walMb = size.walBytes / 1024 / 1024;
  } catch {
    // PostgreSQL などでは取れないことがある（0 のまま）
  }

  let jobs = { pending: 0, running: 0, failed: 0 };
  let delivery = { pending: 0, delivering: 0, failed: 0 };
  try {
    const stats = await getJobStats();
    jobs = { pending: stats.pending, running: stats.running, failed: stats.failed };
    const queue = await getDeliveryQueueStats();
    delivery = { pending: queue.pending, delivering: queue.delivering, failed: queue.failed };
  } catch {
    // 取れなくても続ける
  }

  const sample: SoakSample = {
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    dbMb: Math.round(dbMb * 10) / 10,
    walMb: Math.round(walMb * 10) / 10,
    jobs,
    delivery,
    inbox: inboxGate.stats(),
    sse: getStreamClientCount(),
  };

  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();

  console.log(
    `[Soak] rss=${sample.rssMb}MB heap=${sample.heapMb}MB uptime=${(sample.uptimeSec / 3600).toFixed(1)}h ` +
      `db=${sample.dbMb}MB wal=${sample.walMb}MB jobs=${jobs.pending}/${jobs.running}/${jobs.failed} ` +
      `delivery=${delivery.pending}/${delivery.delivering}/${delivery.failed} ` +
      `inbox=${sample.inbox.active}/${sample.inbox.waiting}/${sample.inbox.shed} sse=${sample.sse} role=${config.processRole} pid=${process.pid}`,
  );
  return sample;
}

/** 記録を開始する（`SOAK_LOG_INTERVAL_MS` が 0 なら何もしない） */
export function startSoakLog(): void {
  if (timer || config.soakLogIntervalMs <= 0) return;
  console.log(`[Soak] 📈 連続稼働の記録を開始します（${Math.round(config.soakLogIntervalMs / 1000)} 秒ごと）`);
  timer = setInterval(() => {
    void takeSoakSample().catch((err) => console.warn('[Soak] 記録に失敗:', err?.message || err));
  }, config.soakLogIntervalMs);
  timer.unref?.();
}

export function stopSoakLog(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** 直近のサンプルと、最初と最後の差（`/health` で見せる） */
export function getSoakStats(): {
  enabled: boolean;
  intervalSec: number;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  rssDeltaMb: number | null;
  walDeltaMb: number | null;
  last: SoakSample | null;
} {
  const first = samples[0] ?? null;
  const last = samples[samples.length - 1] ?? null;
  return {
    enabled: config.soakLogIntervalMs > 0,
    intervalSec: Math.round(config.soakLogIntervalMs / 1000),
    count: samples.length,
    firstAt: first?.at ?? null,
    lastAt: last?.at ?? null,
    rssDeltaMb: first && last ? last.rssMb - first.rssMb : null,
    walDeltaMb: first && last ? Math.round((last.walMb - first.walMb) * 10) / 10 : null,
    last,
  };
}

/** 検査用: サンプルを捨てる */
export function clearSoakSamples(): void {
  samples.length = 0;
}
