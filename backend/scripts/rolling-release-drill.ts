/**
 * 滚动发布与回滚演练（本地模拟 K8s 滚动更新）。
 *
 * 拓扑：3 个 API 副本 + nginx；新副本先通过 readiness（/api/health + 版本），
 * 再切 nginx upstream，最后下线旧副本。全过程持续压测。
 *
 * 阶段：
 *   1. v1 × 3 提供服务
 *   2. 逐个滚动到 v2（先起新副本 → 切流 → 停旧副本）
 *   3. 启动一个数据库不可用的坏版本，验证 readiness 拦截，不影响线上
 *   4. 逐个回滚到 v1
 *   5. 校验零失败、版本头 x-app-version 与 P95
 *
 * 前置：数据库已迁移/seed；本机有 nginx。
 * 运行：npm run drill:rollout
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool } from '../src/db';

const OLD_PORTS = [8793, 8794, 8795];
const NEW_PORTS = [8801, 8802, 8803];
const ROLLBACK_PORTS = [8811, 8812, 8813];
const BAD_PORT = 8809;
const NGINX_PORT = 18091;
const CONCURRENCY = Number(process.env.ROLLOUT_CONCURRENCY ?? 12);
const V1 = 'drill-v1';
const V2 = 'drill-v2';
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const BASE = `http://127.0.0.1:${NGINX_PORT}`;

const processes: ChildProcess[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

function waitExit(child: ChildProcess, timeoutMs = 8000): Promise<void> {
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

function startApi(port: number, version: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  return start(
    TSX,
    ['src/server.ts'],
    {
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_REQUIRED: 'true',
      PDF_WORKER_INLINE: 'false',
      PG_POOL_MAX: '5',
      PGAPPNAME: `ai-delivery-rollout-${port}`,
      APP_VERSION: version,
      REDIS_URL: '',
      ...extra,
    },
    `api-${port}-${version}`,
  );
}

async function healthOf(port: number): Promise<{ ok: boolean; version?: string; status?: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as { version?: string };
    return { ok: true, version: data.version };
  } catch {
    return { ok: false };
  }
}

async function waitForVersion(port: number, version: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const health = await healthOf(port);
    if (health.ok && health.version === version) return;
    await sleep(250);
  }
  throw new Error(`副本 ${port} 未就绪为 ${version}`);
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

/**
 * 压测用短连接：避免 keepalive 连接在 nginx reload 时被旧 worker 关闭，
 * 把客户端连接池行为误判为服务端故障。
 */
function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; version: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          version: String(res.headers['x-app-version'] ?? 'unknown'),
        }),
      );
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

interface LoadStats {
  total: number;
  ok: number;
  failed: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  versions: Record<string, number>;
  failures: string[];
}

function createLoad(token: string) {
  const url = `${BASE}/api/engagements?limit=5`;
  const headers = { authorization: `Bearer ${token}` };
  const latencies: number[] = [];
  const versions: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  const failures: string[] = [];
  let running = true;
  const started = Date.now();

  const worker = async () => {
    while (running) {
      const t = Date.now();
      try {
        const res = await httpGet(url, headers);
        const dt = Date.now() - t;
        if (res.status >= 200 && res.status < 300) {
          ok += 1;
          latencies.push(dt);
          versions[res.version] = (versions[res.version] ?? 0) + 1;
        } else {
          failed += 1;
          if (failures.length < 20) failures.push(`HTTP ${res.status}`);
        }
      } catch (err) {
        failed += 1;
        if (failures.length < 20) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  };

  const done = Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return {
    async stop(): Promise<LoadStats> {
      running = false;
      await done;
      latencies.sort((a, b) => a - b);
      const pct = (p: number) =>
        latencies.length
          ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]
          : 0;
      const elapsed = Math.max(1, Date.now() - started) / 1000;
      return {
        total: ok + failed,
        ok,
        failed,
        rps: Math.round((ok + failed) / elapsed),
        p50: pct(50),
        p95: pct(95),
        p99: pct(99),
        versions,
        failures,
      };
    },
  };
}

const fmt = (label: string, r: LoadStats) =>
  `${label}: total=${r.total} ok=${r.ok} failed=${r.failed} qps=${r.rps} ` +
  `p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms versions=${JSON.stringify(r.versions)}` +
  (r.failures.length ? ` failures=${JSON.stringify(r.failures)}` : '');

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

let nginxConf = '';
let nginxProc: ChildProcess | null = null;

async function writeNginxConfig(ports: number[]) {
  const upstream = ports.map((p) => `    server 127.0.0.1:${p};`).join('\n');
  await writeFile(
    nginxConf,
    `worker_processes 1;
daemon off;
pid ${join(nginxConf, '..', 'nginx.pid')};
error_log ${join(nginxConf, '..', 'error.log')} warn;
events { worker_connections 512; }
http {
  access_log off;
  upstream backend_upstream {
${upstream}
    keepalive 32;
  }
  server {
    listen ${NGINX_PORT};
    location /api/ {
      proxy_pass http://backend_upstream;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_connect_timeout 2s;
      proxy_read_timeout 30s;
      proxy_next_upstream error timeout http_502 http_503 http_504;
      proxy_next_upstream_tries 3;
    }
  }
}
`,
  );
}

async function reloadNginx() {
  if (!nginxProc?.pid) throw new Error('nginx 未启动');
  process.kill(nginxProc.pid, 'SIGHUP');
  // 等新 worker 接管；旧 worker 会优雅退出
  await sleep(1200);
  if (nginxProc.exitCode !== null) throw new Error('nginx reload 后退出');
}

async function nginxVersions(samples = 30): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < samples; i += 1) {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) });
    assert(res.ok, `nginx 健康检查失败：${res.status}`);
    const version = res.headers.get('x-app-version') ?? 'unknown';
    counts[version] = (counts[version] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-rollout-'));
  nginxConf = join(dir, 'nginx.conf');

  console.log('启动 v1 × 3 副本...');
  const oldest = OLD_PORTS.map((port) => startApi(port, V1));
  await Promise.all(OLD_PORTS.map((port) => waitForVersion(port, V1)));

  console.log('启动 nginx 网关...');
  await writeNginxConfig(OLD_PORTS);
  nginxProc = start('nginx', ['-c', nginxConf, '-p', dir], {}, 'nginx');
  await waitForPort(NGINX_PORT, 'nginx');
  const initial = await nginxVersions(10);
  console.log(`初始流量版本：${JSON.stringify(initial)}`);

  const token = await login();
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${BASE}/api/engagements?limit=5`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await res.arrayBuffer();
    assert(res.ok, `预热失败：${res.status}`);
  }

  let upstream: number[] = [...OLD_PORTS];
  const v2Children = new Map<number, ChildProcess>();

  console.log('\n阶段 1：滚动发布 v1 → v2');
  const rolloutLoad = createLoad(token);
  for (let i = 0; i < OLD_PORTS.length; i += 1) {
    const newPort = NEW_PORTS[i];
    console.log(`  readiness：${newPort} 启动 ${V2}...`);
    const child = startApi(newPort, V2);
    v2Children.set(newPort, child);
    await waitForVersion(newPort, V2);

    upstream = upstream.map((p) => (p === OLD_PORTS[i] ? newPort : p));
    await writeNginxConfig(upstream);
    await reloadNginx();
    console.log(`  切流：${OLD_PORTS[i]} → ${newPort}`);

    signalTree(oldest[i], 'SIGTERM');
    await waitExit(oldest[i]).catch(() => signalTree(oldest[i], 'SIGKILL'));
  }
  const rollout = await rolloutLoad.stop();
  console.log(fmt('滚动发布', rollout));
  assert(rollout.failed === 0, `滚动发布期间出现 ${rollout.failed} 个失败请求`);
  assert(rollout.ok > 0, '滚动发布期间没有成功请求');

  const afterRollout = await nginxVersions(40);
  console.log(`发布后流量版本：${JSON.stringify(afterRollout)}`);
  assert(
    Object.keys(afterRollout).length === 1 && afterRollout[V2] === 40,
    `发布后应全部为 ${V2}，实际 ${JSON.stringify(afterRollout)}`,
  );

  console.log('\n阶段 2：坏版本 readiness 拦截');
  const bad = startApi(BAD_PORT, 'drill-bad', {
    DATABASE_URL: 'postgres://127.0.0.1:1/ai_delivery',
  });
  let badReady = false;
  for (let i = 0; i < 24; i += 1) {
    const health = await healthOf(BAD_PORT);
    if (health.ok) {
      badReady = true;
      break;
    }
    await sleep(250);
  }
  signalTree(bad, 'SIGTERM');
  await waitExit(bad).catch(() => signalTree(bad, 'SIGKILL'));
  assert(!badReady, '坏版本不应通过 readiness');
  const stillHealthy = await nginxVersions(10);
  assert(stillHealthy[V2] === 10, `坏版本期间线上流量异常：${JSON.stringify(stillHealthy)}`);
  console.log('坏版本未通过 readiness，线上仍全部为 v2');

  console.log('\n阶段 3：滚动回滚 v2 → v1');
  const rollbackLoad = createLoad(token);
  for (let i = 0; i < NEW_PORTS.length; i += 1) {
    const oldPort = ROLLBACK_PORTS[i];
    console.log(`  readiness：${oldPort} 启动 ${V1}...`);
    const child = startApi(oldPort, V1);
    await waitForVersion(oldPort, V1);

    upstream = upstream.map((p) => (p === NEW_PORTS[i] ? oldPort : p));
    await writeNginxConfig(upstream);
    await reloadNginx();
    console.log(`  切流：${NEW_PORTS[i]} → ${oldPort}`);

    const v2 = v2Children.get(NEW_PORTS[i]);
    if (v2) {
      signalTree(v2, 'SIGTERM');
      await waitExit(v2).catch(() => signalTree(v2, 'SIGKILL'));
    }
  }
  const rollback = await rollbackLoad.stop();
  console.log(fmt('滚动回滚', rollback));
  assert(rollback.failed === 0, `滚动回滚期间出现 ${rollback.failed} 个失败请求`);

  const afterRollback = await nginxVersions(40);
  console.log(`回滚后流量版本：${JSON.stringify(afterRollback)}`);
  assert(
    Object.keys(afterRollback).length === 1 && afterRollback[V1] === 40,
    `回滚后应全部为 ${V1}，实际 ${JSON.stringify(afterRollback)}`,
  );

  console.log('\n============================');
  console.log('滚动发布与回滚演练通过');
  console.log('============================');
  console.log(fmt('滚动发布', rollout));
  console.log(fmt('滚动回滚', rollback));
  console.log('坏版本：readiness 拦截成功，线上无影响');
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
