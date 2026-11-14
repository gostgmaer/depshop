#!/bin/sh
# Runs once, on first initialisation of an empty data volume.
#
# Installs extensions into template1 (so every database created later inherits
# them, including Prisma's shadow database used by `prisma migrate dev`) and
# into the application database itself.
#
# The Prisma migration `*_extensions` is the source of truth for production;
# this script only makes local development match it from the start.
set -eu

for db in template1 "$POSTGRES_DB"; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
done

echo "dealmind: installed pg_trgm and vector into template1 and $POSTGRES_DB"
