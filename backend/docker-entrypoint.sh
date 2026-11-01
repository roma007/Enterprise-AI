#!/bin/sh
set -e

echo "[entrypoint] waiting for database..."
until psql "$DATABASE_URL" -c "select 1" >/dev/null 2>&1; do
  sleep 2
done

echo "[entrypoint] running migrations..."
npm run db:migrate

if [ "${SEED_DEMO:-false}" = "true" ]; then
  COUNT=$(psql "$DATABASE_URL" -tAc "select count(*) from clients" | tr -d ' ')
  if [ "$COUNT" = "0" ]; then
    echo "[entrypoint] seeding demo data..."
    npm run db:seed
  else
    echo "[entrypoint] database not empty, skip demo seed"
  fi
fi

exec npm run start
