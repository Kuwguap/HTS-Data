#!/usr/bin/env bash
# Throwaway local Postgres 16 for SQL + RLS tests (no Docker needed).
#
#   bash scripts/local-pg.sh up      # init (first time), start, create db, apply shims + migrations
#   bash scripts/local-pg.sh reset   # drop + recreate the database and re-apply everything
#   bash scripts/local-pg.sh down    # stop the server
#   bash scripts/local-pg.sh psql    # open psql on the test database
#
# Prints TEST_DATABASE_URL on `up`/`reset`. Postgres refuses to run as root, so when
# invoked as root the server runs as the `ubuntu` user (override with KHARIS_PG_USER).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PGBIN="${KHARIS_PGBIN:-/usr/lib/postgresql/16/bin}"
PORT="${KHARIS_PGPORT:-54329}"
DB="${KHARIS_PGDB:-kharis_test}"
SOCKDIR="${KHARIS_PGSOCK:-/tmp}"

if [ "$(id -u)" = "0" ]; then
  PGUSER_OS="${KHARIS_PG_USER:-ubuntu}"
  RUN=(sudo -n -u "$PGUSER_OS" -H)
  PGDATA="${KHARIS_PGDATA:-/home/$PGUSER_OS/kharis-pg}"
else
  RUN=()
  PGDATA="${KHARIS_PGDATA:-$HOME/kharis-pg}"
fi

URL="postgres://postgres@127.0.0.1:${PORT}/${DB}"
PSQL=("$PGBIN/psql" -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p "$PORT" -U postgres)

is_running() {
  "$PGBIN/pg_isready" -q -h 127.0.0.1 -p "$PORT" -U postgres 2>/dev/null
}

start_server() {
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    "${RUN[@]}" mkdir -p "$PGDATA"
    "${RUN[@]}" "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if ! is_running; then
    "${RUN[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -w -t 60 \
      -o "-p $PORT -k $SOCKDIR -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=50" \
      -l "$PGDATA/server.log" start >/dev/null
  fi
}

apply_sql() {
  # Shims first (roles, auth schema, realtime stub), then migrations in order.
  "${PSQL[@]}" -d "$DB" -f "$HERE/pg-shims.sql"
  if ls "$ROOT"/supabase/migrations/*.sql >/dev/null 2>&1; then
    for f in "$ROOT"/supabase/migrations/*.sql; do
      echo "applying $(basename "$f")"
      "${PSQL[@]}" -d "$DB" -f "$f"
    done
  fi
}

create_db() {
  if ! "${PSQL[@]}" -d postgres -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1; then
    "${PSQL[@]}" -d postgres -c "create database \"$DB\""
  fi
}

case "${1:-}" in
  up)
    start_server
    create_db
    apply_sql
    echo "TEST_DATABASE_URL=$URL"
    ;;
  reset)
    start_server
    "${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\" with (force)"
    create_db
    apply_sql
    echo "TEST_DATABASE_URL=$URL"
    ;;
  down)
    if is_running; then
      "${RUN[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null
    fi
    echo "stopped"
    ;;
  psql)
    exec "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB"
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: $0 {up|reset|down|psql|url}" >&2
    exit 2
    ;;
esac
