# Autopilot 定时器

macOS `launchd` 每 10 分钟调用一次 `scripts/autopilot-run.sh`。

## 当前状态

已安装并加载，但处于**暂停**状态：

```text
autopilot/PAUSE
```

暂停期间定时器仍会触发，但脚本只写一行日志后退出，不消耗模型额度。

## 启用

首批并发 Worker 合并、队列就绪后：

```bash
cd "/Users/mengfeng/我的文档/源码/Enterprise AI"
rm -f autopilot/PAUSE
```

## 暂停

```bash
cd "/Users/mengfeng/我的文档/源码/Enterprise AI"
echo "手动暂停 $(date '+%F %T')" > autopilot/PAUSE
```

## 查看状态与日志

```bash
launchctl print "gui/$(id -u)/com.hengzhi.autopilot" | grep -E 'state|run interval|last exit'
tail -f autopilot/logs/launchd.out.log
ls -lt autopilot/logs | head
```

## 规则

- 每轮最多处理 `AUTOPILOT_QUEUE.md` 中一个 pending 项
- 单轮最长 9 分钟；超时记为失败
- 每日最多 12 轮（`AUTOPILOT_MAX_RUNS_PER_DAY`）
- 工作区不干净、后端不健康、队列无 pending 时直接跳过
- 不在 `autopilot/PAUSE` 存在时运行

## 工作目录

默认在主仓库执行。若要隔离到独立 worktree：

```bash
git worktree add "../Enterprise AI Autopilot" -b autopilot
printf '%s\n' "/Users/mengfeng/我的文档/源码/Enterprise AI Autopilot" > autopilot/worktree
```

worktree 的 `backend/node_modules` 与 `frontend/node_modules` 需要软链或单独安装。
