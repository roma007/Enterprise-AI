#!/bin/zsh
# 1 分钟看门狗：当前一轮结束后，尽快启动队列中的下一项。
set -u

ROOT="/Users/mengfeng/我的文档/源码/Enterprise AI"
export PATH="/Users/mengfeng/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
QUEUE="$ROOT/AUTOPILOT_QUEUE.md"
LOCK="$ROOT/autopilot/.run.lock"
LOG="$ROOT/autopilot/logs/watchdog.log"

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

[[ -f "$ROOT/autopilot/PAUSE" || -f "$ROOT/autopilot/STOP" ]] && exit 0
[[ -f "$QUEUE" ]] || exit 0
# 只认表格里的 pending 状态，避免匹配说明文字
grep -qE '\| pending \|' "$QUEUE" || exit 0

# 每日上限与 autopilot-run.sh 保持一致
MAX_RUNS="${AUTOPILOT_MAX_RUNS_PER_DAY:-12}"
TODAY_COUNT=$(find "$ROOT/autopilot/logs" -name "$(date '+%Y%m%d')-*-run.log" 2>/dev/null | wc -l | tr -d ' ')
(( TODAY_COUNT >= MAX_RUNS )) && exit 0

if [[ -d "$LOCK" ]]; then
  if [[ -f "$LOCK/pid" ]]; then
    owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
      exit 0
    fi
  fi
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if (( age < 1200 )); then
    exit 0
  fi
  log "remove stale lock age=${age}s"
  rm -rf "$LOCK"
fi

log "idle + pending -> start next round"
exec "$ROOT/scripts/autopilot-run.sh"
