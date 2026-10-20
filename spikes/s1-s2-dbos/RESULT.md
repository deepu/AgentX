# Spikes S1 and S2: DBOS under Bun, DBOS versioning

**S1 · DBOS under Bun: PASS.** A DBOS workflow with steps, a durable sleep, `setEvent`/`getEvent` and `send`/`recv` runs under Bun 1.4.2. After `kill -9` it recovers from the last completed step, with no completed step run again. Node 22 behaves the same.

**S2 · DBOS versioning: PASS, with conditions.** A workflow started on version A stays pinned to A. B never recovers or dequeues it. It resumes on A once an A process runs, either beside B or after B. Making this work in production needs three things that MemWise has to build or decide: version labels, version-pinned workers or drain workers, and a supervisor for orphaned executors. The patch API does not pin a workflow to its old code.

- DBOS: `@dbos-inc/dbos-sdk` **5.3.0** (npm `latest`, 2026-10-15), which brings in `pg` 8.23.1.
- Runtimes: Bun 1.4.2. Node 22.22.0 was used for comparison. Bun 1.3.10, the version CI uses, was not tested.
- System database: **Postgres only.** The TypeScript SDK has no SQLite backend (`grep -ri sqlite` over the package finds nothing). It talks to Postgres through `pg`. Pointed at a database URL, it creates the database and runs its own migrations into a `dbos` schema.
- Postgres 16 throwaway cluster on port 54321 (`./pg.sh`).

---

## S1 · DBOS under Bun: PASS

### What was run

`s1.mjs` holds one workflow, `orderWorkflow`:

```
step reserve → step charge → setEvent(progress=charged) → DBOS.now → DBOS.sleep(10 s)
  → setEvent(progress=awaiting-approval) → recv('approval') → step ship (4 s) → setEvent(done)
```

Each step appends `START` and `END` lines to a ledger file outside the database. A second process sends the approval with `DBOSClient` (`getEvent` + `send` with an idempotency key). `s1-run.sh` drives the test:

1. Run 1 starts the workflow. It is killed with `kill -9` **during the durable sleep**, after `reserve` and `charge` have completed.
2. Run 2 is a plain restart and recovers the workflow. The approval is sent from another process. Run 2 is then killed with `kill -9` **in the middle of step `ship`**, after the message was consumed.
3. Run 3 is a plain restart and recovers the workflow to completion.

```
./pg.sh start
./s1-run.sh bun     # output saved in out/s1-bun.result
./s1-run.sh node    # output saved in out/s1-node.result
```

### Evidence (Bun; Node output is identical apart from pids and times)

The ledger, written outside the database (an excerpt; the full file is in `out/s1-bun.ledger`). pid 22442 is run 1, pid 22603 is run 2 and pid 23064 is run 3:

```
10:45:12.449Z pid=22442 bun-1.4.2 START reserve
10:45:12.950Z pid=22442 bun-1.4.2 END   reserve
10:45:12.957Z pid=22442 bun-1.4.2 START charge
10:45:13.457Z pid=22442 bun-1.4.2 END   charge
10:45:13.472Z pid=22442 bun-1.4.2 SLEEP begin (durable 10000 ms, first started at 10:45:13.470Z)
              -- kill -9 --
10:45:16.875Z pid=22603 bun-1.4.2 BODY  enter workflow order-bun
10:45:16.884Z pid=22603 bun-1.4.2 SLEEP begin (durable 10000 ms, first started at 10:45:13.470Z)
10:45:23.474Z pid=22603 bun-1.4.2 SLEEP end (10004 ms after original start)
10:45:24.729Z pid=22603 bun-1.4.2 RECV  approval={"by":"manager","ok":true}
10:45:24.731Z pid=22603 bun-1.4.2 START ship
              -- kill -9 --
10:45:27.580Z pid=23064 bun-1.4.2 BODY  enter workflow order-bun
10:45:27.601Z pid=23064 bun-1.4.2 SLEEP end (14131 ms after original start)
10:45:27.605Z pid=23064 bun-1.4.2 RECV  approval={"by":"manager","ok":true}
10:45:27.607Z pid=23064 bun-1.4.2 START ship
10:45:31.607Z pid=23064 bun-1.4.2 END   ship

reserve  START x1  END x1
charge   START x1  END x1
ship     START x2  END x1
```

The journal after the second kill (`dbos.operation_outputs`):

```
 0 reserve | 1 charge | 2 DBOS.setEvent | 3 DBOS.now | 4 DBOS.sleep (wake-up 1792493123473)
 5 DBOS.setEvent | 6 DBOS.recv {"by":"manager","ok":true} | 7 DBOS.sleep (recv timeout)
status PENDING, recovery_attempts 2  →  after run 3: SUCCESS, recovery_attempts 3
```

What the runs show:

- **No completed step ran again.** `reserve` and `charge` each ran once across three processes.
- **The durable sleep kept its original wake-up time.** Run 2 slept only the remaining 6.6 s, so the total from the original start was 10 004 ms. Run 3 found the sleep already over and continued at once.
- **The message was consumed once.** Run 3 got the approval back from the journal (`DBOS.recv`, function 6) and did not wait for a new one. The `RECV` log line appears twice because it sits in the workflow body, which replays.
- **The step that was in flight ran again.** `ship` was killed between START and END, so it was never checkpointed, and recovery ran it a second time. DBOS steps are at-least-once. This is the case that the idempotency keys in 07 §2 must cover.
- Recovery is automatic on `DBOS.launch()`, which logs `Recovering 1 workflows from application version s1-v1`.

### Other checks under Bun

- **Decorators.** `s1-decorators.ts` uses `@DBOS.workflow()` and `@DBOS.step()` (legacy TypeScript decorators, `experimentalDecorators` in `tsconfig.json`). It runs under Bun's TypeScript transpiler without a build step and prints `result: hello bun | event: hello bun`.
- **Bundling.** `bun build s1.mjs --target=bun` works once DBOS's optional dependencies are marked external: `-e @opentelemetry/exporter-logs-otlp-proto -e @opentelemetry/exporter-trace-otlp-proto -e @opentelemetry/sdk-logs -e winston -e winston-transport`. DBOS loads these with `require()` only when OTLP is on. The 1.27 MB bundle ran the workflow end to end.
- **Startup time.** Launch plus shutdown against an existing system database takes about 290–330 ms under Bun and about 315–345 ms under Node.

### Caveats

- **No Bun incompatibility was found** and no workaround was needed. Two warnings appear under both runtimes and are not Bun issues:
  - `pg` prints `DeprecationWarning: Calling client.query() when the client is already executing a query…`. This comes from DBOS 5.3.0 with `pg` 8.23 and is harmless for now. It will matter at `pg@9`.
  - **Concurrent first launches race.** When three processes launch at the same moment against a fresh database, they collide on DBOS's migrations (`duplicate key … dbos_migrations_pkey`, `relation … already exists`). In every one of 6 trials (3 on Bun, 3 on Node) at least two of the three processes failed, and in 4 trials all three did. Bun and Node fail the same way. The fix is to run `DBOS.migrate(url)` once before starting workers (`s2-admin.mjs migrate`). MemWise runs migrations at startup in any case.
- The sandbox shell set `BUN_OPTIONS=--smol` (Bun's low-memory mode), so every Bun run here used it. Nothing suggests that changes the result.
- Only Bun 1.4.2 was tested. CI pins Bun 1.3.10, which needs one rerun: `./s1-run.sh bun` with that Bun on `PATH`.
- DBOS keeps process-wide static state: one `DBOS` instance per process, with one app name, one application version and one executor ID. The S2 caveats follow from this.

### Recommendation for MemWise

**Keep DBOS in-process under Bun.** The Node-worker fallback is not needed. The step engine should treat every journaled call as at-least-once if it is interrupted mid-call, and put idempotency keys on effects (07 §2 already plans this). Run `DBOS.migrate()` as part of the database migration step. Do not leave it to concurrent `launch()` calls.

---

## S2 · DBOS versioning: PASS (pinned to A), with conditions

### How DBOS versions work (read from 5.3.0 source and confirmed by the runs)

- **Version label.** It comes from `config.applicationVersion`, else `DBOS__APPVERSION`, else an MD5 of the source of every registered *workflow* function plus the DBOS version and app name. Step functions registered separately are not hashed. A bundled build changes the default hash. Every workflow row records the `application_version` it started on.
- **Recovery at launch.** A process re-enqueues only `PENDING` workflows where `executor_id = its executor ID` **and** `application_version = its version` (`reenqueueWorkflowsForRecovery`).
- **Queue dequeue.** The latest version takes rows of its own version plus rows with a null version. Any other version takes **only rows of its own version**. "Latest" means the version registered most recently in `dbos.application_versions`. `setLatestApplicationVersion` changes it, which is how a rollback works.
- **Determinism check on replay.** A step whose name differs from the journal entry at the same position throws `DBOSUnexpectedStepError`, and the workflow ends in `ERROR`.
- **Operator tools** (`DBOSClient`): `resumeWorkflow` (re-enqueue under the *same* version), `forkWorkflow(id, startStep, {applicationVersion})` (copy history before `startStep` into a new workflow on a chosen version), `rewindWorkflow`, `cancelWorkflow`, `listApplicationVersions`.
- **Patching.** With `enablePatching: true`, the version becomes the constant `PATCHING_ENABLED`, so every process recovers every workflow. Code then branches with `DBOS.patch(name)` and later `DBOS.deprecatePatch(name)`.
- No executor ID (`executorID` or `DBOS__VMID`) is set by default, so it is `local`. Without DBOS Conductor, a paid control plane, nothing recovers the workflows of an executor ID that never comes back.

### What was run

There are two definitions of the same workflow `caseWorkflow`, with different step code:

| | file | steps | version |
|---|---|---|---|
| A | `s2-def-a.mjs` | intake → sleep 8 s → review-A → close | `def-A` |
| B | `s2-def-b.mjs` | intake → **classify-B** → sleep → **review-B** → close | `def-B` |

```
./s2-run.sh bun          # output saved in out/s2-bun.result   (same scenario with node: out/s2-node.result)
./s2-patch-run.sh bun    # output saved in out/s2p-bun.result  (same scenario with node: out/s2p-node.result)
```

`s2-run.sh` runs five phases:

1. Version A workers start case-1 (executor `local`), case-3 and case-5 (executor `a-gone`) and case-4 (executor `a-hazard`). All are killed with `kill -9` mid-sleep.
2. **Version B is deployed** with the same executor ID, `local`, and starts case-2.
3. Hazard: B's code is started under the old label `def-A`, executor `a-hazard`.
4. **Drain:** an A worker runs beside the running B worker. Executor `a-gone` never returns, so an operator calls `resume case-3`.
5. Migration: case-5 is cancelled and forked onto `def-B` from step 1.

### Evidence (Bun; Node gives the same final table)

After phase 2, B is up, case-2 has finished on B code, and **every A case is untouched**:

```
B log: Application version: def-B
       No workflows to recover from application version def-B
   wf   | status  | version | executor_id
 case-1 | PENDING | def-A   | local        ← same executor id as B, still not recovered by B
 case-2 | SUCCESS | def-B   | local
 case-3 | PENDING | def-A   | a-gone
```

Phase 3, the wrong label. B's code replays A's journal and fails:

```
Recovering 1 workflows from application version def-A
case-4 | ERROR | def-A | During execution of workflow case-4 step 1, function DBOS.sleep was recorded when classify-B was expected.
```

Phase 4, the drain. The A worker recovers case-1 by itself and picks up case-3 after the operator resume. B (running, and the latest version) does not take case-3:

```
A log: Current version 'def-A' is not the latest version. Latest version is 'def-B'.
10:41:30.642 code=A ver=def-A exec=local -       WORKER up
10:41:31.664 code=A ver=def-A exec=local case-1  STEP  review-A   ← intake not re-run (ran once at 10:41:15.553)
10:41:32.274 code=A ver=def-A exec=local case-1  RETURN review=review-A
[admin] resume case-3 ok
10:41:32.660 code=A ver=def-A exec=local case-3  STEP  review-A   ← executor_id moved a-gone → local
```

Phase 5 and the final state:

```
   wf    |  status   | version | executor_id | rec
 case-1  | SUCCESS   | def-A   | local       |   2   finished on A code
 case-2  | SUCCESS   | def-B   | local       |   1
 case-3  | SUCCESS   | def-A   | local       |   1   drained by an A worker after operator resume
 case-4  | ERROR     | def-A   | a-hazard    |   2   wrong label: nondeterminism error
 case-5  | CANCELLED | def-A   | a-gone      |   1
 case-5b | SUCCESS   | def-B   | local       |   1   fork of case-5 onto def-B: intake copied, then classify-B, sleep, review-B, close
```

`s2-patch-run.sh` tests the patch API. Version A runs under `enablePatching`, and `s2-def-b-patched.mjs` is version B with `if (await DBOS.patch('v2-classify')) classify-B` and `patch('v2-review') ? review-B : review-A`.

```
case-p1 (started on old code, killed mid-sleep, recovered by new code):
  0 intake | 1 DBOS.sleep | 2 DBOS.patch-v2-review | 3 review-B | 4 close
case-p2 (started on new code):
  0 intake | 1 DBOS.patch-v2-classify | 2 classify-B | 3 DBOS.sleep | 4 DBOS.patch-v2-review | 5 review-B | 6 close
case-p3 (started on new code, recovered by OLD code = rollback):
  ERROR  function DBOS.patch-v2-classify was recorded when DBOS.sleep was expected.
```

### What happens to the A workflow when B is deployed

| Question | Answer |
|---|---|
| Is it left pending? | **Yes.** It stays `PENDING` under `def-A` indefinitely. B neither recovers it at launch nor dequeues it, even with the same executor ID. Nothing raises an alarm. |
| Is it recovered by B? | **No**, unless B is mislabelled with A's version. Then B replays A's journal and the workflow fails permanently with `DBOSUnexpectedStepError`. |
| Can a process running A recover it? | **Yes.** A restarted A process with the same executor ID recovers it at launch. A new A process with any executor ID runs it after `resumeWorkflow`. Both work while B is running and is the latest version. A warns that it is not the latest but still serves its own version. |
| Can it be moved to B? | Only on purpose: cancel it and `forkWorkflow(id, step, {applicationVersion:'def-B'})`. This gives a new workflow ID that reuses the journal before `step`. |
| Does patching pin it to A? | **No.** `DBOS.patch` returns false only where the journal already holds a different entry at that position. A patch the workflow has not reached yet returns true. case-p1 started on A but ran `review-B`. Patching is "old history replays, the rest runs new code". Rolling back past a patch fails the workflow. |

### Caveats

- The default version is a hash of the workflow source. Any edit to a workflow function, any DBOS upgrade and any bundling change gives a new version, and every in-flight workflow is then stranded until an old process runs. MemWise must set `applicationVersion` explicitly.
- **Desktop.** There is only one process and no old build left after an upgrade, so workflows from the previous engine version stay `PENDING` for good. They need an explicit startup step: fork or rewind onto the new version, or cancel and re-run the step. The alternative is a version label that changes only when the journal format becomes incompatible.
- **Server without Conductor.** Executor IDs must be stable per worker slot, or a small supervisor must `resumeWorkflow` the `PENDING` workflows of executors that are gone. Phase 4 shows that `resumeWorkflow` keeps the version, so only a matching worker runs the workflow.
- A process serves exactly one version. Draining means running separate processes, one per live version.

### Recommendation for MemWise

MemWise's definition versions (step files, instructions, schemas) are **data**. DBOS application versions are about **engine code**. Keep the two apart:

1. **Pin the definition version as a workflow input.** The step workflow is a generic runner, `runStep(caseId, stepRef, definitionVersionId)`. It loads the immutable, content-addressed definition snapshot in its first journaled step. Recovery replays that input and that step result, so a case resumes on the definition it started with whatever has been published since. This needs no DBOS versioning at all and satisfies "running cases pinned to the definition version they started on" directly.
2. **Set `applicationVersion` explicitly to an engine journal-compatibility version** such as `engine-3`. Do not use the source hash or a per-build ID. Bump it only when the runner's sequence of journaled calls changes incompatibly. Small engine changes go behind `DBOS.patch` or `deprecatePatch`, accepting that in-flight runs take the new path at points they have not reached yet.
3. **When the engine version is bumped:**
   - On the server, keep the previous engine version's worker pool running until `listWorkflows({applicationVersion: old, status: PENDING|ENQUEUED})` is empty. This is the fallback in the plan ("pin workers per version and drain old ones") and it works as shown.
   - On desktop, at startup, fork each old-version `PENDING` workflow onto the new version from its last step boundary, or cancel it and restart the step, with idempotency keys guarding effects. Show these cases in the inbox and never strand them silently.
4. **Operate it.** Give workers stable executor IDs and write a small supervisor that resumes `PENDING` workflows whose executor has gone. Run `DBOS.migrate()` before workers start. Alert on `PENDING` workflows of a version that no running worker serves.

---

## How to rerun

All commands run from this directory, `spikes/s1-s2-dbos/`, which is a standalone project outside the Bun workspaces.

```bash
bun install                 # installs @dbos-inc/dbos-sdk 5.3.0 (+ pg); uses this dir's bun.lock
./pg.sh start               # Postgres 16 on 127.0.0.1:54321, data in ./pgdata (as user postgres when root)

./s1-run.sh bun             # S1 under Bun   (~35 s)
./s1-run.sh node            # S1 under Node  (/opt/node22/bin/node)
DBOS_SYSTEM_DATABASE_URL=postgresql://postgres@127.0.0.1:54321/s1_deco bun s1-decorators.ts

./s2-run.sh bun             # S2 versions: A, B, hazard, drain, fork   (~45 s; also: node)
./s2-patch-run.sh bun       # S2 patch API                             (~25 s; also: node)

./pg.sh stop                # or ./pg.sh reset to wipe the cluster
```

Each script drops and recreates its own database (`s1_<rt>`, `s2_<rt>`, `s2p_<rt>`) and writes its ledgers and process logs to `out/`, which git ignores. Expected results: in S1, `reserve` and `charge` each show `START x1 END x1` and `ship` shows `START x2 END x1`. In S2, the final table matches the one above.

| File | Purpose |
|---|---|
| `pg.sh` | Start, stop or reset the throwaway cluster |
| `s1.mjs`, `s1-run.sh` | S1 workflow (`worker` / `send`) and the crash driver |
| `s1-decorators.ts`, `tsconfig.json` | Decorator API under Bun's TypeScript transpiler |
| `s2-harness.mjs` | Shared worker harness: version, executor ID, patching, ledger |
| `s2-def-a.mjs`, `s2-def-b.mjs`, `s2-def-b-patched.mjs` | The three definitions of `caseWorkflow` |
| `s2-admin.mjs` | `DBOSClient` operator actions: migrate, resume, cancel, fork, versions |
| `s2-run.sh`, `s2-patch-run.sh` | S2 drivers |
