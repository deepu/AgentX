#!/usr/bin/env bash
# Throwaway Postgres 16 cluster for the spikes, on port 54321, data under ./pgdata.
# Usage: ./pg.sh start | stop | reset
set -euo pipefail
cd "$(dirname "$0")"
PGB=/usr/lib/postgresql/16/bin
PORT=54321
DATA="$PWD/pgdata"
# initdb/postgres refuse to run as root; use the postgres OS user when we are root.
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
case "${1:-}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      mkdir -p "$DATA"; [ "$(id -u)" = 0 ] && chown postgres "$DATA"
      as_pg "$PGB/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    as_pg "$PGB/pg_ctl" -D "$DATA" -l "$DATA/server.log" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -w start
    ;;
  stop)  as_pg "$PGB/pg_ctl" -D "$DATA" -m fast -w stop ;;
  reset) "$0" stop || true; rm -rf "$DATA"; "$0" start ;;
  *) echo "usage: $0 start|stop|reset"; exit 1 ;;
esac
