#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "用法：./scripts/restore.sh backups/ai_delivery-YYYYMMDD-HHMMSS.dump"
  exit 1
fi

echo "即将用备份覆盖当前数据库：$FILE"
read -r -p "确认输入 yes 继续：" CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "已取消"
  exit 1
fi

if command -v docker >/dev/null 2>&1 \
  && docker compose ps --status running db 2>/dev/null | grep -q db; then
  echo "停止 backend/frontend，避免恢复期间有活动连接..."
  docker compose stop backend frontend >/dev/null
  trap 'docker compose start backend frontend >/dev/null 2>&1 || true' EXIT

  docker compose exec -T db pg_restore \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-ai_delivery}" \
    --clean --if-exists --no-owner --no-acl < "$FILE"
  # --no-acl 不包含 GRANT，恢复后重建 RLS 应用角色权限
  docker compose exec -T db psql \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-ai_delivery}" \
    -v ON_ERROR_STOP=1 -q < scripts/sql/restore_grants.sql
  echo "恢复完成；服务将自动重新启动"
else
  DATABASE_URL="${DATABASE_URL:-postgres://127.0.0.1:5432/ai_delivery}"
  pg_restore --clean --if-exists --no-owner --no-acl -d "$DATABASE_URL" "$FILE"
  # --no-acl 不包含 GRANT，恢复后重建 RLS 应用角色权限
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f scripts/sql/restore_grants.sql
  echo "恢复完成"
fi
