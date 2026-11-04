/**
 * 多副本持续压测与故障演练。
 *
 * 拓扑：2 个 API 副本（8791/8792）+ nginx（18090）+ 独立 Redis（6391）+ 2 个 PDF worker
 *
 * 阶段：
 *   1. 持续并发压测，统计 QPS / P50 / P95 / P99 / 连接池峰值
 *   2. 压测中杀掉一个 API，验证 nginx 故障切换；随后重启副本验证恢复
 *   3. Redis 宕机：登录限流与会话校验回退内存/数据库
 *   4. PDF 队列积压：2 个 worker 分担完成
 *   5. /metrics 探活与指标输出
 *
 * 前置：数据库已迁移/seed；本机有 nginx 与 redis-server。
 * 运行：npm run soak:replicas
 * 可调：SOAK_CONCURRENCY / SOAK_DURATION_MS / SOAK_P95_LIMIT_MS / SOAK_PDF_JOBS / PG_POOL_MAX
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, one, query } from '../src/db';

const API_PORTS = (process.env.SOAK_API_PORTS ?? '8791,8792').split(',').map(Number);
const NGINX_PORT = Number(process.env.SOAK_NGINX_PORT ?? 18090);
const REDIS_PORT = Number(process.env.SOAK_REDIS_PORT ?? 6391);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY ?? 16);
const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 3000);
const P95_LIMIT_MS = Number(process.env.SOAK_P95_LIMIT_MS ?? 1500);
const PG_POOL_MAX = Number(process.env.PG_POOL_MAX ?? 5);
const PDF_JOBS = Number(process.env.SOAK_PDF_JOBS ?? 4);
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
const BASE = `http://127.0.0.1:${NGINX_PORT}`;
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');

const processes: ChildProcess[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hasBinary(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

/** 直接启动 tsx，避免 npm 包装进程导致信号杀不到真实服务。 */
function start(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): ChildProcess {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.on('error', (err) => console.error(`[${label}] 启动失败：${err.message}`));
  processes.push(child);
  return child;
}

/** 杀整个进程组：tsx / npm 可能再派生 node 子进程。 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已退出 */
    }
  }
}

function waitExit(child: ChildProcess, timeoutMs = 6000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待进程退出超时')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopAll(): Promise<void> {
  for (const child of [...processes].reverse()) signalTree(child, 'SIGTERM');
  await sleep(1500);
  for (const child of processes) {
    if (child.exitCode === null) signalTree(child, 'SIGKILL');
  }
}

async function waitForPort(port: number, label: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`${label} 端口未就绪：${port}`);
}

async function waitForHttp(url: string, label: string, headers?: Record<string, string>, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`${label} 未就绪：${url}`);
}

function startApi(port: number, redisEnabled: boolean): ChildProcess {
  return start(
    TSX,
    ['src/server.ts'],
    {
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_REQUIRED: 'true',
      PDF_WORKER_INLINE: 'false',
      PG_POOL_MAX: String(PG_POOL_MAX),
      PGAPPNAME: `ai-delivery-soak-api-${port}`,
      REDIS_URL: redisEnabled ? REDIS_URL : '',
    },
    `api-${port}`,
  );
}

function startWorker(index: number): ChildProcess {
  return start(
    TSX,
    ['scripts/pdf-worker.ts'],
    {
      PG_POOL_MAX: String(PG_POOL_MAX),
      PGAPPNAME: 'ai-delivery-soak-worker',
      PDF_JOB_LEASE_MINUTES: '15',
      SKIP_MIGRATIONS: 'true',
    },
    `worker-${index}`,
  );
}

async function startRedis(): Promise<ChildProcess | null> {
  if (!hasBinary('redis-server')) {
    console.warn('未找到 redis-server，跳过 Redis 故障阶段');
    return null;
  }
  const child = start(
    'redis-server',
    ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'],
    {},
    'redis',
  );
  await waitForPort(REDIS_PORT, 'Redis');
  return child;
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@hengzhi.ai', password: 'demo1234', org_slug: 'hengzhi' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`登录失败：${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('登录响应缺少 token');
  return data.token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

interface LoadResult {
  total: number;
  ok: number;
  failed: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  peakConnections: number;
}

async function runLoad(token: string, durationMs: number): Promise<LoadResult> {
  const url = `${BASE}/api/engagements?limit=5`;
  const headers = auth(token);
  const started = Date.now();
  const deadline = started + durationMs;
  const latencies: number[] = [];
  let ok = 0;
  let failed = 0;
  let peakConnections = 0;
  let sampling = true;

  // 只统计本脚本启动的 API/worker 连接，避免被本机其他服务干扰。
  const sampler = (async () => {
    while (sampling) {
      try {
        const row = await one<{ c: number }>(
          `SELECT count(*)::int AS c FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name LIKE 'ai-delivery-soak-%'`,
        );
        if (row) peakConnections = Math.max(peakConnections, row.c);
      } catch {
        /* 采样失败不影响压测 */
      }
      await sleep(200);
    }
  })();

  const worker = async () => {
    while (Date.now() < deadline) {
      const t = Date.now();
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        await res.arrayBuffer();
        const dt = Date.now() - t;
        if (res.ok) {
          ok += 1;
          latencies.push(dt);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  sampling = false;
  await sampler;

  latencies.sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0;
  const elapsed = Math.max(1, Date.now() - started) / 1000;
  return {
    total: ok + failed,
    ok,
    failed,
    rps: Math.round((ok + failed) / elapsed),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    maxMs: latencies.length ? latencies[latencies.length - 1] : 0,
    peakConnections,
  };
}

const fmt = (label: string, r: LoadResult) =>
  `${label}: total=${r.total} ok=${r.ok} failed=${r.failed} qps=${r.rps} ` +
  `p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms max=${r.maxMs}ms peak_conn=${r.peakConnections}`;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-soak-'));
  const nginxConf = join(dir, 'nginx.conf');
  await writeFile(
    nginxConf,
    `worker_processes 1;
daemon off;
pid ${join(dir, 'nginx.pid')};
error_log ${join(dir, 'error.log')} warn;
events { worker_connections 512; }
http {
  access_log off;
  upstream backend_upstream {
    server 127.0.0.1:${API_PORTS[0]};
    server 127.0.0.1:${API_PORTS[1]};
  }
  server {
    listen ${NGINX_PORT};
    location /api/ {
      proxy_pass http://backend_upstream;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_connect_timeout 3s;
      proxy_next_upstream error timeout http_502 http_503 http_504;
      proxy_next_upstream_tries 2;
    }
  }
}
`,
  );

  const redisProc = await startRedis();
  const redisEnabled = Boolean(redisProc);

  console.log('启动 API 副本...');
  const apis = API_PORTS.map((port) => startApi(port, redisEnabled));
  await Promise.all(
    API_PORTS.map((port) => waitForHttp(`http://127.0.0.1:${port}/api/health`, `API ${port}`)),
  );

  console.log('启动 nginx 网关...');
  start('nginx', ['-c', nginxConf, '-p', dir], {}, 'nginx');
  await waitForHttp(`${BASE}/api/health`, 'nginx');

  const token = await login();
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${BASE}/api/engagements?limit=5`, { headers: auth(token) });
    await res.arrayBuffer();
    assert(res.ok, `预热请求失败：${res.status}`);
  }

  console.log(`\n阶段 1：持续压测 ${DURATION_MS}ms / 并发 ${CONCURRENCY}`);
  const normal = await runLoad(token, DURATION_MS);
  console.log(fmt('压测', normal));
  assert(normal.failed === 0, `压测出现 ${normal.failed} 个失败请求`);
  assert(normal.p95 <= P95_LIMIT_MS, `P95 ${normal.p95}ms 超过阈值 ${P95_LIMIT_MS}ms`);
  assert(
    normal.peakConnections <= API_PORTS.length * PG_POOL_MAX,
    `连接池峰值 ${normal.peakConnections} 超过上限 ${API_PORTS.length * PG_POOL_MAX}`,
  );

  console.log('\n阶段 2：压测中杀掉一个 API 副本');
  const failoverLoad = runLoad(token, DURATION_MS + 1500);
  await sleep(Math.floor(DURATION_MS * 0.5));
  signalTree(apis[0], 'SIGTERM');
  const failover = await failoverLoad;
  console.log(fmt('故障切换', failover));
  const tolerated = Math.max(1, Math.ceil(failover.total * 0.02));
  assert(failover.ok > 0, '故障切换期间没有任何成功请求');
  assert(
    failover.failed <= tolerated,
    `故障切换失败 ${failover.failed} 个，超过容忍值 ${tolerated}/${failover.total}`,
  );
  await waitExit(apis[0]).catch(() => signalTree(apis[0], 'SIGKILL'));

  console.log('重启被杀的副本并验证恢复...');
  apis[0] = startApi(API_PORTS[0], redisEnabled);
  await waitForHttp(`http://127.0.0.1:${API_PORTS[0]}/api/health`, 'API 恢复');
  const recovered = await runLoad(token, 1200);
  console.log(fmt('恢复后', recovered));
  assert(recovered.failed === 0, `副本恢复后仍有 ${recovered.failed} 个失败请求`);

  console.log('\n阶段 3：Redis 故障演练');
  const cacheBefore = await fetch(`${BASE}/api/system/cache`, { headers: auth(token) });
  assert(cacheBefore.ok, `读取缓存状态失败：${cacheBefore.status}`);
  const before = (await cacheBefore.json()) as { driver: string; healthy: boolean };
  if (redisEnabled) {
    assert(before.driver === 'redis', `配置 Redis 后驱动应为 redis，实际 ${before.driver}`);
    assert(before.healthy === true, 'Redis 应处于健康状态');
    signalTree(redisProc as ChildProcess, 'SIGTERM');
    await waitExit(redisProc as ChildProcess).catch(() => undefined);

    let after: { driver: string; healthy: boolean } = { driver: '', healthy: true };
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${BASE}/api/system/cache`, { headers: auth(token) });
      assert(res.ok, `Redis 故障后读取缓存状态失败：${res.status}`);
      after = (await res.json()) as { driver: string; healthy: boolean };
      if (!after.healthy) break;
      await sleep(250);
    }
    assert(after.driver === 'redis', `Redis 客户端应仍为 redis，实际 ${after.driver}`);
    assert(after.healthy === false, 'Redis 已停止，健康检查应为 false');

    const tokenAfterRedis = await login();
    const sessionRes = await fetch(`${BASE}/api/engagements?limit=1`, {
      headers: auth(tokenAfterRedis),
    });
    await sessionRes.arrayBuffer();
    assert(sessionRes.status === 200, `Redis 故障后会话校验失败：${sessionRes.status}`);
    console.log('Redis 故障：登录限流回退内存，会话校验回退数据库，请求正常');
  } else {
    assert(before.driver === 'memory', `未配置 Redis 时驱动应为 memory，实际 ${before.driver}`);
    console.log('未启用 Redis：已确认内存驱动');
  }

  console.log('\n阶段 4：PDF 队列积压');
  for (const i of [1, 2]) startWorker(i);
  const engagement = await one<{ id: string }>(
    `SELECT id FROM engagements WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  if (!engagement) throw new Error('没有可用于 PDF 冒烟的项目');
  const generated = await fetch(`${BASE}/api/deliverables/generate`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify({ engagementId: engagement.id, type: 'diagnosis_report' }),
  });
  if (!generated.ok) throw new Error(`生成交付物失败：${generated.status} ${await generated.text()}`);
  const deliverable = ((await generated.json()) as { id: string }).id;

  for (let i = 0; i < PDF_JOBS; i += 1) {
    const job = await fetch(`${BASE}/api/deliverables/${deliverable}/pdf-jobs`, {
      method: 'POST',
      headers: auth(token),
    });
    if (job.status !== 202) throw new Error(`创建 PDF 任务失败：${job.status}`);
  }

  const pdfStarted = Date.now();
  let done = 0;
  for (let i = 0; i < 240; i += 1) {
    const row = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM pdf_jobs
        WHERE deliverable_id = $1 AND status = 'done'`,
      [deliverable],
    );
    done = row?.count ?? 0;
    if (done === PDF_JOBS) break;
    await sleep(500);
  }
  if (done !== PDF_JOBS) throw new Error(`PDF 任务未完成：done=${done}/${PDF_JOBS}`);
  console.log(`PDF 双 worker：${PDF_JOBS}/${PDF_JOBS} 完成，耗时 ${Date.now() - pdfStarted}ms`);
  await query(`DELETE FROM deliverables WHERE id = $1`, [deliverable]);

  console.log('\n阶段 5：指标与探活');
  const metrics = await fetch(`http://127.0.0.1:${API_PORTS[1]}/metrics`);
  assert(metrics.ok, `读取 /metrics 失败：${metrics.status}`);
  const text = await metrics.text();
  assert(text.includes('db_up 1'), '/metrics 中 db_up 应为 1');
  assert(/http_request_duration_ms_count \d+/.test(text), '/metrics 缺少请求耗时计数');
  assert(text.includes('http_requests_total{'), '/metrics 缺少请求量指标');
  assert(text.includes('db_pool_total_connections'), '/metrics 缺少连接池指标');
  assert(text.includes('redis_configured'), '/metrics 缺少 Redis 指标');
  assert(text.includes('pdf_jobs_pending'), '/metrics 缺少 PDF 队列指标');
  console.log('/metrics：db_up=1，请求量/耗时/连接池/Redis/PDF 队列指标正常');

  console.log('\n============================');
  console.log('多副本压测与故障演练通过');
  console.log('============================');
  console.log(fmt('持续压测  ', normal));
  console.log(fmt('故障切换  ', failover));
  console.log(fmt('副本恢复后', recovered));
  console.log(`Redis：${redisEnabled ? '宕机回退正常' : '未启用（内存模式）'}`);
  console.log(`PDF：${PDF_JOBS} 个任务由 2 个 worker 完成`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopAll();
    await closePool();
  });
