#!/usr/bin/env bash
# 逻辑备份恢复演练：pg_dump 当前库 → 恢复到临时库 → 校验结构/数据/RLS → 清理。
# 用法：./scripts/restore-drill.sh
# 保留备份文件：KEEP_DRILL_DUMP=true ./scripts/restore-drill.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DATABASE_URL="${DATABASE_URL:-postgres://127.0.0.1:5432/ai_delivery}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/restore-drill-$STAMP.dump"
SCRATCH_DB="ai_delivery_restore_drill_$$"
KEEP_DUMP="${KEEP_DRILL_DUMP:-false}"
mkdir -p "$BACKUP_DIR"

USE_DOCKER=false
if command -v docker >/dev/null 2>&1 \
  && docker compose ps --status running db 2>/dev/null | grep -q db; then
  USE_DOCKER=true
fi

PGUSER="${POSTGRES_USER:-postgres}"
PGDB="${POSTGRES_DB:-ai_delivery}"

SCRATCH_URL="$(node -e '
const u = new URL(process.argv[1]);
u.pathname = "/" + process.argv[2];
process.stdout.write(u.toString());
' "$DATABASE_URL" "$SCRATCH_DB")"

psql_src() {
  if [ "$USE_DOCKER" = true ]; then
    docker compose exec -T db psql -U "$PGUSER" -d "$PGDB" -Atq -c "$1"
  else
    psql "$DATABASE_URL" -Atq -c "$1"
  fi
}

psql_dst() {
  if [ "$USE_DOCKER" = true ]; then
    docker compose exec -T db psql -U "$PGUSER" -d "$SCRATCH_DB" -Atq -c "$1"
  else
    psql "$SCRATCH_URL" -Atq -c "$1"
  fi
}

drop_scratch() {
  if [ "$USE_DOCKER" = true ]; then
    docker compose exec -T db psql -U "$PGUSER" -d "$PGDB" -q -c \
      "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  else
    psql "$DATABASE_URL" -q -c \
      "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  set +e
  drop_scratch
  if [ "$KEEP_DUMP" != "true" ]; then
    rm -f "$DUMP"
  fi
}
trap cleanup EXIT

fail() {
  echo "恢复演练失败：$1" >&2
  exit 1
}

echo "1/6 备份当前数据库..."
if [ "$USE_DOCKER" = true ]; then
  docker compose exec -T db pg_dump -U "$PGUSER" -d "$PGDB" \
    --no-owner --no-acl -Fc > "$DUMP"
else
  pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc > "$DUMP"
fi
[ -s "$DUMP" ] || fail "备份文件为空"
echo "    备份：${DUMP}（$(du -h "$DUMP" | awk '{print $1}')）"

echo "2/6 创建临时库 $SCRATCH_DB..."
if [ "$USE_DOCKER" = true ]; then
  docker compose exec -T db psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$SCRATCH_DB\";" >/dev/null
else
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH_DB\";" >/dev/null
fi

echo "3/6 恢复到临时库..."
if [ "$USE_DOCKER" = true ]; then
  docker compose exec -T db pg_restore -U "$PGUSER" -d "$SCRATCH_DB" \
    --no-owner --no-acl < "$DUMP"
  docker compose exec -T db psql -U "$PGUSER" -d "$SCRATCH_DB" \
    -v ON_ERROR_STOP=1 -q < scripts/sql/restore_grants.sql
else
  pg_restore --no-owner --no-acl -d "$SCRATCH_URL" "$DUMP"
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -f scripts/sql/restore_grants.sql
fi

echo "4/6 校验结构与数据..."
tables="$(psql_dst "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")"
[ "${tables:-0}" -ge 60 ] || fail "表数量异常：${tables:-0}"

migrations="$(psql_dst "SELECT count(*) FROM schema_migrations;")"
[ "${migrations:-0}" -ge 30 ] || fail "迁移记录异常：${migrations:-0}"

tenant="$(psql_dst "SELECT count(*) FROM organizations WHERE slug='hengzhi';")"
[ "$tenant" = "1" ] || fail "seed 租户 hengzhi 未恢复"

TABLES="organizations users clients engagements deliverables knowledge_items"
for table in $TABLES; do
  src="$(psql_src "SELECT count(*) FROM $table;")"
  dst="$(psql_dst "SELECT count(*) FROM $table;")"
  if [ "$src" != "$dst" ]; then
    fail "表 $table 行数不一致：源 $src / 恢复 $dst"
  fi
done

echo "5/6 校验 RLS..."
rls_tables="$(psql_dst "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity;")"
[ "${rls_tables:-0}" -ge 30 ] || fail "启用 RLS 的表过少：${rls_tables:-0}"
policies="$(psql_dst "SELECT count(*) FROM pg_policies WHERE schemaname='public';")"
[ "${policies:-0}" -ge 30 ] || fail "RLS 策略过少：${policies:-0}"

ORG="$(psql_dst "SELECT id FROM organizations WHERE slug='hengzhi';")"
org_rows="$(psql_dst "BEGIN; SET LOCAL ROLE ai_delivery_app;
  SELECT set_config('app.org_id', '$ORG', true);
  SELECT count(*) FROM clients; ROLLBACK;" | tail -n 1)"
[ "${org_rows:-0}" -gt 0 ] || fail "RLS 下 hengzhi 查不到客户"

none_rows="$(psql_dst "BEGIN; SET LOCAL ROLE ai_delivery_app;
  SELECT set_config('app.org_id', '00000000-0000-0000-0000-000000000000', true);
  SELECT count(*) FROM clients; ROLLBACK;" | tail -n 1)"
[ "${none_rows:-1}" = "0" ] || fail "RLS 隔离失效：随机组织仍能查到客户"

echo "6/6 清理临时库..."
drop_scratch
trap - EXIT
if [ "$KEEP_DUMP" != "true" ]; then
  rm -f "$DUMP"
fi

DRILL_EPOCH="$(date +%s)"
printf '%s\n' "$DRILL_EPOCH" > "$BACKUP_DIR/.last-restore-drill-success"
if [ -n "${PROM_TEXTFILE_DIR:-}" ] && [ -d "$PROM_TEXTFILE_DIR" ]; then
  TMP="$PROM_TEXTFILE_DIR/.ai_delivery_restore_drill.prom.$$"
  cat > "$TMP" <<EOF
# HELP ai_delivery_restore_drill_last_success_timestamp_seconds Unix time of the last successful restore drill.
# TYPE ai_delivery_restore_drill_last_success_timestamp_seconds gauge
ai_delivery_restore_drill_last_success_timestamp_seconds $DRILL_EPOCH
EOF
  mv "$TMP" "$PROM_TEXTFILE_DIR/ai_delivery_restore_drill.prom"
fi

echo
echo "逻辑备份恢复演练通过"
echo "  表：$tables / 迁移：$migrations / RLS 表：$rls_tables / 策略：$policies"
echo "  关键表行数一致：$TABLES"
echo "  RLS：hengzhi=${org_rows}，随机组织=${none_rows}"
echo "  模式：$([ "$USE_DOCKER" = true ] && echo 'docker compose' || echo 'local DATABASE_URL')"
