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

export function renderPrometheus(options: { dbUp: boolean }): string {
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

  lines.push('# HELP slow_requests_total Requests slower than SLOW_REQUEST_MS.');
  lines.push('# TYPE slow_requests_total counter');
  lines.push(`slow_requests_total ${slowRequests}`);

  lines.push('# HELP process_uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);

  lines.push('# HELP db_up Whether the database responds to SELECT 1.');
  lines.push('# TYPE db_up gauge');
  lines.push(`db_up ${options.dbUp ? 1 : 0}`);

  return `${lines.join('\n')}\n`;
}

/** 仅测试用：清空进程内计数。 */
export function resetMetrics(): void {
  requests.clear();
  durations.count = 0;
  durations.totalMs = 0;
  durations.buckets = BUCKETS_MS.map(() => 0);
  slowRequests = 0;
  startedAt = Date.now();
}
