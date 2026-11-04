/**
 * 轻量进程内指标：不引入 Prometheus 客户端依赖。
 * 只记录路由模板 + 状态码，避免高基数；进程重启后归零。
 */

const BUCKETS_MS = [50, 100, 200, 500, 1000, 2000, 5000];

interface RouteMetric {
  count: number;
  totalMs: number;
  buckets: number[];
}

const requests = new Map<string, RouteMetric>();
const durations: RouteMetric = {
  count: 0,
  totalMs: 0,
  buckets: BUCKETS_MS.map(() => 0),
};
let slowRequests = 0;
let pdfCacheHits = 0;
let pdfCacheMisses = 0;
let startedAt = Date.now();

const keyOf = (method: string, route: string, status: number) =>
  `${method}\u0000${route}\u0000${status}`;

export function observeRequest(input: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  slow: boolean;
}): void {
  const key = keyOf(input.method, input.route, input.status);
  const current = requests.get(key) ?? {
    count: 0,
    totalMs: 0,
    buckets: BUCKETS_MS.map(() => 0),
  };
  current.count += 1;
  current.totalMs += input.durationMs;
  BUCKETS_MS.forEach((limit, i) => {
    if (input.durationMs <= limit) current.buckets[i] += 1;
  });
  requests.set(key, current);

  durations.count += 1;
  durations.totalMs += input.durationMs;
  BUCKETS_MS.forEach((limit, i) => {
    if (input.durationMs <= limit) durations.buckets[i] += 1;
  });

  if (input.slow) slowRequests += 1;
}

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function parseKey(key: string): [string, string, string] {
  const [method, route, status] = key.split('\u0000');
  return [method, route, status];
}

export interface RuntimeMetrics {
  dbUp: boolean;
  dbPool: { total: number; idle: number; waiting: number; max: number };
  redisConfigured: boolean;
  redisUp: boolean;
  pdfQueue: {
    pending: number;
    running: number;
    done24h: number;
    failed24h: number;
    oldestPendingSeconds: number;
  };
}

export function observePdfCache(status: 'HIT' | 'MISS'): void {
  if (status === 'HIT') pdfCacheHits += 1;
  else pdfCacheMisses += 1;
}

export function renderPrometheus(options: RuntimeMetrics): string {
  const lines: string[] = [];
  lines.push('# HELP http_requests_total Total HTTP requests by method/route/status.');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, metric] of requests) {
    const [method, route, status] = parseKey(key);
    lines.push(
      `http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${metric.count}`,
    );
  }

  lines.push('# HELP http_request_duration_ms HTTP request duration in milliseconds.');
  lines.push('# TYPE http_request_duration_ms histogram');
  BUCKETS_MS.forEach((limit, i) => {
    lines.push(`http_request_duration_ms_bucket{le="${limit}"} ${durations.buckets[i]}`);
  });
  lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${durations.count}`);
  lines.push(`http_request_duration_ms_sum ${durations.totalMs}`);
  lines.push(`http_request_duration_ms_count ${durations.count}`);

  lines.push('# HELP pdf_cache_hits_total PDF cache hits.');
  lines.push('# TYPE pdf_cache_hits_total counter');
  lines.push(`pdf_cache_hits_total ${pdfCacheHits}`);
  lines.push('# HELP pdf_cache_misses_total PDF cache misses.');
  lines.push('# TYPE pdf_cache_misses_total counter');
  lines.push(`pdf_cache_misses_total ${pdfCacheMisses}`);

  lines.push('# HELP slow_requests_total Requests slower than SLOW_REQUEST_MS.');
  lines.push('# TYPE slow_requests_total counter');
  lines.push(`slow_requests_total ${slowRequests}`);

  lines.push('# HELP process_uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);

  lines.push('# HELP db_up Whether the database responds to SELECT 1.');
  lines.push('# TYPE db_up gauge');
  lines.push(`db_up ${options.dbUp ? 1 : 0}`);

  lines.push('# HELP db_pool_total_connections Current PostgreSQL pool connections.');
  lines.push('# TYPE db_pool_total_connections gauge');
  lines.push(`db_pool_total_connections ${options.dbPool.total}`);
  lines.push('# HELP db_pool_idle_connections Idle PostgreSQL pool connections.');
  lines.push('# TYPE db_pool_idle_connections gauge');
  lines.push(`db_pool_idle_connections ${options.dbPool.idle}`);
  lines.push('# HELP db_pool_waiting_requests Requests waiting for a pool connection.');
  lines.push('# TYPE db_pool_waiting_requests gauge');
  lines.push(`db_pool_waiting_requests ${options.dbPool.waiting}`);
  lines.push('# HELP db_pool_max_connections Configured pool size per process.');
  lines.push('# TYPE db_pool_max_connections gauge');
  lines.push(`db_pool_max_connections ${options.dbPool.max}`);

  lines.push('# HELP redis_configured Whether REDIS_URL is configured.');
  lines.push('# TYPE redis_configured gauge');
  lines.push(`redis_configured ${options.redisConfigured ? 1 : 0}`);
  lines.push('# HELP redis_up Whether Redis responds to PING.');
  lines.push('# TYPE redis_up gauge');
  lines.push(`redis_up ${options.redisUp ? 1 : 0}`);

  lines.push('# HELP pdf_jobs_pending PDF jobs waiting in the database queue.');
  lines.push('# TYPE pdf_jobs_pending gauge');
  lines.push(`pdf_jobs_pending ${options.pdfQueue.pending}`);
  lines.push('# HELP pdf_jobs_running PDF jobs currently being rendered.');
  lines.push('# TYPE pdf_jobs_running gauge');
  lines.push(`pdf_jobs_running ${options.pdfQueue.running}`);
  lines.push('# HELP pdf_jobs_done_24h PDF jobs completed in the last 24 hours.');
  lines.push('# TYPE pdf_jobs_done_24h gauge');
  lines.push(`pdf_jobs_done_24h ${options.pdfQueue.done24h}`);
  lines.push('# HELP pdf_jobs_failed_24h PDF jobs failed in the last 24 hours.');
  lines.push('# TYPE pdf_jobs_failed_24h gauge');
  lines.push(`pdf_jobs_failed_24h ${options.pdfQueue.failed24h}`);
  lines.push('# HELP pdf_jobs_oldest_pending_seconds Age of the oldest queued PDF job.');
  lines.push('# TYPE pdf_jobs_oldest_pending_seconds gauge');
  lines.push(`pdf_jobs_oldest_pending_seconds ${options.pdfQueue.oldestPendingSeconds}`);

  return `${lines.join('\n')}\n`;
}

/** 仅测试用：清空进程内计数。 */
export function resetMetrics(): void {
  pdfCacheHits = 0;
  pdfCacheMisses = 0;
  requests.clear();
  durations.count = 0;
  durations.totalMs = 0;
  durations.buckets = BUCKETS_MS.map(() => 0);
  slowRequests = 0;
  startedAt = Date.now();
}
