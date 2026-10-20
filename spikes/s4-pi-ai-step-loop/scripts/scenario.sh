#!/usr/bin/env bash
# Runs one S4 scenario end to end: fresh DBOS database, fresh fake server and logs,
# a first process that may be killed with SIGKILL at a chosen point, then a restart.
#
#   scripts/scenario.sh baseline        no crash
#   scripts/scenario.sh kill-between    kill -9 after model:1 is checkpointed, before its tool steps
#   scripts/scenario.sh kill-in-tool    kill -9 inside send_email, after the email was sent
#   scripts/scenario.sh kill-in-model   kill -9 while model call 2 is still streaming
#   scripts/scenario.sh kill-after-tool kill -9 after send_email is checkpointed, before model:3
#   scripts/scenario.sh cancel-in-model DBOS cancel while model call 2 streams, then resume
# SUFFIX=-opus MODEL_ID=claude-opus-5-5 scripts/scenario.sh ...   same with another catalog model
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=$1
SUFFIX=${SUFFIX:-}
DIR=data/$NAME$SUFFIX
PORT=54399
DB=s4_${NAME//-/_}${SUFFIX//-/_}
PSQL="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54324 -U postgres -qAt"
export RUN_DIR=$DIR WF_ID=s4-invoice-intake DB_NAME=$DB FAKE_PORT=$PORT

wait_for() { # wait_for <file> <grep pattern>
  for _ in $(seq 1 1200); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.05; done
  echo "timeout waiting for $2 in $1"; return 1
}

rm -rf "$DIR"; mkdir -p "$DIR"
$PSQL -c "DROP DATABASE IF EXISTS $DB" >/dev/null
[ -f data/fake.pid ] && kill "$(cat data/fake.pid)" 2>/dev/null || true; sleep 0.3

FAKE_ENV=()
[[ "$NAME" = *-in-model ]] && FAKE_ENV=(FAKE_SLOW_TURN=2 FAKE_SLOW_MS=6000)
env "${FAKE_ENV[@]}" FAKE_LOG_DIR=$DIR bun src/fake-anthropic.ts > "$DIR/fake.out" 2>&1 &
FAKE_PID=$!; echo $FAKE_PID > data/fake.pid
P=""
trap 'rc=$?; set +e; kill $FAKE_PID 2>/dev/null; [ -n "$P" ] && kill -9 $P 2>/dev/null; exit $rc' EXIT
wait_for "$DIR/fake.out" listening || { cat "$DIR/fake.out"; exit 1; }

case "$NAME" in
  baseline)
    bun src/run.ts > "$DIR/run1.out" 2>&1 ;;
  kill-between)
    PAUSE_MS=2000 bun src/run.ts > "$DIR/run1.out" 2>&1 & P=$!
    wait_for "$DIR/progress.jsonl" '"step":"model:1","mode":"executed"'
    kill -9 $P; echo "kill -9 $P after model:1 checkpoint" | tee "$DIR/kill.txt" ;;
  kill-in-tool)
    TOOL_SLOW_MS=4000 bun src/run.ts > "$DIR/run1.out" 2>&1 & P=$!
    wait_for "$DIR/tool-executions.jsonl" '"phase":"effect_sent"'
    kill -9 $P; echo "kill -9 $P inside send_email after the effect was sent" | tee "$DIR/kill.txt" ;;
  kill-in-model)
    bun src/run.ts > "$DIR/run1.out" 2>&1 & P=$!
    wait_for "$DIR/requests.jsonl" '"turn":2'
    sleep 1.5
    kill -9 $P; echo "kill -9 $P while model call turn=2 was streaming" | tee "$DIR/kill.txt" ;;
  kill-after-tool)
    PAUSE_MS=2000 bun src/run.ts > "$DIR/run1.out" 2>&1 & P=$!
    wait_for "$DIR/progress.jsonl" '"step":"tool:send_email:toolu_t2_email","mode":"executed"'
    kill -9 $P; echo "kill -9 $P after tool:send_email checkpoint" | tee "$DIR/kill.txt" ;;
  cancel-in-model)
    bun src/run.ts > "$DIR/run1.out" 2>&1 & P=$!
    wait_for "$DIR/requests.jsonl" '"turn":2'
    sleep 1
    bun scripts/cancel.ts cancel | tee "$DIR/kill.txt"
    wait $P 2>/dev/null || true
    bun scripts/cancel.ts resume | tee -a "$DIR/kill.txt"
    P="" ;;
  *) echo "unknown scenario $NAME"; exit 2 ;;
esac
[ -n "$P" ] && { wait $P 2>/dev/null || true; }

if [ "$NAME" != baseline ]; then
  sleep 0.5
  echo "--- restart" | tee -a "$DIR/kill.txt"
  bun src/run.ts > "$DIR/run2.out" 2>&1
fi
echo "== $NAME done; logs in $DIR"
