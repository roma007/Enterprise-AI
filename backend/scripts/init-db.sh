#!/bin/sh
set -e

echo "[init-db] running migrations..."
npm run db:migrate

if [ "${SEED_DEMO:-false}" = "true" ]; then
  COUNT=$(psql "$DATABASE_URL" -tAc "select count(*) from clients" | tr -d ' ')
  if [ "$COUNT" = "0" ]; then
    echo "[init-db] seeding demo data..."
    npm run db:seed
  else
    echo "[init-db] database not empty, skip demo seed"
  fi
fi
