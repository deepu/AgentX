# @memwise/step-engine

The agent loop for workflow steps on `@earendil-works/pi-ai`, with every model call and tool call journaled as a DBOS step so a killed step resumes without repeating calls.

**Boundary.** May depend on `@memwise/defs` and `@memwise/gateway` (and `@memwise/policy` for types). Every tool call goes through the gateway; every model call through the model gateway.

## Use

```ts
configureStepEngine({ tools, models, recorder, records });   // once per process, before DBOS.launch()
const agentStep = registerAgentStep();                        // or register agentStepWorkflow yourself
await DBOS.launch();
const handle = await DBOS.startWorkflow(agentStep, { workflowID: input.stepRunId })(input);
const result: StepResult = await handle.getResult();
```

Nothing registers at import. The runtime registers `agentStepWorkflow` under `AGENT_STEP_WORKFLOW` (`memwise.step.agent`) itself, so it can deregister between kernels in tests.

## One step run

One DBOS workflow per step run; inside it, each unit is a DBOS step with a stable name:

| Step | What |
|---|---|
| `record.start` | the step record is opened |
| `context` | `assembleContext`: system prompt (preamble, strictness, instructions, the case fields read, earlier attempts, how to finish) and tools (the step's tools plus `step.finish`), hashed and recorded |
| `model:<turn>` | one model call through the model gateway, with the step's budget; retried up to 3 attempts. A budget stop ends the step as `needs_person` |
| `policy:<callId>` | the gateway's policy decision, journaled so it is replayed, never re-made |
| `approval.request:<callId>`, `approval.answer:<callId>` | an `approve` verdict: the request is recorded, the workflow hibernates on `DBOS.recv(approvalTopic(id))` for up to 7 days |
| `tool:<name>:<callId>` | the call through the tool gateway, idempotency key `${workflowID}:${stepID}` (D38). A quarantined tool taints the session |
| `checkpoint:<n>:structural` | `step.finish`: outcome declared, writes declared and typed, required writes and tools present, `from: tool` values equal to a tool result (which gives their provenance) |
| `verify:<n>` | one call for the verifier role (`checkpoint.verdict`) when the step has prose checkpoint rules |
| `record.finish` | the step record is closed |

A failed checkpoint goes back to the agent as the tool result, up to `maxRepairs` (2) times, then the step stops with `needs_person`. So does running out of turns (`modelCalls` budget, else `maxTurns`, 24).

Only an in-flight call can repeat after a crash (DBOS steps are at-least-once): a model call cut mid-way is sent again, and a tool call in flight runs again with the same idempotency key, which the ledger and provider dedupe.

`recallTools(reader)` gives `recall.step_record` and `recall.similar_cases`, ordinary `read` tools to bind in the tool gateway.

## Tests

`bun test` (needs Postgres; `MEMWISE_TEST_ADMIN_URL`, default `postgresql://postgres@127.0.0.1:54329/postgres`). Each file creates and drops its own DBOS system database. `tests/crash-resume.test.ts` kills a step run in a child process at the `MEMWISE_CRASH_AT` points and resumes it.
