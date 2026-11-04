/**
 * 本地多副本冒烟：
 *   - 启动 2 个 API（8791/8792）+ nginx（18090）
 *   - 并发请求正常；杀掉一个 API 后，经 nginx 的请求仍然成功
 *   - 启动 2 个 PDF worker，验证队列任务完成
 *
 * 前置：数据库已迁移/seed，Redis 可选，本机有 nginx。
 * 运行：npm run smoke:replicas
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, one, query } from '../src/db';

const PORTS = [8791, 8792];
const NGINX_PORT = 18090;
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const children: ChildProcess[] = [];
const logs: string[] = [];

async function waitFor(url: string, label: string, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} 未就绪：${url}`);
}

function start(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string) {
  const log = `/tmp/ai-replica-${label}.log`;
  logs.push(log);
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  children.push(child);
  return child;
}

/** 杀整个进程组：tsx / npm 可能再派生 node 子进程。 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
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

async function stopAll() {
  for (const child of [...children].reverse()) signalTree(child, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  for (const child of children) {
    if (child.exitCode === null) signalTree(child, 'SIGKILL');
  }
}

async function parallelFetch(url: string, count: number) {
  const results = await Promise.all(
    Array.from({ length: count }, async () => {
      try {
        const res = await fetch(url);
        return res.status;
      } catch {
        return 0;
      }
    }),
  );
  return results;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-replica-'));
  const nginxConf = join(dir, 'nginx.conf');
  await writeFile(
    nginxConf,
    `worker_processes 1;
daemon off;
pid ${join(dir, 'nginx.pid')};
error_log ${join(dir, 'error.log')} warn;
events { worker_connections 256; }
http {
  access_log off;
  upstream backend_upstream {
    server 127.0.0.1:${PORTS[0]};
    server 127.0.0.1:${PORTS[1]};
  }
  server {
    listen ${NGINX_PORT};
    location /api/ {
      proxy_pass http://backend_upstream;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_next_upstream error timeout http_502 http_503 http_504;
      proxy_next_upstream_tries 2;
    }
  }
}
`,
  );

  console.log('启动 API 副本...');
  for (const port of PORTS) {
    start(TSX, ['src/server.ts'], {
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_REQUIRED: 'false',
      PDF_WORKER_INLINE: 'false',
    } as NodeJS.ProcessEnv, `api-${port}`);
  }
  await Promise.all(PORTS.map((p) => waitFor(`http://127.0.0.1:${p}/api/health`, `API ${p}`)));

  console.log('启动 nginx 网关...');
  start('nginx', ['-c', nginxConf, '-p', dir], {}, 'nginx');
  await waitFor(`http://127.0.0.1:${NGINX_PORT}/api/health`, 'nginx');

  const first = await parallelFetch(`http://127.0.0.1:${NGINX_PORT}/api/engagements?limit=5`, 40);
  const firstBad = first.filter((s) => s !== 200);
  if (firstBad.length) throw new Error(`首轮请求失败 ${firstBad.length}/40`);

  console.log('杀掉一个 API 副本，验证 nginx 故障切换...');
  signalTree(children[0], 'SIGTERM');
  await new Promise((r) => setTimeout(r, 800));

  const second = await parallelFetch(`http://127.0.0.1:${NGINX_PORT}/api/engagements?limit=5`, 40);
  const secondBad = second.filter((s) => s !== 200);
  if (secondBad.length) throw new Error(`故障切换后请求失败 ${secondBad.length}/40`);
  console.log('故障切换请求：40/40 成功');

  console.log('启动 2 个 PDF worker...');
  for (const i of [1, 2]) {
    start(TSX, ['scripts/pdf-worker.ts'], {
      PDF_JOB_LEASE_MINUTES: '15',
    } as NodeJS.ProcessEnv, `worker-${i}`);
  }

  const engagement = await one<{ id: string }>(
    `SELECT id FROM engagements WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  if (!engagement) throw new Error('没有可用于 PDF 冒烟的项目');
  const generated = await fetch(`http://127.0.0.1:${NGINX_PORT}/api/deliverables/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engagementId: engagement.id, type: 'diagnosis_report' }),
  });
  if (!generated.ok) throw new Error(`生成交付物失败：${generated.status} ${await generated.text()}`);
  const deliverable = ((await generated.json()) as { id: string }).id;

  for (let i = 0; i < 2; i += 1) {
    const job = await fetch(
      `http://127.0.0.1:${NGINX_PORT}/api/deliverables/${deliverable}/pdf-jobs`,
      { method: 'POST' },
    );
    if (job.status !== 202) throw new Error(`创建 PDF 任务失败：${job.status}`);
  }

  let done = 0;
  for (let i = 0; i < 120; i += 1) {
    const row = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM pdf_jobs
        WHERE deliverable_id = $1 AND status = 'done'`,
      [deliverable],
    );
    done = row?.count ?? 0;
    if (done === 2) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (done !== 2) throw new Error(`PDF 任务未完成：done=${done}/2`);

  await query(`DELETE FROM deliverables WHERE id = $1`, [deliverable]);
  console.log('PDF 双 worker：2/2 任务完成');
  console.log('多副本冒烟通过：API failover + 双 worker');
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
