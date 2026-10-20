# @memwise/runtime

Runs and cases: workflow statecharts on XState with their state in our tables, one DBOS driver workflow per run and one per step, durable timers and outside events (D39). Wires the kernel together: stores from `@memwise/db`, gateways from `@memwise/gateway`, policy from `@memwise/policy`, the agent step from `@memwise/step-engine`. Also the `memwise` CLI and the sample tool set the intake project runs against.

**Boundary.** May depend on every other kernel package (`defs`, `db`, `policy`, `gateway`, `step-engine`). Nothing in the kernel depends on it.

## What it provides

| Export | What |
|---|---|
| `createKernel(options)` | Migrates (ours, DBOS's system schema, the data-source schema, the sample sandbox when sample tools are bound), builds the stores and gateways, configures the step engine and launches DBOS in this process. Returns a `Kernel`: `index()`, `startRun()`, `sendEvent()`, `decideApproval()`, `waitForRun()`, `getRun()`, `getTransitions()`, `getCase()`, `getStepRecord()`, `pendingApprovals()`, `pool`, `shutdown()`. |
| `compileMachine(workflow, initial?)` | `workflow.yaml` → an XState v5 machine: one state per state, `end` as a final state, `on` transitions, `wait.timeout` as an `after` transition, `wait.remind` as a delayed `remind` event. Per-state metadata via `metaOf` / `stateMeta`. |
| `stateKind(workflow, state)` | `agent-step`, `person-step`, `external-step`, `system-step`, `wait` or `final`. |
| `sampleTools(opts?)` | `gst.validate_gstin` (read), `intake.extract_fields` (read, quarantined), `email.send` (outbound, idempotent, into `mw_sandbox.outbox`), `crm.create_customer` (write, into `mw_sandbox.customers`). |
| `migrateAll(url)` | Every schema the kernel needs, for running once before workers start (D35). |

Files: `src/machine.ts` (shape → XState), `src/driver.ts` (the run driver and its commit), `src/prepare.ts` (step input, fixed in a journaled step), `src/runs.ts` (run, transition, timer and definition SQL), `src/kernel.ts`, `src/examples.ts` (example cases), `src/sample-tools.ts`, `src/cli.ts`, `src/ids.ts`.

## How a run runs

```
startRun        one transaction: the case (provenance input) and the run row, timers of the first state;
                then DBOS workflow "run:<runId>" (a fixed id: starting twice is harmless)
driver          loadRun, loadDefinition (journaled; the run is pinned to workflow id + hash, D36)
  agent step    prepareStep (journaled: policy layers → compilePolicy, case snapshot, attempt and prior
                attempts, step token, startedAt) → step workflow "<runId>/<enteredSeq>/<state>" → StepResult
                completed → event = outcome; needs_person / failed → that transition if the state has
                one, otherwise the run stops. Policy violations, an outcome without a transition and a
                step workflow that throws also stop the run, with the reason in mw.runs.stop_reason.
  person/external step   a `waiting` row in mw.step_runs, then wait like a wait state; the event that
                leaves the state completes it with that event as its outcome
  wait state    DBOS.recv('events', deadline = earliest pending timer) → the outside event or the timer's event
  system step   stops the run: mechanical steps run from Phase 2
  commit        ONE Postgres transaction through the DBOS data source: XState transition() over the
                stored snapshot, CAS on mw.runs.seq, a mw.transitions row, the step's case writes
                (mw.cases values + seq + mw.case_events), timers armed and cancelled
```

- **Outside events** (`sendEvent`) write `mw.inbox` and the DBOS message in one transaction; a repeated `idemKey` sends nothing. `forSeq` names the state entry answered (`run.enteredSeq`), and defaults to the run's current entry, read under a row lock in the same transaction; an answer for another entry is recorded with `accepted = false` and a `stale` note. An event the state doesn't handle is recorded the same way. Events are delivered at the next wait, so one sent while the driver is busy in an agent step is stale once the run has moved on.
- **Timers** are rows with an absolute `fire_at`, written once in the commit that entered the state. A timeout fires its stored event. A reminder is recorded as an accepted transition row with no state change (`note: reminder ...`); delivering it comes in Phase 2.
- **Approvals.** `decideApproval` moves `mw.approvals` from `pending` and sends the decision to the step workflow (`approval:<id>`) in one transaction; deciding twice changes nothing. It refuses (`applied: false`, status `expired`) when the approval's step run is no longer `waiting`, and `pendingApprovals()` lists only approvals of waiting step runs. The commit of a step's result marks its still-pending approvals `expired`.
- **Failed step workflows.** A step workflow that throws stops the run, and the same commit marks its step run `failed` with the error as its rationale.
- **Runs without a driver.** `createKernel` starts the driver of every `active` run after `DBOS.launch()`, so a crash between `startRun`'s commit and its `startWorkflow` loses nothing; the fixed driver id makes this a no-op for runs that have one.
- **Run budgets.** The step's input carries `runSpent`: the summed `usage` (tokens, model calls, duration) of the run's earlier step runs, read in the journaled preparation step.
- **Crash points** (`MEMWISE_CRASH_AT`, `packages/defs/src/testing.ts`): `after-step-before-commit@<state>` and `in-commit@<state>`, where `<state>` is the state the committing event leaves.
- **One kernel per process.** DBOS state is process-wide; `shutdown()` deregisters everything so the next `createKernel` can register again. `engineVersion` (default `memwise-kernel-1`) is DBOS's `applicationVersion`: bump it only when the driver's or the step's sequence of journaled calls changes (D36). `executorId` defaults to `local`.

## The CLI

```bash
bun packages/runtime/src/cli.ts check examples/intake
bun packages/runtime/src/cli.ts test examples/intake [--example pan-mismatch] [--database-url postgresql://postgres@host:port/postgres]
bun packages/runtime/src/cli.ts record '<runId>/0/check' --database-url postgresql://.../<db>
bun packages/runtime/src/cli.ts policy examples/intake client-intake check
```

- `check` loads the project and runs the checks against the sample tools and the recall tools, plus policy tightening for every step. Prints `file:line  error|warning  code  message`; exits 1 on errors.
- `test` runs each example case on a fresh database: on the server at `--database-url` (an admin URL), or else on a throwaway cluster in a temp folder. The kernel gets `scriptedProvider(example.model)` and `stubTools(sampleTools, example.tools)`, answers approvals from `example.approvals`, starts at `example.startAt` and waits until the run waits or stops, then compares `expect.outcome`, `state`, `writes` and `effects` (done `mw.effects` rows per tool). Examples without a model script are skipped. Exits 1 on any failure.
- `record` prints a step record, the context the agent saw and its journal (`MEMWISE_DATABASE_URL` works instead of the flag).
- `policy` prints a step's effective policy, each rule with its layer.

## Tests

```bash
cd packages/runtime
bun test                                   # all of it (~45 s)
bun test tests/exit.test.ts                # the Phase 1 exit test
MEMWISE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres bun test   # on an existing server
```

Each test file creates its own database (on `MEMWISE_TEST_DATABASE_URL` when set, else on a throwaway cluster) and drops it afterwards; suites skip where no Postgres is available.

| File | What |
|---|---|
| `tests/machine.test.ts` | Shape compile of the intake workflow, state kinds, timers as actions |
| `tests/driver.test.ts` | With a fake step: `check` → `needs_info` loops back to `fill` and waits; events move it; stale, duplicate and unhandled events are ignored; prior attempts; a 2 s timeout and a reminder; stops (system step, unhandled outcome, policy violation, a throwing step) |
| `tests/crash.test.ts` | The driver in a child process killed at `after-step-before-commit@check` and `in-commit@check`: after a restart, one transition, the case write applied once, the step's work not repeated |
| `tests/exit.test.ts` | **The Phase 1 exit test** (below) |
| `tests/sample-tools.test.ts`, `tests/cli.test.ts` | The sample tools and every CLI command |

**The exit test** loads `examples/intake`, indexes it and runs the `check` step against the pan-mismatch case with the real step engine, the scripted model from the example, stubbed `gst.validate_gstin` and `intake.extract_fields`, and the real sandbox `email.send`. The kernel runs in a child process (`tests/fixtures/kernel-worker.ts`) that is killed with `MEMWISE_CRASH_AT` at `after-model-call@2`, `waiting-approval@email.send` (approved after the restart), `after-tool-effect@email.send`, `after-ledger-complete@email.send` and `before-finish`, plus one run without a crash. After each restart the step finishes with `needs_info` and the run moves to `fill`, and the test asserts: every model call was made exactly once across both processes (a counter file), one `mw_sandbox.outbox` row and one done `mw.effects` row for the email (the retry after a lost result shows as `attempts = 2` on the same row), one transition, and the step record, its context and its journal (model, tool, approval and checkpoint entries) through `kernel.getStepRecord`.
