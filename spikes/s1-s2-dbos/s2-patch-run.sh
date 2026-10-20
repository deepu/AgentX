#!/usr/bin/env bash
# S2b · DBOS patching (enablePatching + DBOS.patch) instead of application versions.
# Usage: ./s2-patch-run.sh [bun|node]
#   1. old code (s2-def-a.mjs, PATCHING=1) starts case-p1; killed mid-sleep
#   2. new code (s2-def-b-patched.mjs) recovers case-p1 and starts case-p2
#   3. rollback hazard: new code starts case-p3, killed mid-sleep; old code recovers it
set -euo pipefail
cd "$(dirname "$0")"
RT=${1:-bun}
case "$RT" in bun) RUN=(bun) ;; node) RUN=(/opt/node22/bin/node) ;; *) echo "bun|node"; exit 1 ;; esac
PSQL="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54321 -U postgres -X -q"
DB=s2p_$RT
export DBOS_SYSTEM_DATABASE_URL="postgresql://postgres@127.0.0.1:54321/$DB"
export LEDGER="out/s2p-$RT.ledger" SLEEP_MS=6000 PATCHING=1
mkdir -p out; rm -f "$LEDGER" out/s2p-$RT.*.out
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB" 2>/dev/null
PIDS=(); trap 'kill -9 "${PIDS[@]}" 2>/dev/null || true' EXIT

count() { cat "$LEDGER" 2>/dev/null | grep -c -- "$1" || true; }
wait_n() { for _ in $(seq 1 200); do [ "$(count "$1")" -ge "$2" ] && return 0; sleep 0.2; done; echo "timeout: $1 x$2"; exit 1; }
status() { $PSQL -d "$DB" -c "SELECT s.workflow_uuid AS wf, s.status, s.application_version AS version, substring(o.error from '\"message\":\"([^\"]{0,75})') AS error FROM dbos.workflow_status s LEFT JOIN dbos.workflow_output o USING (workflow_uuid) ORDER BY 1"; }
steps() { $PSQL -d "$DB" -c "SELECT function_id AS id, function_name FROM dbos.operation_outputs WHERE workflow_uuid='$1' ORDER BY 1"; }
note() { echo; echo "=== $* ==="; }
bg() { local tag=$1; shift; env "$@" >"out/s2p-$RT.$tag.out" 2>&1 & PIDS+=($!); LAST=$!; }

note "1: old code starts case-p1, killed mid-sleep"
bg old1 "${RUN[@]}" s2-def-a.mjs worker case-p1; P=$LAST
wait_n "case-p1 SLEEP begin" 1; sleep 1; kill -9 $P
steps case-p1

note "2: patched new code recovers case-p1 and starts case-p2"
bg new1 "${RUN[@]}" s2-def-b-patched.mjs worker case-p2; PN=$LAST
wait_n "case-p1 RETURN" 1; wait_n "case-p2 RETURN" 1
grep -E "Recovering|Application version" out/s2p-$RT.new1.out || true
echo "-- case-p1 (started on old code):"; steps case-p1
echo "-- case-p2 (started on new code):"; steps case-p2

note "3: rollback hazard: case-p3 starts on new code, old code recovers it"
kill -9 $PN  # stop the new-code worker so only old code is running afterwards
bg new2 "${RUN[@]}" s2-def-b-patched.mjs worker case-p3; P=$LAST
wait_n "case-p3 SLEEP begin" 1; sleep 1; kill -9 $P
bg old2 "${RUN[@]}" s2-def-a.mjs worker; P=$LAST
for _ in $(seq 1 50); do $PSQL -d "$DB" -tAc "SELECT status FROM dbos.workflow_status WHERE workflow_uuid='case-p3'" | grep -qvE 'PENDING|ENQUEUED' && break; sleep 0.2; done
kill -9 $P
status

note "ledger"; cat "$LEDGER"
