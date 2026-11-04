/**
 * S3 / MinIO 对象存储真实联调（本地 S3 兼容服务）。
 *
 * 阶段：
 *   1. 启动 s3rver，自动创建 bucket
 *   2. 直接验证 S3Storage：PUT / GET / DELETE / 缺失 key / Content-Type / prefix
 *   3. 跨进程读取：子进程只配置 S3，读取父进程写入的对象
 *   4. 端到端：API + 2 个 PDF worker 使用 S3，创建 PDF 任务并校验缓存对象
 *
 * 前置：本机可运行 tsx / Chromium（PDF 阶段）。
 * 运行：npm run drill:s3
 * 端口：S3_DRILL_PORT（默认 4599）、S3_DRILL_API_PORT（默认 8797）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { closePool, one, query } from '../src/db';

const S3_PORT = Number(process.env.S3_DRILL_PORT ?? 4599);
const API_PORT = Number(process.env.S3_DRILL_API_PORT ?? 8797);
const BUCKET = 'ai-delivery-drill';
const PREFIX = 'drill';
const REGION = 'us-east-1';
const ACCESS_KEY = 'S3RVER';
const SECRET_KEY = 'S3RVER';
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const BASE = `http://127.0.0.1:${API_PORT}`;

const processes: ChildProcess[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const s3Env: NodeJS.ProcessEnv = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
  S3_REGION: REGION,
  S3_BUCKET: BUCKET,
  S3_PREFIX: PREFIX,
  S3_ACCESS_KEY_ID: ACCESS_KEY,
  S3_SECRET_ACCESS_KEY: SECRET_KEY,
  S3_FORCE_PATH_STYLE: 'true',
};

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

async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
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

async function waitForHttp(url: string, label: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`${label} 未就绪：${url}`);
}

function startApi(): ChildProcess {
  return start(
    TSX,
    ['src/server.ts'],
    {
      ...s3Env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      AUTH_REQUIRED: 'false',
      PDF_WORKER_INLINE: 'false',
      PG_POOL_MAX: '5',
      PGAPPNAME: 'ai-delivery-s3-api',
      APP_VERSION: 's3-drill',
      REDIS_URL: '',
    },
    'api',
  );
}

function startWorker(index: number): ChildProcess {
  return start(
    TSX,
    ['scripts/pdf-worker.ts'],
    {
      ...s3Env,
      PG_POOL_MAX: '5',
      PGAPPNAME: 'ai-delivery-s3-worker',
      PDF_JOB_LEASE_MINUTES: '15',
      SKIP_MIGRATIONS: 'true',
    },
    `worker-${index}`,
  );
}

function runProbe(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, args, {
      env: { ...process.env, ...s3Env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-s3-drill-'));
  let s3: S3rver | null = null;

  try {
    assert(!(await portInUse(S3_PORT)), `端口 ${S3_PORT} 已被占用`);
    assert(!(await portInUse(API_PORT)), `端口 ${API_PORT} 已被占用`);

    console.log(`1/4 启动 S3 兼容服务 :${S3_PORT}...`);
    s3 = new S3rver({
      port: S3_PORT,
      address: '127.0.0.1',
      silent: true,
      directory: join(dir, 'objects'),
      configureBuckets: [{ name: BUCKET }],
    });
    await s3.run();
    await waitForPort(S3_PORT, 'S3 兼容服务');

    const s3Client = new S3Client({
      region: REGION,
      endpoint: `http://127.0.0.1:${S3_PORT}`,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    console.log('2/4 验证对象存储抽象...');
    Object.assign(process.env, s3Env);
    const { objectStorage } = await import('../src/services/object_storage');
    const storage = objectStorage();
    assert(storage.driver === 's3', `存储驱动应为 s3，实际 ${storage.driver}`);

    const directKey = `direct/hello-${Date.now()}.txt`;
    const directBody = Buffer.from(`hello-s3-${Date.now()}`);
    await storage.put(directKey, directBody, 'text/plain');

    const got = await storage.get(directKey);
    assert(got?.equals(directBody), 'S3 GET 内容不一致');

    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/${directKey}` }),
    );
    assert(head.ContentType === 'text/plain', `Content-Type 应为 text/plain，实际 ${head.ContentType}`);

    const listed = await s3Client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/direct/` }),
    );
    assert(
      listed.Contents?.some((item) => item.Key === `${PREFIX}/${directKey}`),
      'S3 前缀下未找到刚写入的对象',
    );

    assert((await storage.get('direct/missing.txt')) === null, '缺失 key 应返回 null');

    await storage.delete(directKey);
    assert((await storage.get(directKey)) === null, 'DELETE 后仍能读取对象');
    console.log('    PUT / GET / DELETE / 404 / Content-Type / prefix 正常');

    console.log('3/4 验证跨进程读取...');
    const crossKey = `cross/payload-${Date.now()}.bin`;
    const crossBody = Buffer.from(`cross-process-${Date.now()}`);
    await storage.put(crossKey, crossBody, 'application/octet-stream');

    const probe = await runProbe(['scripts/s3-read-probe.ts', crossKey]);
    assert(probe.code === 0, `子进程读取失败：${probe.stderr || probe.stdout}`);
    const probeBody = Buffer.from(probe.stdout.trim(), 'base64');
    assert(probeBody.equals(crossBody), '跨进程读取内容不一致');
    await storage.delete(crossKey);
    console.log('    子进程通过 S3 读取到与父进程一致的内容');

    console.log('4/4 API + 2 个 PDF worker 端到端验证...');
    startApi();
    await waitForHttp(`${BASE}/api/health`, 'API');
    for (const i of [1, 2]) startWorker(i);

    const engagement = await one<{ id: string }>(
      `SELECT id FROM engagements WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    );
    assert(engagement !== null, '没有可用于 PDF 联调的项目');

    const generated = await fetch(`${BASE}/api/deliverables/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engagementId: engagement.id, type: 'diagnosis_report' }),
    });
    if (!generated.ok) {
      throw new Error(`生成交付物失败：${generated.status} ${await generated.text()}`);
    }
    const deliverable = ((await generated.json()) as { id: string }).id;

    const JOB_COUNT = 2;
    for (let i = 0; i < JOB_COUNT; i += 1) {
      const job = await fetch(`${BASE}/api/deliverables/${deliverable}/pdf-jobs`, {
        method: 'POST',
      });
      assert(job.status === 202, `创建 PDF 任务失败：${job.status}`);
    }

    let done = 0;
    for (let i = 0; i < 240; i += 1) {
      const row = await one<{ count: number }>(
        `SELECT count(*)::int AS count FROM pdf_jobs
          WHERE deliverable_id = $1 AND status = 'done'`,
        [deliverable],
      );
      done = row?.count ?? 0;
      if (done === JOB_COUNT) break;
      await sleep(500);
    }
    assert(done === JOB_COUNT, `PDF 任务未完成：done=${done}/${JOB_COUNT}`);

    const job = await one<{ id: string; cache_key: string }>(
      `SELECT id, cache_key FROM pdf_jobs
        WHERE deliverable_id = $1 AND status = 'done'
        ORDER BY created_at LIMIT 1`,
      [deliverable],
    );
    assert(job !== null && Boolean(job.cache_key), '完成的 PDF 任务缺少 cache_key');

    const cached = await storage.get(`pdf-cache/${job.cache_key}.pdf`);
    assert(cached !== null, 'S3 中未找到 PDF 缓存对象');
    assert(cached.subarray(0, 4).toString() === '%PDF', 'S3 缓存对象不是 PDF');
    console.log(`    S3 已写入 PDF 缓存：${cached.length} bytes`);

    const download = await fetch(`${BASE}/api/pdf-jobs/${job.id}/file`);
    assert(download.ok, `下载 PDF 失败：${download.status}`);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert(downloaded.subarray(0, 4).toString() === '%PDF', 'API 下载内容不是 PDF');
    console.log(`    API 从 S3 读取 PDF：${downloaded.length} bytes`);

    const cacheList = await s3Client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/pdf-cache/` }),
    );
    assert((cacheList.KeyCount ?? 0) > 0, 'S3 中未列出 PDF 缓存对象');

    await query(`DELETE FROM deliverables WHERE id = $1`, [deliverable]);

    console.log('\n============================');
    console.log('S3 / MinIO 对象存储联调通过');
    console.log('============================');
    console.log('  PUT / GET / DELETE / 404 / Content-Type / prefix');
    console.log('  跨进程共享对象存储');
    console.log(`  API + 2 worker：${JOB_COUNT}/${JOB_COUNT} PDF 任务完成，缓存可读`);
  } finally {
    await stopAll();
    await s3?.close().catch(() => undefined);
    await closePool();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
