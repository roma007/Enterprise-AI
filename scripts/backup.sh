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

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/ai_delivery-$TIMESTAMP.dump"

if command -v docker >/dev/null 2>&1 \
  && docker compose ps --status running db 2>/dev/null | grep -q db; then
  echo "使用 Docker Compose 备份（db 容器）..."
  docker compose exec -T db pg_dump \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-ai_delivery}" \
    --no-owner --no-acl -Fc > "$FILE"
else
  echo "使用本地 DATABASE_URL 备份..."
  DATABASE_URL="${DATABASE_URL:-postgres://127.0.0.1:5432/ai_delivery}"
  pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc > "$FILE"
fi

echo "备份完成：$FILE"
du -h "$FILE" | awk '{print "大小：" $1}'
