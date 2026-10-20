# S4 · Step loop on `pi-ai` — RESULT

**Verdict: PASS** (prompt caching checked by proxy only; see Caveats)

A loop on `@earendil-works/pi-ai` 1.1.0, with every model call, policy decision and tool call as a DBOS step (`@dbos-inc/dbos-sdk` 5.3.0, Postgres 16, run under Bun 1.4.2), was killed with `kill -9` at four points and resumed each time.
- **Steps that had completed were never repeated.** The fake server's request log and the tool side-effect log prove it.
- **Requests sent after a resume were byte-identical (sha256) to the uncrashed baseline**, on two catalog models.
- **The only repeat is the step that was in flight when the process died.** DBOS steps are at-least-once. A model call in flight is sent again: the request is identical and is billed twice. A tool call in flight runs again. The idempotency key makes its effect apply once.

The fallback (journal at the pool only) is not needed.

## What was built

```
src/fake-anthropic.ts  Anthropic Messages API stand-in: scripted SSE replies chosen by turn,
                       logs every request (raw body + sha256), simulates prompt-cache hits,
                       and a fake email service that dedups on Idempotency-Key
src/loop.ts            the step loop: DBOS workflow `agentStep`; steps: context, model:N,
                       policy:<callId>, tool:<name>:<callId>
src/tools.ts           the two chokepoints in miniature: preToolUse() and ToolPool
src/run.ts             start the workflow, or wait for DBOS recovery to finish it
scripts/scenario.sh    one scenario: fresh DB + fake server, run, kill -9, restart
scripts/check.ts       compares every scenario to the baseline; prefix-stability check
scripts/cancel.ts      DBOS cancel / resume from outside (DBOSClient)
scripts/run-all.sh     all scenarios x 2 models, then the checks
scripts/pg.sh          throwaway Postgres 16 cluster in data/pg on port 54324
```

The model is the real `anthropic` provider from pi-ai, using the catalog entry `claude-sonnet-4-5` (and `claude-opus-5-5` in the second pass), with only `baseUrl` changed to point at `127.0.0.1:54399`. So the real pi-ai `anthropic-messages` code path ran: the Anthropic SDK, cache-control placement and the SSE parser. pi-ai has a `fauxProvider()` too, but it is in-process: its state dies with `kill -9` and it builds no HTTP body. That makes it useless as crash evidence.

The scripted conversation has 4 model turns:
1. `lookup_customer`.
2. Two parallel calls: `extract_fields` and `check_credit`.
3. `send_email` (outbound, real effect) plus `wire_funds`. The policy denies `wire_funds` because it is irreversible.
4. A final text answer.

That gives 14 journaled steps per run.

## Exact commands

```bash
cd spikes/s4-pi-ai-step-loop
bun install
scripts/pg.sh start                 # initdb (as postgres) + start on 127.0.0.1:54324
bun run typecheck                   # tsc, clean
scripts/run-all.sh                  # 6 scenarios x 2 models (a few minutes), writes data/check*.txt
# or one at a time:
scripts/scenario.sh baseline
scripts/scenario.sh kill-between    # kill -9 after model:1 is checkpointed, before its tool steps
scripts/scenario.sh kill-after-tool # kill -9 after tool:send_email is checkpointed, before model:3
scripts/scenario.sh kill-in-tool    # kill -9 inside send_email, after the email was sent
scripts/scenario.sh kill-in-model   # kill -9 while model call (turn 2) is still streaming
scripts/scenario.sh cancel-in-model # DBOS cancel while turn 2 streams, then DBOS resume
SUFFIX=-opus MODEL_ID=claude-opus-5-5 scripts/scenario.sh kill-in-tool
bun scripts/check.ts                # SUFFIX=-opus bun scripts/check.ts for the second model
scripts/pg.sh stop
```

The between-steps kills use `PAUSE_MS=2000`, a sleep after each checkpointed step, to give the external `kill -9` a window. The in-tool kill uses `TOOL_SLOW_MS=4000` inside `send_email`, after the effect has been sent. The in-model kill uses `FAKE_SLOW_TURN=2`, which makes the server stream turn 2 over 6 s.

## Evidence

### Summary (both models: `OVERALL: OK`)

| Scenario | Model requests (baseline 4) | Repeats | Bodies == baseline | Tool runs (baseline 4) | Emails applied |
|---|---|---|---|---|---|
| kill-between | 4 | none | yes | 4 | 1 |
| kill-after-tool | 4 | none | yes | 4 | 1 |
| kill-in-tool | 4 | none | yes | 5 (send_email x2) | **1** (1 deduped) |
| kill-in-model | 5 | turn 2 x2 (the one in flight) | yes | 4 | 1 |
| cancel-in-model | 5 | turn 2 x2 (the one cancelled) | yes | 4 | 1 |

The same table holds for `claude-opus-5-5`. In every scenario the final answer equals the baseline's.

### Fake-server request log, before and after the kill

```
## kill-between            (kill -9 25443 after model:1 checkpoint; restart)
  10:46:48.806Z seq 1 turn 0 d41d2cdb553132ca     <- process 1
  10:46:54.856Z seq 2 turn 1 43d8c8fa7ca14bf6     <- process 1, then killed
  10:46:56.974Z seq 3 turn 2 521d59bad2c643fc     <- process 2: turns 0-1 NOT re-sent
  10:46:57.019Z seq 4 turn 3 4a783d71f46564dc
## kill-in-model           (kill -9 27317 while turn 2 was streaming; restart)
  10:47:31.057Z seq 1 turn 0 d41d2cdb553132ca
  10:47:31.092Z seq 2 turn 1 43d8c8fa7ca14bf6
  10:47:31.121Z seq 3 turn 2 521d59bad2c643fc     <- stream cut by the kill
  10:47:34.677Z seq 4 turn 2 521d59bad2c643fc     <- in-flight call re-sent, identical bytes
  10:47:40.746Z seq 5 turn 3 4a783d71f46564dc
baseline:  turn 0 d41d2cdb553132ca, turn 1 43d8c8fa7ca14bf6, turn 2 521d59bad2c643fc, turn 3 4a783d71f46564dc
```

### Which steps ran and which were replayed (`check.ts`, kill-in-tool)

```
pid 27135: executed [context, model:0, policy:toolu_t0_lookup, tool:lookup_customer:toolu_t0_lookup, model:1,
                     policy:toolu_t1_extract, tool:extract_fields:toolu_t1_extract, policy:toolu_t1_credit,
                     tool:check_credit:toolu_t1_credit, model:2, policy:toolu_t2_email]      <- killed in send_email
pid 27235: replayed [context, model:0, ... model:2, policy:toolu_t2_email]                    <- from the journal
pid 27235: executed [tool:send_email:toolu_t2_email, policy:toolu_t2_wire, model:3]
```

### The tool side-effect counter and the effect service (kill-in-tool)

```
tool-executions.jsonl
 pid 27135 start       send_email key=s4-invoice-intake:toolu_t2_email
 pid 27135 effect_sent send_email duplicate=false                    <- email sent, then kill -9
 pid 27235 start       send_email key=s4-invoice-intake:toolu_t2_email  <- step re-runs (at-least-once)
 pid 27235 effect_sent send_email duplicate=true                     <- provider dedups on the key
 pid 27235 end         send_email
effects.jsonl
 10:47:26.355Z key=s4-invoice-intake:toolu_t2_email applied=true
 10:47:28.451Z key=s4-invoice-intake:toolu_t2_email applied=false duplicate=true
```

### The DBOS journal (`dbos.operation_outputs`, kill-in-tool, after completion)

```
 function_id | function_name                        | out_bytes | serialization | ms
           0 | context                              |      1074 | js_superjson  |  8
           1 | model:0                              |       654 | js_superjson  | 66
           2 | policy:toolu_t0_lookup               |       124 | js_superjson  |  3
           3 | tool:lookup_customer:toolu_t0_lookup |       287 | js_superjson  | 11
           ...
           9 | model:2                              |       887 | js_superjson  |  9
          11 | tool:send_email:toolu_t2_email       |       253 | js_superjson  | 14
          13 | model:3                              |       607 | js_superjson  | 48
workflow_status: SUCCESS, recovery_attempts 2
```

A model step's journaled output is the whole pi-ai `AssistantMessage`: content blocks with `toolCall` id, name and arguments, `usage` including `cacheRead`, `cacheWrite` and cost, `stopReason`, `responseId`, `timestamp` and `durationMs`. All 14 steps of the uncrashed baseline took 186 ms of wall time against the local fake, so the per-step journaling cost is a few ms.

### Abort / cancel (cancel-in-model)

```
cancel.ts  cancel at 10:47:44.432Z
model-attempts  step 9 attempt 1  stopReason=aborted "The operation was aborted."  at 10:47:45.224Z   (~0.8 s, DBOS polls)
responses.jsonl seq 3 turn 2 completed=false "client went away mid-stream"
               no retry attempt after the cancel; after `resume`, model:2 re-ran once (seq 4), identical bytes
```

`DBOS.stepStatus.cancelSignal` and `timeoutSignal`, combined with `AbortSignal.any`, are passed to pi-ai as `signal`. The abort reaches the HTTP stream and closes the connection.

### Prompt caching

**Prefix stability across turns** (baseline, both models):

```
turn 0: 1 messages; cache_control at tools[4], system[0], messages[0].content[0]
turn 1: 3 messages; cache_control at tools[4], system[0], messages[2].content[0]
turn 2: 5 messages; cache_control at tools[4], system[0], messages[4].content[1]
turn 3: 7 messages; cache_control at tools[4], system[0], messages[6].content[1]
turn N -> N+1: tools identical=true, system identical=true, earlier messages are a prefix=true   (all N)
```

**The fake's cache simulation**, which uses Anthropic's breakpoint and lookback rules, reports `cache_read` = 330, 414 and 541 tokens on turns 1–3. On a resumed run it reports the same numbers. The re-sent in-flight call in kill-in-model got `read=541, write=0`, because its prefix had already been written by the cut request.

**What pi-ai exposes:**
- Stream options `cacheRetention: "none" | "short" | "long"` (`long` becomes `ttl: "1h"` when the model allows it) and `sessionId`. `sessionId` drives affinity headers or `prompt_cache_key` on providers that use one; it is not sent for direct Anthropic.
- `onPayload`, to inspect or record the exact body.
- `AssistantMessage.usage.{input, output, cacheRead, cacheWrite, cacheWrite1h, totalTokens, cost.{cacheRead, cacheWrite, total}}`. These were verified to be filled from `cache_read_input_tokens` and `cache_creation_input_tokens`.
- Per-model `promptCache` lifetimes (`{short: 300, long: 3600}`) in the catalog.

**Where the markers go.** pi-ai places Anthropic `cache_control` on:
- the system prompt,
- the last tool, and
- the last user, tool_result or system block.

That is the standard incremental pattern. The marker moves each turn, which does not change the cached prefix.

## Issues found (the four asked about, and others)

1. **Serializing pi-ai objects into step outputs works without any custom code.**
   - `AssistantMessage`, `ToolResultMessage` and TypeBox tool schemas are plain data. DBOS stores them with superjson.
   - Resumed requests rebuilt from deserialized messages hash identically to requests built from the in-memory originals.
   - TypeBox's non-enumerable `~kind` is lost on the round trip. `validateToolArguments` still works on the plain JSON schema (tested: it accepts and rejects the same arguments).
   - Watch: real `thinking` blocks carry `thinkingSignature` and redacted payloads, which must round-trip byte-exact. They are opaque strings, so this is expected to be fine, but it is not exercised here (see Caveats).
2. **Streaming inside a step.**
   - The stream is consumed inside the step, and only `await s.result()` is journaled.
   - Deltas can go to the UI live, but they are not durable. After a crash mid-stream the user may have seen partial text that the re-run regenerates. With a real model the second answer can differ. The UI must key live deltas by `(workflowID, stepID, attempt)` and drop an attempt's partial output when another attempt starts.
   - An `error` or `aborted` stopReason is turned into a throw, so the DBOS retry policy applies.
3. **Abort signals.**
   - DBOS gives each step `cancelSignal` (workflow cancel, polled, about 1 s) and `timeoutSignal` (with `timeoutMS`). Both are passed straight to pi-ai, and that works.
   - `kill -9` needs no signal. The server only sees the connection drop.
   - Set pi-ai `maxRetries: 0`. Otherwise pi-ai retries inside a step and DBOS retries around it, and the two layers multiply calls and hide them from the journal.
4. **Idempotency keys.**
   - The spike uses `${workflowID}:${toolCall.id}`. The tool call id is journaled inside the model step's output, so the key is stable across resumes.
   - Tool call ids come from the model, so uniqueness is the provider's word. Prefer `${workflowID}:${DBOS.stepID}`, which DBOS guarantees is unique and deterministic, and record the tool call id beside it.
   - A key only helps if the effect's provider dedups on it. Effects without provider support need a journaled "intent" row and reconciliation; a key alone does not protect them.
5. **The in-flight model call is paid for twice, and the first copy is invisible to metering.** The cut request never produced a step output, so the usage tracker will under-count. Record an attempt row when a model step starts (step id, attempt, request sha). Metering and the "what did it see" trace can then account for lost attempts.
6. **The workflow body must be deterministic.**
   - Every timestamp the model or the messages need is produced inside a step: tool results carry `timestamp` and `durationMs` from the tool step, and denial results use the policy step's `at`. The first user message uses a timestamp from the workflow input.
   - The system prompt and tool schemas are captured by a `context` step, so a redeploy between crash and resume cannot change the prefix. DBOS's application version (a hash of workflow code) also pins recovery, which is S2's subject.
7. **Policy decisions are their own steps.** A policy edit between crash and resume therefore cannot flip a decision already acted on. This costs about 2 ms and one row per tool call. A "needs approval" result should return to the workflow, which then waits with `DBOS.recv` (hibernates) before the tool step.
8. **Bun.** DBOS 5.3.0 ran and recovered under Bun 1.4.2 with no changes. `pg` printed a `DeprecationWarning` ("client.query() when the client is already executing a query"). It is harmless here, but S1 should note it.

## Where the chokepoints sit (hooks in the loop)

```
agentStep (DBOS workflow, one per step execution)
  context step              recorded context assembly (prompt, tool schemas, model ref)
  loop:
    model:N step            model gateway: role -> model, budget check, pi-ai stream consumed here,
                            AssistantMessage journaled (usage = metering record)
    for each toolCall:
      policy:<id> step      PreToolUse chokepoint: effect class, policy, taint, budget
                            deny -> error tool_result | needs approval -> DBOS.recv (hibernate)
      tool:<name>:<id> step tool pool chokepoint: arg validation, secret injection,
                            idempotency key, preview, on-behalf-of identity, effect journal
```

In the spike these are `preToolUse()` and `ToolPool.execute()` in `src/tools.ts`. In MemWise they should be the same functions the open engine reaches through `pre-tool-use.ts` and `mcp-pool.ts`. That way both engines share one gateway and differ only in who journals: the step engine journals each call as a DBOS step, and the open engine journals at the pool.

## Caveats (unproven without a real key)

- **Real cache hits are unproven.** What is shown: identical bytes, stable prefixes, markers in the expected places, and pi-ai mapping the usage fields. Real cache behaviour also depends on things a fake can't show: the cache's lifetime against the time between crash and resume (5 min short / 1 h long), the minimum cacheable length, and provider-side routing.
- **Only the Anthropic wire format is exercised.** It ran with two catalog models; `claude-opus-5-5` adds effort system messages, a deferred tool placeholder and adaptive thinking. OpenAI Responses (`prompt_cache_key` from `sessionId`), Google and Bedrock are untested. OpenRouter's session-affinity headers depend on `sessionId`, which is stable here because it is the workflow id.
- **No real thinking blocks or signatures, images or very large outputs** were journaled. DBOS stores step outputs as text, so large tool outputs should go to the object store and be journaled by reference.
- **The scripted model is deterministic.** A real model re-run after a mid-stream crash can answer differently. That is correct (nothing from the cut attempt was journaled), but the UI must handle it (Issue 2).
- **One worker on one executor (`local`).** Multi-worker recovery, application versions and queues are outside this spike (S1/S2).

## Recommendations for `@memwise/step-engine`

1. **Shape: one DBOS workflow per step execution, with four step kinds.**
   - **`context`**: recorded once.
   - **`model`**: stream consumed inside the step, final `AssistantMessage` journaled, `maxRetries: 0` in pi-ai, retries and timeout set by DBOS step config, signal from `stepStatus`.
   - **`policy`**: journaled decision.
   - **`tool`**: returns a complete `ToolResultMessage` with timestamps, so the workflow body has no clock.
2. **The message list is never stored separately.** It is a fold over step outputs, so replay rebuilds it. Persist a projection (step records and traces) for the UI, not as the source of truth.
3. **Idempotency key = `workflowID:stepID`**, passed to the pool. Effects whose provider can't dedup get a write-ahead intent row and reconciliation on resume, and count as `irreversible` until classified.
4. **Record model attempts before sending** (sha256 of the `onPayload` body, step id, attempt). This gives exact replay, cost accounting for lost attempts, and the cache-prefix check below as a cheap guard.
5. **Cache-prefix regression check in CI.** `check.ts`'s prefix-stability test (tools and system identical, messages append-only) should be a unit test on the context assembler. Anything that edits earlier messages, such as compaction or redaction, must be a deliberate, recorded event.
6. **Pin the pi-ai version and the model catalog entry per run.** Serialization changes in the provider adapter would change bytes, and with them cache hits, after an upgrade mid-run. Put the pi-ai version and model compat in the `context` step.
7. **Live deltas through a side channel** (DBOS streams or our event bus), keyed by step id and attempt. They are never journaled.
8. **Strict steps can use this engine as is.** The fallback (journal at the pool only) is still the right model for the open engine (Claude SDK, Pi subprocess).

Postgres was stopped after the runs (`scripts/pg.sh stop`). Logs from the last full run remain in `data/` (gitignored).
