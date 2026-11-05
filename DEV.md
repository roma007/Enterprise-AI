# 本地开发进程管理

> 目标：不再出现“15 个 shell / 一堆 tsx 僵尸进程”。
> 核心：**开发用 watch，不用反复重启；停止时杀进程组，不只杀端口监听者。**

## 1. 日常开发

后端：

```bash
cd backend
npm run dev        # tsx watch src/server.ts
```

前端：

```bash
cd frontend
npm run dev        # Vite HMR
```

改代码后由 `tsx watch` / Vite 自动热更新，**不要每次改完都 `npm run start` 重启**。  
只有改 `.env`、迁移、依赖或进程级配置时才需要重启。

## 2. 用 devctl 管理

```bash
node scripts/devctl.mjs status
node scripts/devctl.mjs start
node scripts/devctl.mjs stop
node scripts/devctl.mjs restart
node scripts/devctl.mjs logs backend
node scripts/devctl.mjs logs frontend
```

特点：

- `start` 用 `detached` 启动独立进程组，PID 写入 `.run/*.pid`
- `stop` 用 `kill(-pid)` 杀掉整个进程组（npm → tsx → server）
- 端口已占用时拒绝再启动，避免重复进程
- 日志写到 `.run/backend.log` / `.run/frontend.log`
- `--force` 可接管当前 `8788/5173` 的外部占用进程：

```bash
node scripts/devctl.mjs stop --force
node scripts/devctl.mjs start
```

## 3. 旧方式的问题

不要这样做：

```bash
nohup npm run start > /tmp/backend.log 2>&1 & disown
lsof -ti tcp:8788 | xargs kill
```

问题：

- `nohup ... & disown` 脱离终端后，父进程退出，`tsx` 子进程可能被孤立
- `lsof -ti tcp:8788` 只杀当前监听者，旧进程没有监听端口但仍在内存里
- 下次启动继续堆，最终出现十几个 `tsx src/server.ts`
- OpenCode 的 shell 列表还会保留历史输出，看起来像“都在跑”

## 4. 查看真正的运行态

```bash
node scripts/devctl.mjs status

lsof -nP -iTCP:8788 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN

ps -axo pid,ppid,etime,command | grep "Enterprise AI/backend.*tsx src/server.ts" | grep -v grep
```

## 5. 清理遗留进程

确认端口监听者后，只保留当前监听进程：

```bash
CURRENT=$(lsof -ti tcp:8788)
ps -axo pid,command \
  | awk '/Enterprise AI\/backend\/.*tsx src\/server.ts/ && !/awk/ {print $1}' \
  | grep -v "^${CURRENT}$" \
  | xargs -n1 kill -TERM
```

定期执行一次即可；不要用 `pkill -f node`，会误杀其他项目。

## 6. Autopilot 定时器

`autopilot` 每 10 分钟启动一次 OpenCode 会话。它有自己的锁与超时，但：

- 队列全部 `blocked` 时会产生 no-op 运行，仍消耗额度
- 长期不用时创建 `autopilot/PAUSE` 暂停
- 恢复前先看 `autopilot/logs/` 最近一次结果
