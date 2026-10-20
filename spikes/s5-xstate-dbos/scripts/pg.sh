#!/usr/bin/env bash
# Throwaway Postgres 16 cluster for the spike: ./scripts/pg.sh init|start|stop|psql
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=/usr/lib/postgresql/16/bin
DATA="$PWD/data/pg"
PORT=54325
# initdb/postgres refuse to run as root, so run them as the postgres OS user when we are root.
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
case "${1:-}" in
  init)
    mkdir -p "$DATA"; [ "$(id -u)" = 0 ] && chown -R postgres:postgres "$PWD/data"
    as_pg "$BIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
    echo "initialised $DATA" ;;
  start)
    as_pg "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DATA" -m fast -w stop ;;
  psql)
    shift; "$BIN/psql" -h 127.0.0.1 -p $PORT -U postgres "$@" ;;
  *) echo "usage: $0 init|start|stop|psql [args]"; exit 1 ;;
esac
