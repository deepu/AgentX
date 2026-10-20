# @memwise/step-engine

The agent loop for workflow steps on `@earendil-works/pi-ai`, with every model call and tool call journaled as a DBOS step so a killed step resumes without repeating calls.

**Boundary.** May depend on `@memwise/defs` and `@memwise/gateway` (and `@memwise/policy` for types). Every tool call goes through the gateway; every model call through the model gateway.

## Use

```ts
configureStepEngine({ tools, models, recorder, records });   // once per process, before DBOS.launch()
const agentStep = registerAgentStep();                        // standalone only; a kernel registers agentStepWorkflow itself
await DBOS.launch();
const handle = await DBOS.startWorkflow(agentStep, { workflowID: input.stepRunId })(input);
const result: StepResult = await handle.getResult();
```

Nothing registers at import. `registerAgentStep()` and `runAgentStep()` are for using the step engine standalone (tests, scripts); inside a kernel process the runtime registers `agentStepWorkflow` under `AGENT_STEP_WORKFLOW` (`memwise.step.agent`) itself, so it can deregister between kernels in tests.

## One step run

One DBOS workflow per step run; inside it, each unit is a DBOS step with a stable name:

| Step | What |
|---|---|
| `record.start` | the step record is opened |
| `context` | `assembleContext`: system prompt (preamble, strictness, instructions, the case fields read, earlier attempts, how to finish) and tools (the step's tools plus `step.finish`), hashed and recorded |
| `model:<turn>` | one model call through the model gateway; retried up to 3 attempts. Each attempt is recorded as `model:<turn>#<attempt>` before it is sent (and `…#<attempt>:failed` when it fails), so a kill mid-request leaves a trace. Before the call: a role the policy's `modelRoles` does not permit, or a spent budget, ends the step as `needs_person` |
| `policy:<callId>` | the gateway's policy decision, journaled so it is replayed, never re-made |
| `approval.request:<callId>`, `approval.answer:<callId>` | an `approve` verdict: the request is recorded, the workflow hibernates on `DBOS.recv(approvalTopic(id))` for up to 7 days (`approvalTimeoutSeconds`). With no answer the request is journaled as `approval.expired:<callId>` and the step stops with `needs_person` |
| `tool:<name>:<callId>` | the call through the tool gateway, idempotency key `${workflowID}:${stepID}` (D38). A quarantined tool taints the session |
| `checkpoint:<n>:structural` | `step.finish`: outcome declared, writes declared and typed, required writes and tools present, `from: tool` values equal to a tool result (which gives their provenance) |
| `verify:<n>` | one call for the verifier role (`verifierRole`, default `verifier`, which the step layer permits) (`checkpoint.verdict`) when the step has prose checkpoint rules; recorded like a model call, then `checkpoint:<n>:verifier` |
| `journal:<key>` | after each model, verifier and tool call: its entry in the step record, retried on its own (4 attempts). The record never decides whether a call succeeded (DBOS's journal is what a replay reads): a recorder error can't send a model call again or fail a step whose effect is done, and a write that keeps failing is logged and left out |
| `record.finish` | the step record is closed |

A failed checkpoint goes back to the agent as the tool result, up to `maxRepairs` (2) times, then the step stops with `needs_person`. So does running out of turns (`modelCalls` budget, else `maxTurns`, 24).

**Budgets.** Budgets set by the step layer (`stepBudget(input)`) apply to this step run alone; budgets set above it (`runBudget(input)`, from the policy's `runBudgets`) apply to the run: `input.runSpent` plus this step run. Verifier calls count tokens and time but not model calls, so a step that finishes on its last turn is still verified. Time counts model and tool time only, not approval waits. Money budgets and rate limits are not enforced in Phase 1.

**`from: tool` writes.** The value must equal a value in a result of that tool: at `field` when the write names one, else anywhere in it. A boolean or number without `field` must be the whole result or the result's top-level key named like the write, since a bare `true` would match almost any result.

Only an in-flight call can repeat after a crash (DBOS steps are at-least-once): a model call cut mid-way is sent again, and a tool call in flight runs again with the same idempotency key, which the ledger and provider dedupe.

`recallTools(reader)` gives `recall.step_record` and `recall.similar_cases`, ordinary `read` tools to bind in the tool gateway.

## Tests

`bun test` (needs Postgres; `MEMWISE_TEST_ADMIN_URL`, default `postgresql://postgres@127.0.0.1:54329/postgres`). Each file creates and drops its own DBOS system database. `tests/crash-resume.test.ts` kills a step run in a child process at the `MEMWISE_CRASH_AT` points and resumes it.
