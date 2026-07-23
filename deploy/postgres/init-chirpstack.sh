#!/usr/bin/env bash
# deploy/postgres/init-chirpstack.sh
#
# Runs automatically on the FIRST initialisation of the PostgreSQL data
# directory (mounted at /docker-entrypoint-initdb.d/ in the postgres image).
# Creates the chirpstack user, database, and required extensions.
#
# CHIRPSTACK_DB_PASSWORD is passed as an environment variable from the
# postgres service in docker-compose.prod.yml — it is never hard-coded here.

set -eo pipefail

echo "==> Creating chirpstack database and user..."

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname   "$POSTGRES_DB" \
     <<-SQL
  CREATE USER chirpstack WITH PASSWORD '${CHIRPSTACK_DB_PASSWORD}';
  CREATE DATABASE chirpstack OWNER chirpstack;
SQL

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname   "chirpstack" \
     <<-SQL
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS hstore;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  GRANT ALL PRIVILEGES ON DATABASE chirpstack TO chirpstack;
SQL

echo "==> ChirpStack database initialised."
