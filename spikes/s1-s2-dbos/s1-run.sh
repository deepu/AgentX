#!/usr/bin/env bash
# S1 crash-recovery driver. Usage: ./s1-run.sh bun | node
#   kill -9 #1 during the durable sleep (reserve+charge done)
#   kill -9 #2 in the middle of the 'ship' step (after the approval message was consumed)
#   final restart completes the workflow. The ledger shows which steps ran how often.
set -euo pipefail
cd "$(dirname "$0")"
RT=${1:?usage: s1-run.sh bun|node}
case "$RT" in bun) RUN=(bun) ;; node) RUN=(/opt/node22/bin/node) ;; *) echo "bun|node"; exit 1 ;; esac
PSQL="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54321 -U postgres -X -q"
DB=s1_$RT WF=order-$RT
export DBOS_SYSTEM_DATABASE_URL="postgresql://postgres@127.0.0.1:54321/$DB"
export LEDGER="out/s1-$RT.ledger" SLEEP_MS=10000
mkdir -p out; rm -f "$LEDGER" out/s1-$RT.*.out
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB" 2>/dev/null

wait_for() { for _ in $(seq 1 150); do grep -q "$1" "$LEDGER" 2>/dev/null && return 0; sleep 0.2; done; echo "timeout waiting for $1"; exit 1; }
status() { $PSQL -d "$DB" -c "SELECT workflow_uuid, status, application_version, recovery_attempts FROM dbos.workflow_status" ; }
steps() { $PSQL -d "$DB" -c "SELECT function_id, function_name, left(coalesce(output, error, ''), 40) AS output FROM dbos.operation_outputs WHERE workflow_uuid='$WF' ORDER BY function_id"; }
note() { echo; echo "=== $* ==="; }

note "[$RT] run 1: start $WF"
"${RUN[@]}" s1.mjs worker "$WF" >out/s1-$RT.1.out 2>&1 & P=$!
wait_for "SLEEP begin"; sleep 2
kill -9 $P; wait $P 2>/dev/null || true
note "[$RT] killed run 1 (pid $P) during durable sleep"; status; steps

note "[$RT] run 2: restart, expect recovery"
"${RUN[@]}" s1.mjs worker >out/s1-$RT.2.out 2>&1 & P=$!
wait_for "SLEEP end"
sleep 1; "${RUN[@]}" s1.mjs send "$WF" 2>&1 | grep '^\[send\]'
wait_for "START ship"; sleep 1.5
kill -9 $P; wait $P 2>/dev/null || true
note "[$RT] killed run 2 (pid $P) in the middle of step 'ship'"; status; steps

note "[$RT] run 3: restart, expect recovery to completion"
"${RUN[@]}" s1.mjs worker >out/s1-$RT.3.out 2>&1
grep -E 'Recovering|recover|result' out/s1-$RT.3.out
status

note "[$RT] ledger (outside the DB)"; cat "$LEDGER"
note "[$RT] executions per step"
for s in reserve charge ship; do
  printf '%-8s START x%s  END x%s\n' "$s" "$(grep -c "START $s" "$LEDGER")" "$(grep -c "END   $s" "$LEDGER")"
done
printf '%-8s logged x%s (body replay; value returned from the journal, sent once)\n' RECV "$(grep -c 'RECV' "$LEDGER")"
