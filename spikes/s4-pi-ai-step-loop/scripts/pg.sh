#!/usr/bin/env bash
# Throwaway Postgres 16 cluster for the spike, under ./data/pg on port 54324.
# Usage: scripts/pg.sh start|stop|status
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN=/usr/lib/postgresql/16/bin
PGDATA="$PWD/data/pg"
PORT=54324
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }

case "${1:-}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$PGDATA"; [ "$(id -u)" = 0 ] && chown postgres "$PGDATA" "$(dirname "$PGDATA")"
      as_pg "$PGBIN/initdb -D '$PGDATA' -U postgres --auth=trust >/dev/null"
    fi
    as_pg "$PGBIN/pg_ctl -D '$PGDATA' -o '-p $PORT -k /tmp -c listen_addresses=127.0.0.1' -l '$PGDATA/server.log' -w start"
    ;;
  stop)   as_pg "$PGBIN/pg_ctl -D '$PGDATA' -m fast -w stop" ;;
  status) as_pg "$PGBIN/pg_ctl -D '$PGDATA' status" ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
