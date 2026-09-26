/**
 * `/metrics`（Prometheus 形式）用の小さな計測。
 *
 * 「その瞬間」しか見えない `/health` と違い、**推移**を見るためのものです。
 * 外部依存は増やさず、必要な値だけを数えてテキストにします
 * （Prometheus は `key value` の行さえ返せば読めるので、専用ライブラリは要りません）。
 *
 *   - `spica_http_requests_total{status="2xx"}` … リクエスト数（状態コードの分類ごと）
 *   - `spica_http_request_duration_seconds_sum` / `_count` … 応答時間の合計と件数（平均が出せる）
 *   - アプリの状態（SSE の接続数・配送/ジョブの滞留・キャッシュのヒット数など）
 *
 * 注意: ラベルに URL を使わないこと（利用者ごとに増えて Prometheus が壊れる）。
 */

interface Counters {
  requests: Map<string, number>;
  durationSumMs: number;
  durationCount: number;
  startedAt: number;
}

const counters: Counters = {
  requests: new Map(),
  durationSumMs: 0,
  durationCount: 0,
  startedAt: Date.now(),
};

/** 応答の状態コードを分類する（ラベルの種類を増やさない） */
function statusClass(statusCode: number): string {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return 'other';
}

/** リクエスト 1 件を数える（ミドルウェアから呼ぶ） */
export function recordRequest(statusCode: number, durationMs: number): void {
  const key = statusClass(statusCode);
  counters.requests.set(key, (counters.requests.get(key) ?? 0) + 1);
  counters.durationSumMs += durationMs;
  counters.durationCount += 1;
}

export interface MetricsSnapshot {
  http: {
    total: number;
    byStatus: Record<string, number>;
    durationSumMs: number;
    durationCount: number;
  };
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    activeHandles: number;
  };
}

/** プロセス内で数えている分を返す（テストからも使う） */
export function getMetricsSnapshot(): MetricsSnapshot {
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of counters.requests) {
    byStatus[key] = value;
    total += value;
  }
  const memory = process.memoryUsage();
  return {
    http: { total, byStatus, durationSumMs: counters.durationSumMs, durationCount: counters.durationCount },
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      // ハンドルの増加はリークの目印になる（SSE を開きっぱなしにしていないか等）
      activeHandles: (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? 0,
    },
  };
}

/** 検査用: 数えた分を戻す */
export function resetMetrics(): void {
  counters.requests.clear();
  counters.durationSumMs = 0;
  counters.durationCount = 0;
}

/** Prometheus のテキスト形式へ整形する */
export function formatPrometheus(extra: {
  dbOk: boolean;
  dbLatencyMs: number;
  sseClients: number;
  redis: { configured: boolean; ready: boolean };
  timelineCache: { enabled: boolean; backend: string; entries: number; hits: number; misses: number };
  deliveryQueue: { pending: number; delivering: number; failed: number };
  jobs: { pending: number; running: number; failed: number };
}): string {
  const snapshot = getMetricsSnapshot();
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const bool = (value: boolean): number => (value ? 1 : 0);

  metric('spica_up', 'プロセスが応答しているか（1 = 応答中）', 'gauge');
  lines.push('spica_up 1');

  metric('spica_uptime_seconds', '起動してからの秒数', 'gauge');
  lines.push(`spica_uptime_seconds ${snapshot.process.uptimeSeconds}`);

  metric('spica_db_up', 'DB に問い合わせられるか（1 = ok）', 'gauge');
  lines.push(`spica_db_up ${bool(extra.dbOk)}`);
  metric('spica_db_latency_ms', 'DB への問い合わせにかかった時間（直近）', 'gauge');
  lines.push(`spica_db_latency_ms ${extra.dbLatencyMs}`);

  metric('spica_redis_configured', 'REDIS_URL が設定されているか', 'gauge');
  lines.push(`spica_redis_configured ${bool(extra.redis.configured)}`);
  metric('spica_redis_ready', 'Redis に繋がっているか', 'gauge');
  lines.push(`spica_redis_ready ${bool(extra.redis.ready)}`);

  metric('spica_sse_clients', '接続中の SSE クライアント数', 'gauge');
  lines.push(`spica_sse_clients ${extra.sseClients}`);

  metric('spica_timeline_cache_enabled', 'タイムラインの読み取りキャッシュが有効か', 'gauge');
  lines.push(`spica_timeline_cache_enabled ${bool(extra.timelineCache.enabled)}`);
  metric('spica_timeline_cache_entries', 'キャッシュしている件数', 'gauge');
  lines.push(`spica_timeline_cache_entries ${extra.timelineCache.entries}`);
  metric('spica_timeline_cache_hits_total', 'キャッシュに当たった回数', 'counter');
  lines.push(`spica_timeline_cache_hits_total ${extra.timelineCache.hits}`);
  metric('spica_timeline_cache_misses_total', 'キャッシュに外れた回数', 'counter');
  lines.push(`spica_timeline_cache_misses_total ${extra.timelineCache.misses}`);

  metric('spica_delivery_queue_pending', '配送キューの待ち件数', 'gauge');
  lines.push(`spica_delivery_queue_pending ${extra.deliveryQueue.pending}`);
  metric('spica_delivery_queue_delivering', '配送中の件数', 'gauge');
  lines.push(`spica_delivery_queue_delivering ${extra.deliveryQueue.delivering}`);
  metric('spica_delivery_queue_failed', '配送に失敗したままの件数', 'gauge');
  lines.push(`spica_delivery_queue_failed ${extra.deliveryQueue.failed}`);

  metric('spica_jobs_pending', 'ジョブキューの待ち件数', 'gauge');
  lines.push(`spica_jobs_pending ${extra.jobs.pending}`);
  metric('spica_jobs_running', '実行中のジョブ数', 'gauge');
  lines.push(`spica_jobs_running ${extra.jobs.running}`);
  metric('spica_jobs_failed', '失敗したままのジョブ数', 'gauge');
  lines.push(`spica_jobs_failed ${extra.jobs.failed}`);

  metric('spica_process_resident_memory_bytes', 'RSS（プロセスのメモリ）', 'gauge');
  lines.push(`spica_process_resident_memory_bytes ${snapshot.process.rssBytes}`);
  metric('spica_process_heap_used_bytes', 'ヒープ使用量', 'gauge');
  lines.push(`spica_process_heap_used_bytes ${snapshot.process.heapUsedBytes}`);
  metric('spica_process_active_handles', '開いているハンドル数（増え続けたらリーク）', 'gauge');
  lines.push(`spica_process_active_handles ${snapshot.process.activeHandles}`);

  metric('spica_http_requests_total', 'HTTP リクエスト数（状態コードの分類ごと）', 'counter');
  for (const [status, value] of Object.entries(snapshot.http.byStatus).sort()) {
    lines.push(`spica_http_requests_total{status="${status}"} ${value}`);
  }
  metric('spica_http_request_duration_seconds_sum', '応答時間の合計（秒）', 'counter');
  lines.push(`spica_http_request_duration_seconds_sum ${(snapshot.http.durationSumMs / 1000).toFixed(3)}`);
  metric('spica_http_request_duration_seconds_count', '応答時間を数えた件数', 'counter');
  lines.push(`spica_http_request_duration_seconds_count ${snapshot.http.durationCount}`);

  return `${lines.join('\n')}\n`;
}
