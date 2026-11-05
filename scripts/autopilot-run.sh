#!/bin/zsh
# 10 分钟定时器入口：加锁、检查暂停/队列/工作区，然后交给 OpenCode 执行一项任务。
set -u

ROOT="/Users/mengfeng/我的文档/源码/Enterprise AI"
export PATH="/Users/mengfeng/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$ROOT/autopilot/logs"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG="$ROOT/autopilot/logs/$STAMP-timer.log"
say() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

if [[ -f "$ROOT/autopilot/PAUSE" ]]; then
  say "paused: $(cat "$ROOT/autopilot/PAUSE" 2>/dev/null | head -1)"
  exit 0
fi

# 原子锁，避免上一轮没跑完又叠一轮
LOCK="$ROOT/autopilot/.run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  say "skip: another autopilot run is still active"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

QUEUE="$ROOT/AUTOPILOT_QUEUE.md"
if [[ ! -f "$QUEUE" ]]; then
  say "skip: AUTOPILOT_QUEUE.md not found"
  exit 0
fi
if ! grep -qiE 'pending|待办|待处理' "$QUEUE"; then
  say "skip: no pending item in queue"
  exit 0
fi

# 每日运行上限，防止无限消耗额度
MAX_RUNS="${AUTOPILOT_MAX_RUNS_PER_DAY:-12}"
TODAY_COUNT=$(find "$ROOT/autopilot/logs" -name "$(date '+%Y%m%d')-*-run.log" 2>/dev/null | wc -l | tr -d ' ')
if (( TODAY_COUNT >= MAX_RUNS )); then
  say "skip: daily run cap reached ($TODAY_COUNT/$MAX_RUNS)"
  exit 0
fi

WORKTREE_FILE="$ROOT/autopilot/worktree"
if [[ -f "$WORKTREE_FILE" ]]; then
  WORKDIR="$(cat "$WORKTREE_FILE")"
else
  WORKDIR="$ROOT"
fi
if [[ ! -d "$WORKDIR" ]]; then
  say "skip: worktree missing: $WORKDIR"
  exit 0
fi
cd "$WORKDIR" || exit 0

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  say "skip: working tree is dirty ($WORKDIR)"
  exit 0
fi

if ! curl -fsS --max-time 5 http://127.0.0.1:8788/api/health >/dev/null 2>&1; then
  say "skip: backend health check failed"
  exit 0
fi

SESSION_FILE="$ROOT/autopilot/session-id"
if [[ ! -f "$SESSION_FILE" ]]; then
  say "skip: autopilot/session-id missing"
  exit 0
fi
SESSION="$(tr -d '[:space:]' < "$SESSION_FILE")"

PROMPT="$(cat <<'PROMPT_EOF'
你是 AUTOPILOT 执行器。先阅读 AUTOPILOT.md 和 AUTOPILOT_QUEUE.md。

规则：
1. 只处理队列中状态为 pending 且不依赖外部环境的第一项；不要并行处理多项。
2. 执行前确认 git status 干净；不干净则停止，输出 blocked DIRTY_WORKTREE。
3. 只改该任务声明的文件范围；不要修改无关代码或文档。
4. 按任务列出的验证命令串行执行；禁止并行跑 verify:write 与 e2e；不要重启后端/前端服务。
5. 通过后本地 git add + git commit（不要 push），把队列项状态改为 done，并写 autopilot/logs/<时间>-<任务ID>-run.md。
6. 失败或需要外部资源时，不伪造结果、不修改测试断言，标记 failed/blocked 并写明原因。
7. 最后只输出一行：AUTOPILOT_RESULT=<done|blocked|failed|noop> <任务ID> <原因>

不要执行任何生产发布、真实支付、真实客户数据或外部环境操作。
PROMPT_EOF
)"

say "run: session=$SESSION workdir=$WORKDIR"
RUN_LOG="$ROOT/autopilot/logs/$(date '+%Y%m%d-%H%M%S')-run.log"
python3 - "$SESSION" "$PROMPT" "$RUN_LOG" <<'PY' >>"$LOG" 2>&1
import subprocess, sys
session, prompt, log_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(log_path, 'a', encoding='utf-8') as out:
    out.write(f"=== autopilot run {session} ===\n")
    out.flush()
    try:
        p = subprocess.run(
            ["opencode", "run", "--auto", "--session", session, "--format", "default", prompt],
            stdout=out, stderr=subprocess.STDOUT, timeout=540,
        )
        code = p.returncode
    except subprocess.TimeoutExpired:
        out.write("\nAUTOPILOT_RESULT=failed TIMEOUT 超过 9 分钟\n")
        code = 124
print(f"exit={code} log={log_path}")
PY
say "done: exit=$? run_log=$RUN_LOG"
