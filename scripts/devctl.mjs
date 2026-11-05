#!/usr/bin/env node
/**
 * 本地开发进程管理：用 tsx watch / Vite 热更新，避免反复重启产生孤儿进程。
 *
 *   node scripts/devctl.mjs status
 *   node scripts/devctl.mjs start
 *   node scripts/devctl.mjs stop
 *   node scripts/devctl.mjs restart
 *   node scripts/devctl.mjs logs backend
 */
import { execSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUN_DIR = join(ROOT, '.run');

const SERVICES = {
  backend: {
    cwd: join(ROOT, 'backend'),
    args: ['run', 'dev'],
    port: 8788,
    health: 'http://127.0.0.1:8788/api/health',
  },
  frontend: {
    cwd: join(ROOT, 'frontend'),
    args: ['run', 'dev', '--', '--host', '127.0.0.1'],
    port: 5173,
    health: 'http://127.0.0.1:5173/',
  },
};

mkdirSync(RUN_DIR, { recursive: true });
const pidFile = (name) => join(RUN_DIR, `${name}.pid`);
const logFile = (name) => join(RUN_DIR, `${name}.log`);

function readPid(name) {
  try {
    const pid = Number(readFileSync(pidFile(name), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitFor(name, timeoutMs = 60000) {
  const { port, health } = SERVICES[name];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      try {
        const res = await fetch(health, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return true;
      } catch {
        /* 服务还在启动 */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function start(name) {
  const svc = SERVICES[name];
  const pid = readPid(name);
  if (alive(pid)) {
    console.log(`${name}: 已由 devctl 运行 (pid ${pid})`);
    return;
  }
  if (await portOpen(svc.port)) {
    console.error(
      `${name}: 端口 ${svc.port} 已被其他进程占用；为避免重复进程，拒绝启动。` +
        `\n  先执行: node scripts/devctl.mjs stop 或手动停止占用进程。`,
    );
    process.exitCode = 1;
    return;
  }
  const out = createWriteStream(logFile(name), { flags: 'a' });
  out.write(`\n=== ${new Date().toISOString()} start ${name} ===\n`);
  const child = spawn('npm', svc.args, {
    cwd: svc.cwd,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  writeFileSync(pidFile(name), `${child.pid}\n`);
  console.log(`${name}: 启动中 (pid ${child.pid})，日志 ${logFile(name)}`);
  if (!(await waitFor(name))) {
    console.error(`${name}: 60 秒内未就绪，查看日志：${logFile(name)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${name}: 就绪 http://127.0.0.1:${svc.port}`);
}

async function stop(name, force = false) {
  const svc = SERVICES[name];
  const pid = readPid(name);
  if (!alive(pid)) {
    rmSync(pidFile(name), { force: true });
    if (!force || !(await portOpen(svc.port))) {
      console.log(`${name}: 未由 devctl 运行`);
      return;
    }
    // --force：接管端口占用者（只用于本地 8788/5173 开发端口）
    let pids = [];
    try {
      pids = execSync(`lsof -ti tcp:${svc.port}`, { encoding: 'utf8' })
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      /* 端口刚好释放 */
    }
    for (const target of pids) {
      try {
        process.kill(target, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    for (const target of pids) {
      try {
        process.kill(target, 0);
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    console.log(`${name}: 已强制停止端口 ${svc.port} 的占用进程`);
    return;
  }
  try {
    // detached 启动时 pid 即进程组组长，连同 npm/tsx 子进程一起终止
    process.kill(-pid, 'SIGTERM');
  } catch {
    process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  }
  rmSync(pidFile(name), { force: true });
  console.log(`${name}: 已停止`);
}

async function status() {
  for (const name of Object.keys(SERVICES)) {
    const svc = SERVICES[name];
    const pid = readPid(name);
    const managed = alive(pid);
    const open = await portOpen(svc.port);
    console.log(
      `${name.padEnd(8)} managed=${managed ? `yes(${pid})` : 'no '} ` +
        `port=${open ? 'LISTEN' : 'free  '} pid=${pid ?? '-'}`,
    );
  }
}

async function main() {
  const [command = 'status', target] = process.argv.slice(2);
  if (command === 'status') return status();
  if (command === 'start') {
    for (const name of target ? [target] : Object.keys(SERVICES)) await start(name);
    return;
  }
  const force = process.argv.includes('--force');
  if (command === 'stop') {
    for (const name of target ? [target] : Object.keys(SERVICES)) {
      await stop(name, force);
    }
    return;
  }
  if (command === 'restart') {
    for (const name of target ? [target] : Object.keys(SERVICES)) {
      await stop(name, force);
      await start(name);
    }
    return;
  }
  if (command === 'logs') {
    const name = target && !target.startsWith('-') ? target : 'backend';
    if (!existsSync(logFile(name))) {
      console.error(`没有日志：${logFile(name)}`);
      process.exitCode = 1;
      return;
    }
    const tail = spawn('tail', ['-f', logFile(name)], { stdio: 'inherit' });
    await new Promise((resolve) => tail.on('exit', resolve));
    return;
  }
  console.error('用法: node scripts/devctl.mjs <start|stop|restart|status|logs> [backend|frontend] [--force]');
  process.exitCode = 1;
}

main();
