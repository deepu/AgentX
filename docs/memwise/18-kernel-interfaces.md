# 18 · Kernel interfaces (Phase 1)

The agreed boundaries the Phase 1 kernel is built against ([17](17-build-plan.md), Phase 1). The five pieces (formats and checks, Postgres, the step engine, the gateways, the policy compiler) and the run engine are built in parallel against these and joined at the end. The type contracts are code:

| Contract | File |
|---|---|
| Definition model (what files parse into) | `packages/defs/src/types.ts` |
| Kernel records and store interfaces | `packages/defs/src/contracts.ts` |
| Crash points for crash-and-resume tests | `packages/defs/src/testing.ts` |
| Policy layers, effective policy, decisions | `packages/policy/src/types.ts` |
| Tool and model gateways | `packages/gateway/src/types.ts` |
| Step runs | `packages/step-engine/src/types.ts` |
| Tables | `packages/db/migrations/0001_kernel.sql` |
| Sample project (intake) | `examples/intake/` |

Contracts change only additively (new optional fields). Dependencies run one way: `defs` ← `policy` ← `gateway` ← `step-engine` ← `runtime`, and `db` depends on `defs` only. `db` implements the store interfaces from `contracts.ts`; `runtime` wires everything.

## How a step runs

```
runtime: run driver (one DBOS workflow per run, D39)
  state has a step file and performer agent
    → policy: layersFor(domain, workflow, step) → compilePolicy → EffectivePolicy
    → step-engine: runAgentStep(StepRunInput) as DBOS workflow `${runId}/${enteredSeq}/${state}`
         journaled: context → [model → (policy check → [approval wait] → tool)*]* → checkpoint
         every model call through ModelGateway, every tool call through ToolGateway
         StepRecorder writes the step record as it goes
    → StepResult { outcome, writes, checkpoint }
  commit in one transaction: case writes with provenance, XState transition, timers
```

## Functions each package provides

### `@memwise/defs`
- `parseValueType(src)`, `parseDuration(src)`: `"List<Flag>"` → `ValueType`; `"3d"` → ms; `"40k"` tokens → 40000 via `parseCount`.
- `loadProject(root)` → `{ project: ProjectDefs, diagnostics }`. Content errors are diagnostics with file and line, never throws.
- `loadWorkflow(dir, projectRoot)`, and per-file parsers `parseWorkflowFile`, `parseStepFile`, `parseCaseFile`, `parseEntityFile`, `parsePolicyFile`, `parseExampleFile`.
- `checkWorkflow(workflow, env)`, `checkProject(project, env)` → `Diagnostic[]`: the checks in [05 §8](05-workflows.md) except policy tightening (the policy package) and example cases (`memwise test`).
- `validateValue(type, value, recordTypes)` → error strings; `valueTypeToJsonSchema(type, recordTypes)`.
- `jsonSchemas` (workflow, step front matter, case, entity, policy, example) and the generated files in `packages/defs/schemas/`.
- `indexProject(project, store: DefinitionStore)`: definitions plus references (tools, model roles, case fields, policies) for impact analysis.

### `@memwise/db`
- `createPool(url)`, `migrate(pool)`: numbered files in `packages/db/migrations`, under an advisory lock, recorded in `mw.schema_migrations`.
- `startCluster({ dataDir, port?, binDir? })` → `{ url(db?), createDatabase(name), stop() }`: the `pg_ctl` supervisor from S3 (D37), embedded-postgres binaries by default, polling for a real connection after start.
- `createTestDatabase()` → `{ url, pool, drop() }`: a fresh database per test, on `MEMWISE_TEST_DATABASE_URL` when set, else on a throwaway cluster shared by the process.
- Stores: `PgDefinitionStore`, `PgEffectLedger`, `PgStepRecorder`, `PgStepRecordReader` (the interfaces in `contracts.ts`), `PgCaseStore` (`create`, `get`, `applyWrites(db, caseId, writes, stepRunId)` inside the caller's transaction), `PgApprovalStore` (`get`, `decide`, `pending`).

### `@memwise/policy`
- `PLATFORM_DEFAULTS`: read, draft and write allowed; outbound and irreversible need approval; taint on, outbound from a tainted session needs approval.
- `stepLayer(step, workflowId)`, `layersFor({ domainPolicy, plugins, workflow, step })` → `PolicyLayer[]`.
- `compilePolicy(layers)` → `{ effective, violations }`: tighten only (D30).
- `decide(effective, request)` → `PolicyDecision`: pure; the strictest applicable rule wins.
- `describePolicy(effective)`: the effective-policy view as text, each rule with its layer.

### `@memwise/gateway`
- `createToolGateway({ tools, ledger, secrets })` → `ToolGateway`; `resolveEffect(tool, args)`; `effectFromAnnotations(annotations)`.
- `createModelGateway({ roles, providers, sink })` → `ModelGateway`.
- Providers: `piAiProvider({ id, apiKey?, baseUrl? })` (real, pi-ai), `scriptedProvider(script)` (deterministic, for example cases and tests).
- `stubTools(tools, stubs)`: same definitions, execution replaced by example-case results.
- The open engine's chokepoints in `@memwise/shared` (`mcp-pool.ts`, `pre-tool-use.ts`) classify MCP tools by effect class and accept an optional effect journal; off unless configured.

### `@memwise/step-engine`
- `configureStepEngine(deps)`, then `runAgentStep(input)`: a DBOS workflow named `memwise.step.agent`.
- Built-in tools: `step.finish` (outcome, writes, rationale; schema generated from the step's writes and outcomes) and, for the verifier role, `checkpoint.verdict`.
- `recallTools(reader)`: `recall.step_record`, `recall.similar_cases` (ordinary `read` tools).

### `@memwise/runtime`
- `createKernel(options)` → `Kernel`: `index()`, `startRun()`, `sendEvent()`, `decideApproval()`, `waitForRun()`, `getRun()`, `getCase()`, `getStepRecord()`, `shutdown()`.
- `compileMachine(workflow)`: `workflow.yaml` to an XState v5 machine.
- The `memwise` CLI: `memwise check <project>`, `memwise test <project>`, `memwise record <step-run-id>`.

## Conventions

- **Ids.** Run `run_<ulid>`; case `case_<ulid>`; step run `${runId}/${enteredSeq}/${state}` (also its DBOS workflow id); approval `${stepRunId}:${callId}`; idempotency key `${stepRunId}:${dbosStepId}` (D38).
- **Tool names** are dotted (`gst.validate_gstin`); the model sees `gst__validate_gstin`.
- **Outcomes `needs_person` and `failed`** go to the state's transition of that name when the shape has one; otherwise the run stops and needs a person.
- **States without a step file** wait for an outside event (`sendEvent`). Person and external steps also wait; their forms and inbox items come in Phase 2. System (mechanical) steps run in Phase 2.
- **Crash points**: `MEMWISE_CRASH_AT=<point>[@<detail>]`, listed in `packages/defs/src/testing.ts`.
