# S5 · XState with DBOS — RESULT

**Verdict: PASS.** Under Bun 1.4.2 (and also Node 22.22), a three-step intake statechart (collect → check → approve, where approve can send back to collect, plus a 3-day approval timer that escalates) ran with its state in our own Postgres tables. Each step ran as its own DBOS workflow, and the run survived `kill -9` at all six crash points tested. No transition happened twice, and no completed step ran again. XState v5's pure functions (`initialTransition`, `transition`) are enough: no XState actor runs anywhere. The fallback (a custom statechart runner) is not needed.

Versions: `xstate@5.33.3`, `@dbos-inc/dbos-sdk@5.3.0`, `@dbos-inc/node-pg-datasource@5.3.0`, `pg@8.16.3`, PostgreSQL 16.15, Bun 1.4.2. No real LLM was used; the steps are fake work that sleeps and writes a row to `mw.effects`.

## Files

| File | What |
|---|---|
| `src/machine.ts` | The intake statechart in XState v5. `meta.step` names the step workflow for each state, and `meta.wait` marks a human wait. The timer is the named delay `approvalTimeout`, read from `context`, so it defaults to 3 days and tests can shorten it. |
| `src/runtime.ts` | The run driver, the step workflows, the commit transaction, timer handling and `createRun`. |
| `src/main.ts` | CLI: `init`, `serve`, `send`, `show`. |
| `src/schema.sql` | Our tables (schema `mw`). |
| `scripts/pg.sh` | A throwaway PG16 cluster in `data/pg` on port 54325. |
| `scripts/scenarios.sh` | All the scenarios below. |
| `logs/*.log` | Full evidence from the last run of each scenario. |

## The pattern

```
run driver = DBOS workflow, id "run:<runId>" (one per run; the fixed id makes a second start a no-op)
  run = loadRun()                                   DBOS step
  loop while run.status = 'active':
    meta = machine.states[run.state].meta
    if meta.step:
      h = DBOS.startWorkflow(steps[meta.step], { workflowID: "<runId>/<entered_seq>/<step>" })
      event = await h.getResult()                   deterministic id: after a crash we get the same
                                                    child back, finished or recovered, never a new one
    if no event and meta.wait:                      human wait = hibernate
      event = DBOS.recv('events', { deadlineEpochMS: earliest mw.timers.fire_at })
              ?? the timer's event                  timeout = the XState `after` fires
    run = commitTransition(run.seq, event)          ONE Postgres transaction (DBOS data source):
        snap  = machine.resolveState(run.snapshot)          restore, no actor
        [next, actions] = transition(machine, snap, event)  XState pure function
        UPDATE mw.runs SET snapshot, seq = seq+1 WHERE id AND seq = expected   (CAS)
        INSERT mw.transitions (run_id, seq) ...                                (PK = no double)
        arm/cancel mw.timers from actions (xstate.raise with delay / xstate.cancel)
        + DBOS writes the step's output into dbos_tx.transaction_completion in the SAME tx
```

Why transitions are applied exactly once (the "exactly-once-ish" semantics):
1. **One driver per run.** The DBOS workflow id `run:<runId>` is unique, so a second start or recovery returns the same workflow.
2. **Steps are not re-run.** Step workflow ids are deterministic (`<run>/<entered_seq>/<step>`), so a restarted driver gets back the stored result of a finished step. Inside a step, every unit of work is a DBOS step, so a recovered step workflow continues after its last completed step.
3. **The commit is a DBOS transaction.** It uses the `@dbos-inc/node-pg-datasource` transaction. Our `UPDATE`/`INSERT`s and DBOS's record of the commit's output commit or roll back together. A crash before COMMIT loses both, and the commit runs again. A crash after COMMIT replays the recorded output, and the commit does not run again.
4. **A compare-and-set guard backs this up.** `runs.seq` is compare-and-set and `transitions(run_id, seq)` is the primary key. If the commit is a plain DBOS step instead (`COMMIT_MODE=step`), our COMMIT can land without DBOS's checkpoint. The re-executed commit then finds `seq` already advanced and an identical `transitions` row, and returns the stored state (shown below). The guard would also stop a stray second writer.
5. **External events go into our inbox and DBOS in one transaction.** `send` inserts `mw.inbox(run_id, idem_key)` and calls `DBOSClient.sendInTransaction` in the same transaction. This works because the DBOS system schema (`dbos`) lives in the same database as `mw`. A duplicate key sends nothing. An answer carries `for: <entered_seq>`, the approval card it answers, so a late click on an old card can't move the run after a send-back.
6. **Timers have absolute deadlines.** `mw.timers.fire_at` is written once, inside the commit that entered the state. The driver passes it to `DBOS.recv({ deadlineEpochMS })`, and DBOS also stores that deadline in its journal (an operation named `DBOS.sleep`). A restart never recomputes it, and a deadline that passed while the process was down fires as soon as the process restarts.

### XState v5 findings
- `initialTransition(machine, input)` and `transition(machine, snapshot, event)` are pure and return `[snapshot, actions]`. `getNextSnapshot` is deprecated in favour of `transition`.
- **Delayed transitions come back as data.** Entering `approve` returns `{type:'xstate.raise', params:{id:'xstate.after.approvalTimeout.intake.approve', delay:259200000, event:{type:'xstate.after.approvalTimeout.intake.approve'}}}`. Leaving it returns `{type:'xstate.cancel', params:{sendId: same id}}`. The runner turns these into timer rows. Named `delays` can read `context`, so the 3-day duration is configurable per run.
- `assign` is already applied in the returned snapshot. Custom actions are returned but not run. The runner would have to map them to DBOS steps; the spike uses none.
- **`getPersistedSnapshot` is used only as a serializer.** It produces small JSON: `{"value":"approve","status":"active","context":{…},"children":{},"historyValue":{}}`. **Actor persistence (`createActor` + `getPersistedSnapshot`/`restoreSnapshot`) is not needed and should be avoided.** An actor runs `after` timers with in-process `setTimeout`, which is not durable. To restore, `machine.resolveState({ value, context, status })` gives a snapshot that `transition` accepts.
- `snapshot.can(event)` tells us whether an event is handled. If it isn't, `transition` returns the same snapshot. Such events are logged with `accepted=false` and a note.

## Schema (ours, `src/schema.sql`)

```sql
mw.runs        (id pk, workflow, version, state, status, snapshot jsonb, seq, entered_seq, driver_wf_id, created_at, updated_at)
mw.transitions (run_id, seq, from_state, to_state, event jsonb, source step|external|timer, accepted, note, step_wf_id, at,
                primary key (run_id, seq))
mw.timers      (run_id, timer_id, armed_seq, event jsonb, fire_at timestamptz, status pending|fired|cancelled,
                primary key (run_id, timer_id, armed_seq))
mw.inbox       (run_id, idem_key, event jsonb, at, primary key (run_id, idem_key))
mw.effects     (id, run_id, step_wf_id, name, pid, at)      -- spike only: one row per execution of fake work
```

What else is in the same database: DBOS's system schema `dbos` (workflow_status, operation_outputs, notifications, …) and the data source schema `dbos_tx.transaction_completion`. DBOS deletes the `transaction_completion` rows once the workflow finishes, because by then its own step checkpoints cover them.

## Commands

```bash
cd spikes/s5-xstate-dbos
bun install
./scripts/pg.sh init && ./scripts/pg.sh start          # PG16 on 127.0.0.1:54325, data in ./data/pg
./scripts/pg.sh psql -c "create database memwise"
bun src/main.ts init                                   # mw schema + dbos_tx schema (DBOS creates its own on launch)
./scripts/scenarios.sh                                 # all scenarios, ~70 s; or name some: ./scripts/scenarios.sh three_day
RT=/opt/node22/bin/node ./scripts/scenarios.sh timer_live   # same code under Node 22 (type stripping)
bun src/main.ts show <runId>                           # our tables + DBOS journal for a run
./scripts/pg.sh stop
```

By hand: `bun src/main.ts serve --start r1 --timeout-ms 5000`, then `bun src/main.ts send r1 approved key-1 manager --for 2`. Crash points are set by environment variable: `CRASH_AT=<point>@<state-or-step>` (`mid-step@check`, `after-step-before-commit@check`, `in-commit@approve`, `after-commit@approve`, `after-commit-before-checkpoint@approve` with `COMMIT_MODE=step`). The process runs `process.kill(pid,'SIGKILL')` on itself at that point. For the waits, the script runs `kill -9` from outside.

## Evidence

Every scenario finished with `transition_rows = max_seq = runs.seq` (no gaps, no doubles) and `max_executions_per_effect = 1` (no completed step work ran again). Full output is in `logs/`.

Note on reading the logs: after a restart, the driver's own log lines (`step … ->`, `committed seq=…`) print again. Those lines are workflow code being replayed, while DBOS returns the recorded results of steps and transactions. Lines starting with `effect` are the only real executions, and the `pids` column in `mw.effects` shows which process did each one.

**A. Loop, duplicates, stale and unhandled events** (`happy_loop.log`, no crash)
```
   3 | approve | collect | {"by":"manager","type":"sent_back"} | external | true  | null
   4 | collect | check   | {"type":"collected"}                | step     | true  | null | loop-104442/3/collect
   5 | check   | approve | {"type":"checked"}                  | step     | true  | null | loop-104442/4/check
   6 | approve | approve | {"by":"manager","for":2,"type":"approved"} | external | false | stale: for entry 2, current entry 5
   7 | approve | approve | {"by":"manager","type":"collected"} | external | false | not handled in approve
   8 | approve | done    | {"by":"manager","for":5,"type":"approved"} | external | true | null
duplicate key sb-1: not sent again
timers: two rows (armed_seq 2 and 5), both 'cancelled' on leaving approve; context.attempts = 1
```

**B. kill -9 mid-step** (`mid_step.log`, killed inside `step.check` after `extract_fields`, before `validate`)
```
[pid 21632]   effect check.extract_fields done in mid-104442/1/check
[pid 21632] *** CRASH_AT=mid-step@check: kill -9 self
-- restart --
[pid 21702]   effect check.validate done in mid-104442/1/check      <- only the unfinished step runs
mid-104442/1/check | check.extract_fields | 1 | [21632]
mid-104442/1/check | check.validate       | 1 | [21702]
```

**C. Step finished, transition not yet written** (`after_step.log`)
```
[pid 21830] step astep-104442/1/check -> {"type":"checked"}
[pid 21830] *** CRASH_AT=after-step-before-commit@check: kill -9 self
after crash: runs.seq=1, state=check; dbos: astep-104442/1/check SUCCESS, run:astep-104442 PENDING
-- restart: the driver re-attaches to the finished child by id, no new execution --
astep-104442/1/check | check.extract_fields | 1 | [21830]
astep-104442/1/check | check.validate       | 1 | [21830]
final transitions 1,2,3 (check -> approve exactly once)
```

**D. Killed inside the commit transaction, before COMMIT** (`in_commit.log`)
```
[pid 22029] *** CRASH_AT=in-commit@approve: kill -9 self
after crash: runs.seq=1, state=check; transitions has only seq 1      <- rolled back
dbos_tx.transaction_completion has function 3 (previous commit) but not 6
-- restart: the commit runs once → seq 2 check -> approve; final seq 3 --
```

**E. Killed right after the commit returned** (`after_commit.log`)
```
[pid 22207] committed seq=2 state=approve status=active
[pid 22207] *** CRASH_AT=after-commit@approve: kill -9 self
after crash: transaction_completion has functions 3 and 6 → on restart commit #6 is replayed, not re-run
final transitions: 1 collect→check, 2 check→approve, 3 approve→done  (no duplicate seq 2)
```

**F. Our COMMIT landed, DBOS checkpoint did not** (`commit_no_ckpt.log`, `COMMIT_MODE=step`)
```
after crash: runs.seq=2 state=approve, transitions 1,2; driver journal ends at op 5 (no commitTransition #6)
[pid 22406] *** CRASH_AT=after-commit-before-checkpoint@approve: kill -9 self
[pid 22550]   commit seq 2 already applied by an earlier attempt -> returning stored state (no double transition)
final: transitions 1,2,3, run_seq 3
```

**G. 3-day timer, kill -9 while waiting, approval sent while down** (`three_day.log`)
```
[pid 22675] waiting in approve …, timer xstate.after.approvalTimeout.intake.approve fires at 2026-10-23T10:45:19.314Z
=== kill -9 22675 while waiting on the 3-day timer
mw.timers:               xstate.after.approvalTimeout.intake.approve | 2 | 2026-10-23T10:45:19.314Z | pending
dbos.operation_outputs:  10 | DBOS.sleep | 1792752319316 | 2026-10-23T10:45:19.316Z     <- DBOS's own stored deadline
=== restart; still waiting with the same deadline
[pid 22861] waiting in approve …, fires at 2026-10-23T10:45:19.314Z       (same deadline; both tables unchanged)
=== kill -9 22861 again; send the approval while no process is running
[pid 22987] sent {"type":"approved","by":"manager"} to run:3d-104442 key=ap-1
=== restart; the queued approval is consumed
[pid 23003] received external event {"type":"approved","by":"manager"}
final: timer 'cancelled', transitions 1,2,3, driver SUCCESS after 3 recovery attempts
```

**H. Short timer: kill -9 while waiting, process down past the deadline** (`timer_fires.log`, 5 s timer)
```
[pid 23164] waiting in approve …, timer … fires at 2026-10-20T10:45:35.055Z
=== kill -9 23164 1s into the wait; stay down 8s (past the deadline)
=== restart at 10:45:39.569
[pid 23578] received timer event {"type":"xstate.after.approvalTimeout.intake.approve"}   at 10:45:41.012 (immediately; not 5 s later)
[pid 23578] committed seq=3 state=escalated
timers: … | 2026-10-20T10:45:35.054Z | fired;   escalate.notify_partner ran once
```

**I. Short timer firing with no crash** (`timer_live.log`, 3 s; also `node22_timer_live.log` under Node 22)
```
waiting in approve … fires at 10:43:29.430Z  →  received timer event at 10:43:29.438Z → escalated → approved → done
```

## Caveats
- **Effects inside a step are at-least-once at step granularity.** A kill after an effect but before DBOS checkpoints that step would repeat it. That is the S4 / effect-gateway job (idempotency keys). The kill points here sit between steps.
- **Timers interrupt waits only, not running steps.** A timer on a work state (a step timeout) needs the driver to race the step handle against `recv`, then cancel the child with `DBOS.cancelWorkflow`. This was not built here.
- **Messages queue until the next `recv`, whatever the state.** An answer sent during `check` is delivered when the run next waits. So every human answer must name the entry it answers (`for: entered_seq` here, or an inbox item id in the real thing). Otherwise a stale click applies to a later card.
- **Only the subset of XState used here was tested:** flat states, `on`, `assign`, `after`, `final`. Nested or parallel states need the driver to walk all active leaves and start several step workflows (`DBOS.waitFirst`). History states would need `historyValue` passed back through `resolveState` (untested). `invoke`, `spawn`, `sendTo` and immediate `raise` are not supported; the compiler from `workflow.yaml` should emit only the supported subset and reject the rest.
- **The driver's journal grows by 3–5 operations per transition**, and replay re-runs the whole loop. That is fine for intake. A long-lived run (a monthly close with thousands of events) should "continue as new": end the driver every N transitions and start `run:<id>:<generation>`. This is trivial because the state is in our tables.
- A wait with no timer wakes every hour (`recv` timeout 3600 s) and adds 2 journal rows each time. Use a longer timeout in production.
- **The DBOS application version is pinned** (`applicationVersion: 's5-v1'`). Otherwise a code change between the crash and the restart would leave pending workflows unrecovered. Matching this to definition versions is S2's question. Recovery here is single-executor (`local`); several workers need executor ids or DBOS Conductor (S1).
- DBOS starts recovery about 1 s after `launch()`.
- **Our tables and DBOS's system schema must share one database** for `sendInTransaction`, which writes the inbox row and the message atomically. This fits D11. A separate system database would lose that atomicity (we would fall back to an idempotent `send` after our commit).
- The deadline in `recv`'s journal entry differs from `mw.timers.fire_at` by 2 ms or less (millisecond rounding). `mw.timers` is the source of truth.

## Recommended pattern for `@memwise/runtime`
1. **XState for the shape, pure functions only.** Compile `workflow.yaml` to a machine. Never create actors. Restore with `machine.resolveState(row.snapshot)`, step with `transition()`, and store `getPersistedSnapshot()` JSON in `runs.snapshot`.
2. **One DBOS run-driver workflow per run** (`run:<id>`). It loops: start the step workflow with id `<run>/<entered_seq>/<step>`, or hibernate in `DBOS.recv({deadlineEpochMS})` for human waits; then commit.
3. **The commit is a DBOS data source transaction** that applies the transition and checkpoints in one Postgres transaction. Keep the `seq` compare-and-set and the `(run_id, seq)` primary key as invariants and as the guard against other writers.
4. **Timers from XState `after` actions** become rows with an absolute `fire_at`, armed and cancelled inside the same commit; the wait uses `deadlineEpochMS`. Durations are named delays read from case or workflow config ("3d" from `workflow.yaml`).
5. **External events are written to our inbox table and sent to the driver with `sendInTransaction`**, carrying an idempotency key and the entry they answer. Unhandled or stale events are logged with `accepted=false` and a reason, and never move the run.
6. **Steps are their own DBOS workflows** (as decided in D24 and 07 §2), with every model and tool call as a DBOS step inside (S4).
