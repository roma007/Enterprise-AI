#!/usr/bin/env bash
# 时间点恢复（PITR）演练：在临时集群上启用 WAL 归档，
# 取基础备份 → 写入标记 → 恢复到目标时间 → 校验标记与数据 → 清理。
#
# 依赖本机 PostgreSQL 16 工具（initdb / pg_ctl / pg_basebackup / psql）。
# 用法：./scripts/pitr-drill.sh
# 端口可调：PITR_PORT=55432 PITR_RESTORE_PORT=55433 ./scripts/pitr-drill.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

for bin in initdb pg_ctl pg_basebackup psql createdb; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "缺少 ${bin}，跳过 PITR 演练（需要本地 PostgreSQL 服务端工具）"
    exit 0
  fi
done

PORT="${PITR_PORT:-55432}"
RESTORE_PORT="${PITR_RESTORE_PORT:-55433}"

if lsof -ti "tcp:$PORT" >/dev/null 2>&1 || lsof -ti "tcp:$RESTORE_PORT" >/dev/null 2>&1; then
  echo "端口 $PORT / $RESTORE_PORT 已被占用，请设置 PITR_PORT / PITR_RESTORE_PORT" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ai-pitr.XXXXXX")"
DATA="$WORK/data"
BASE="$WORK/base"
RESTORE="$WORK/restore"
RESTORE_AFTER="$WORK/restore-after"
ARCHIVE="$WORK/archive"
LOGS="$WORK/logs"
mkdir -p "$ARCHIVE" "$LOGS"

cleanup() {
  set +e
  pg_ctl -D "$RESTORE" stop -m immediate >/dev/null 2>&1
  pg_ctl -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

psql_primary() {
  psql -h 127.0.0.1 -p "$PORT" -U postgres -d ai_delivery -Atq -c "$1"
}

psql_restored() {
  psql -h 127.0.0.1 -p "$RESTORE_PORT" -U postgres -d ai_delivery -Atq -c "$1"
}

fail() {
  echo "PITR 演练失败：$1" >&2
  exit 1
}

start_restore() {
  local data="$1"
  local log="$2"
  local target="$3"

  cat >> "$data/postgresql.conf" <<EOF
port = $RESTORE_PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$WORK'
archive_mode = off
archive_command = ''
restore_command = 'cp $ARCHIVE/%f %p'
recovery_target_time = '$target'
recovery_target_action = 'promote'
EOF
  touch "$data/recovery.signal"

  if ! pg_ctl -D "$data" -l "$log" -w -t 120 start >/dev/null; then
    tail -n 40 "$log" >&2 || true
    fail "恢复实例启动失败：$log"
  fi

  # pg_ctl -w 在恢复期间也可能返回（hot standby）；等到 promote 完成。
  local state="t"
  for _ in $(seq 1 240); do
    state="$(psql_restored "SELECT pg_is_in_recovery();" 2>/dev/null || echo t)"
    [ "$state" = "f" ] && return 0
    sleep 0.5
  done
  tail -n 40 "$log" >&2 || true
  fail "恢复实例未 promote：$state"
}

echo "1/7 初始化临时 PostgreSQL 集群（端口 ${PORT}）..."
initdb -D "$DATA" -U postgres --auth=trust --no-locale -E UTF8 >/dev/null

cat >> "$DATA/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$WORK'
wal_level = replica
archive_mode = on
archive_command = 'cp %p $ARCHIVE/%f'
EOF

pg_ctl -D "$DATA" -l "$LOGS/primary.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$PORT" -U postgres ai_delivery

echo "2/7 执行迁移与 seed..."
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/ai_delivery" npm --prefix backend run db:migrate >/dev/null
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/ai_delivery" \
  PGOPTIONS="-c client_min_messages=warning" npm --prefix backend run db:seed >/dev/null
psql_primary "CREATE TABLE pitr_probe (
  id serial PRIMARY KEY,
  note text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pitr_probe(note) VALUES ('before');" >/dev/null

echo "3/7 取基础备份..."
pg_basebackup -h 127.0.0.1 -p "$PORT" -U postgres -D "$BASE" -X stream -c fast >/dev/null

TARGET="$(psql_primary "SELECT now()::text;")"
sleep 1
psql_primary "INSERT INTO pitr_probe(note) VALUES ('after');" >/dev/null
sleep 0.3
TARGET_AFTER="$(psql_primary "SELECT now()::text;")"
psql_primary "INSERT INTO pitr_probe(note) VALUES ('after2');" >/dev/null
AFTER_LSN="$(psql_primary "SELECT pg_current_wal_lsn();")"
WAL_SEG="$(psql_primary "SELECT pg_walfile_name('$AFTER_LSN');")"
psql_primary "SELECT pg_switch_wal();" >/dev/null
echo "    目标时间：$TARGET"
echo "    目标 WAL 段：$WAL_SEG"

echo "4/7 等待目标 WAL 段归档..."
archived=""
for _ in $(seq 1 120); do
  if [ -f "$ARCHIVE/$WAL_SEG" ]; then
    archived="$ARCHIVE/$WAL_SEG"
    break
  fi
  sleep 0.5
done
[ -n "$archived" ] || fail "WAL 段 $WAL_SEG 未归档到 $ARCHIVE"
pg_ctl -D "$DATA" -m fast -w stop >/dev/null

echo "5/7 恢复到目标时间（应不包含 after）..."
cp -R "$BASE" "$RESTORE"
start_restore "$RESTORE" "$LOGS/recovery-before.log" "$TARGET"

echo "6/7 校验时间点..."

before="$(psql_restored "SELECT count(*) FROM pitr_probe WHERE note='before';")"
after="$(psql_restored "SELECT count(*) FROM pitr_probe WHERE note='after';")"
[ "$before" = "1" ] || fail "目标时间前的数据缺失：before=$before"
[ "$after" = "0" ] || fail "目标时间后的数据被恢复：after=$after"

migrations="$(psql_restored "SELECT count(*) FROM schema_migrations;")"
[ "${migrations:-0}" -ge 30 ] || fail "迁移记录异常：${migrations:-0}"

clients="$(psql_restored "SELECT count(*) FROM clients;")"
[ "${clients:-0}" -gt 0 ] || fail "恢复后客户数据为空"

tenant="$(psql_restored "SELECT count(*) FROM organizations WHERE slug='hengzhi';")"
[ "$tenant" = "1" ] || fail "恢复后缺少 seed 租户"

rls_tables="$(psql_restored "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity;")"
[ "${rls_tables:-0}" -ge 30 ] || fail "恢复后 RLS 表过少：${rls_tables:-0}"

# 对照组：恢复到 after 之后，after 必须出现，证明 PITR 不是假通过。
echo "    对照组：恢复到 after 之后（应包含 after）..."
pg_ctl -D "$RESTORE" -m immediate -w stop >/dev/null 2>&1 || true
cp -R "$BASE" "$RESTORE_AFTER"
start_restore "$RESTORE_AFTER" "$LOGS/recovery-after.log" "$TARGET_AFTER"
before_after="$(psql_restored "SELECT count(*) FROM pitr_probe WHERE note='before';")"
after_after="$(psql_restored "SELECT count(*) FROM pitr_probe WHERE note='after';")"
after2_after="$(psql_restored "SELECT count(*) FROM pitr_probe WHERE note='after2';")"
[ "$before_after" = "1" ] || fail "对照组 before 数据缺失：$before_after"
[ "$after_after" = "1" ] || fail "对照组 after 数据缺失，PITR 可能未真正应用：$after_after"
[ "$after2_after" = "0" ] || fail "对照组 after2 不应出现：$after2_after"

echo "7/7 清理临时集群..."
pg_ctl -D "$RESTORE_AFTER" -m immediate -w stop >/dev/null 2>&1 || true
pg_ctl -D "$RESTORE" -m immediate -w stop >/dev/null 2>&1 || true
pg_ctl -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
trap - EXIT
rm -rf "$WORK"

echo
echo "PITR 演练通过"
echo "  目标时间：$TARGET"
echo "  目标时间恢复：before=${before} / after=${after}（after 必须为 0）"
echo "  对照组恢复：before=${before_after} / after=${after_after} / after2=${after2_after}（after=1，after2=0）"
echo "  迁移：$migrations / 客户：$clients / RLS 表：$rls_tables"
echo "  归档 WAL 段：$(basename "$archived")"
