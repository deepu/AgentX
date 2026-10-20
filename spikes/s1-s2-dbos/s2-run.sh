#!/usr/bin/env bash
# S2 · DBOS application versioning. Usage: ./s2-run.sh [bun|node]   (default bun)
#   phase 1  version A workers start case-1, case-3, case-4, case-5; all killed (-9) mid-sleep
#   phase 2  version B deployed (same executor id 'local'); starts case-2. Are A cases touched?
#   phase 3  hazard: B code mislabelled as def-A recovers case-4
#   phase 4  drain: an A worker runs beside B; recovers case-1, then picks up case-3 after an
#            operator 'resume' (case-3's original executor never comes back)
#   phase 5  explicit migration: cancel case-5, fork it onto def-B from step 1
set -euo pipefail
cd "$(dirname "$0")"
RT=${1:-bun}
case "$RT" in bun) RUN=(bun) ;; node) RUN=(/opt/node22/bin/node) ;; *) echo "bun|node"; exit 1 ;; esac
PSQL="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54321 -U postgres -X -q"
DB=s2_$RT
export DBOS_SYSTEM_DATABASE_URL="postgresql://postgres@127.0.0.1:54321/$DB"
export LEDGER="out/s2-$RT.ledger" SLEEP_MS=8000
mkdir -p out; rm -f "$LEDGER" out/s2-$RT.*.out
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB" 2>/dev/null
PIDS=(); trap 'kill -9 "${PIDS[@]}" 2>/dev/null || true' EXIT

count() { cat "$LEDGER" 2>/dev/null | grep -c -- "$1" || true; }
wait_n() { for _ in $(seq 1 200); do [ "$(count "$1")" -ge "$2" ] && return 0; sleep 0.2; done; echo "timeout: $1 x$2"; exit 1; }
status() { $PSQL -d "$DB" -c "SELECT s.workflow_uuid AS wf, s.status, s.application_version AS version, s.executor_id, s.recovery_attempts AS rec, substring(o.error from '\"message\":\"([^\"]{0,75})') AS error FROM dbos.workflow_status s LEFT JOIN dbos.workflow_output o USING (workflow_uuid) ORDER BY 1"; }
steps() { $PSQL -d "$DB" -c "SELECT function_id AS id, function_name FROM dbos.operation_outputs WHERE workflow_uuid='$1' ORDER BY 1"; }
note() { echo; echo "=== $* ==="; }
bg() { local tag=$1; shift; env "$@" >"out/s2-$RT.$tag.out" 2>&1 & PIDS+=($!); LAST=$!; }

note "phase 1: version A workers start cases, then are killed mid-sleep"
# Migrate once up front: three workers launching on a fresh DB at once race on migrations.
"${RUN[@]}" s2-admin.mjs migrate 2>&1 | grep '^\[admin\]'
bg a-local EXECUTOR_ID=local    "${RUN[@]}" s2-def-a.mjs worker case-1;        PA1=$LAST
bg a-gone  EXECUTOR_ID=a-gone   "${RUN[@]}" s2-def-a.mjs worker case-3 case-5; PA2=$LAST
bg a-haz   EXECUTOR_ID=a-hazard "${RUN[@]}" s2-def-a.mjs worker case-4;        PA3=$LAST
wait_n "SLEEP begin" 4; sleep 1
kill -9 $PA1 $PA2 $PA3; sleep 0.5
status; steps case-1

note "phase 2: deploy version B (executor 'local', same as case-1's) and start case-2"
bg b-local EXECUTOR_ID=local "${RUN[@]}" s2-def-b.mjs worker case-2; PB=$LAST
wait_n "case-2  RETURN" 1; sleep 1
grep -E "recover|Application version|not the latest" out/s2-$RT.b-local.out || true
status

note "phase 3: hazard: version B code deployed under the old version label def-A"
bg haz EXECUTOR_ID=a-hazard APP_VERSION=def-A "${RUN[@]}" s2-def-b.mjs worker; PH=$LAST
for _ in $(seq 1 50); do $PSQL -d "$DB" -tAc "SELECT status FROM dbos.workflow_status WHERE workflow_uuid='case-4'" | grep -qvE 'PENDING|ENQUEUED' && break; sleep 0.2; done
sleep 0.5; kill -9 $PH
grep -E "Recovering|was recorded" out/s2-$RT.haz.out | head -3 || true
status

note "phase 4: drain: run a version A worker beside B"
bg a-drain EXECUTOR_ID=local "${RUN[@]}" s2-def-a.mjs worker; PD=$LAST
wait_n "case-1  RETURN" 1
grep -E "recover|not the latest" out/s2-$RT.a-drain.out || true
echo "-- case-3's executor 'a-gone' is never restarted; operator resumes it:"
"${RUN[@]}" s2-admin.mjs resume case-3 2>&1 | grep '^\[admin\]'
wait_n "case-3  RETURN" 1
status

note "phase 5: explicit migration of case-5 onto def-B (cancel + fork from step 1)"
"${RUN[@]}" s2-admin.mjs cancel case-5 2>&1 | grep '^\[admin\]'
"${RUN[@]}" s2-admin.mjs fork case-5 1 def-B case-5b 2>&1 | grep '^\[admin\]'
wait_n "case-5b RETURN" 1
status; steps case-5b
"${RUN[@]}" s2-admin.mjs versions 2>&1 | grep 'version {'

note "ledger (step executions, outside the DB)"; cat "$LEDGER"
