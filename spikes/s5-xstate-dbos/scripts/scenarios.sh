#!/usr/bin/env bash
# Crash scenarios for S5. Each scenario uses a fresh run id; logs go to logs/<scenario>.log.
# Usage: ./scripts/scenarios.sh [scenario ...]   (default: all)
set -uo pipefail
cd "$(dirname "$0")/.."
RT=${RT:-bun}                    # or: RT=/opt/node22/bin/node
mkdir -p logs
TAG=${TAG:-$(date +%H%M%S)}      # run ids are unique per invocation

main() { $RT src/main.ts "$@"; }

# serve_bg <logfile> [ENV=val ...] -- <serve args>; sets $PID
serve_bg() {
  local logf=$1; shift; local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  env "${envs[@]}" $RT src/main.ts serve "$@" >>"$logf" 2>&1 &
  PID=$!
}
wait_log() { # <file> <pattern> [timeout s]
  local t=$(( ${3:-30} * 10 ))
  for ((i = 0; i < t; i++)); do grep -q -- "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
  echo "TIMEOUT waiting for '$2' in $1"; return 1
}
wait_exit() { for ((i = 0; i < 300; i++)); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done; echo "still running: $1"; }
say() { echo -e "\n=== $*" | tee -a "$LOG"; }
show() { main show "$1" >>"$LOG" 2>&1; }

# A. Happy path with the loop: approve -> sent_back -> collect -> check -> approve -> approved.
#    Also: a duplicate idempotency key, a stale answer to the first approval card, and an event the state does not accept.
happy_loop() {
  local r=loop-$TAG; LOG=logs/happy_loop.log; : >"$LOG"
  say "start $r (timer 60s so it does not fire)"
  serve_bg "$LOG" -- --start $r --timeout-ms 60000 --until-done $r
  wait_log "$LOG" "waiting in approve" || return
  main send $r sent_back sb-1 >>"$LOG" 2>&1
  main send $r sent_back sb-1 >>"$LOG" 2>&1          # same key: dropped
  main send $r approved ap-old manager --for 2 >>"$LOG" 2>&1   # late click on the first card: stale, ignored
  wait_log "$LOG" "committed seq=5 state=approve" || return
  main send $r collected stray-1 >>"$LOG" 2>&1       # not handled in approve: logged, ignored
  sleep 1
  main send $r approved ap-1 manager --for 5 >>"$LOG" 2>&1
  wait_exit $PID; show $r
}

# Kill -9 at a crash point inside the process, restart without it, approve, finish.
crash_and_recover() { # <scenario> <run> <CRASH_AT> [extra env]
  local name=$1 r=$2 crash=$3; shift 3; LOG=logs/$name.log; : >"$LOG"
  say "start $r with CRASH_AT=$crash $*"
  serve_bg "$LOG" CRASH_AT=$crash "$@" -- --start $r --timeout-ms 60000
  wait_exit $PID
  say "process $PID died; tables right after the crash"; show $r
  say "restart without CRASH_AT"
  serve_bg "$LOG" "$@" -- --until-done $r
  wait_log "$LOG" "waiting in approve" || return
  main send $r approved ap-1 >>"$LOG" 2>&1
  wait_exit $PID; say "final"; show $r
}

mid_step()        { crash_and_recover mid_step        mid-$TAG    mid-step@check; }
after_step()      { crash_and_recover after_step      astep-$TAG  after-step-before-commit@check; }
in_commit()       { crash_and_recover in_commit       incommit-$TAG in-commit@approve; }
after_commit()    { crash_and_recover after_commit    acommit-$TAG after-commit@approve; }
# Plain DBOS step for the commit (not a data-source transaction): our COMMIT lands, DBOS's checkpoint does not.
commit_no_ckpt()  { crash_and_recover commit_no_ckpt  nockpt-$TAG after-commit-before-checkpoint@approve COMMIT_MODE=step; }

# B. 3-day timer: kill -9 while waiting, show the stored deadline survives; approval sent while down.
three_day() {
  local r=3d-$TAG; LOG=logs/three_day.log; : >"$LOG"
  say "start $r with the default 3-day approval timer"
  serve_bg "$LOG" -- --start $r
  wait_log "$LOG" "waiting in approve" || return; sleep 1
  say "kill -9 $PID while waiting on the 3-day timer"; kill -9 $PID; wait_exit $PID; show $r
  say "restart; still waiting with the same deadline"
  serve_bg "$LOG" -- --until-done $r
  sleep 4; show $r
  say "kill -9 $PID again; send the approval while no process is running"; kill -9 $PID; wait_exit $PID
  main send $r approved ap-1 >>"$LOG" 2>&1
  say "restart; the queued approval is consumed"
  serve_bg "$LOG" -- --until-done $r
  wait_exit $PID; say "final"; show $r
}

# C. Short timer (5s): kill -9 while waiting, stay down past the deadline, restart -> fires at once.
timer_fires() {
  local r=timer-$TAG; LOG=logs/timer_fires.log; : >"$LOG"
  say "start $r with a 5s approval timer"
  serve_bg "$LOG" -- --start $r --timeout-ms 5000
  wait_log "$LOG" "waiting in approve" || return; sleep 1
  say "kill -9 $PID 1s into the wait; stay down 8s (past the deadline)"; kill -9 $PID; wait_exit $PID
  sleep 8
  say "restart at $(date -u +%H:%M:%S.%N | cut -c1-12)"
  serve_bg "$LOG" -- --until-done $r
  wait_log "$LOG" "waiting in escalated" || return
  main send $r approved ap-1 >>"$LOG" 2>&1
  wait_exit $PID; say "final"; show $r
}

# D. Short timer firing live, no crash.
timer_live() {
  local r=live-$TAG; LOG=logs/timer_live.log; : >"$LOG"
  say "start $r with a 3s approval timer, no crash"
  serve_bg "$LOG" -- --start $r --timeout-ms 3000 --until-done $r
  wait_log "$LOG" "waiting in escalated" 20 || return
  main send $r approved ap-1 >>"$LOG" 2>&1
  wait_exit $PID; show $r
}

ALL="happy_loop mid_step after_step in_commit after_commit commit_no_ckpt three_day timer_fires timer_live"
for s in ${@:-$ALL}; do echo ">>> $s"; $s; done
