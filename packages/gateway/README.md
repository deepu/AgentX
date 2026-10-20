# @memwise/gateway

The tool and effect gateway and the thin model gateway ([07 §2, §4, §5](../../docs/memwise/07-agent-runtime.md), [18](../../docs/memwise/18-kernel-interfaces.md)). Contract: `src/types.ts`.

**Boundary.** May depend on `@memwise/defs` and `@memwise/policy`. It does not import the app.

## Tools

- `createToolGateway({ tools, ledger, secrets })`:
  - `check(req, policy, { tainted })` resolves the effect class for the arguments, asks `decide()` from `@memwise/policy`, and builds a preview for `preview`/`approve` verdicts (the tool's own, or `"<tool> with <args>"`). Unknown tools are denied.
  - `execute(req, decision)` refuses denied calls, checks the arguments (required keys, top-level types), injects secrets into `ctx.secrets` and redacts their values from results and errors. Every class but `read` goes through the effect ledger by idempotency key: `done` returns the stored result (`replayed`), `pending` runs again only for `idempotent` tools and otherwise returns `unknown`, `failed` runs again. Crash points `after-tool-effect` and `after-ledger-complete`.
- `resolveEffect(tool, args)`: declared class or a function of the arguments; undeclared is `irreversible`, unclassified (D29).
- `effectFromAnnotations(a)`: a class seeded from MCP hints (destructive -> irreversible, read-only -> read, open-world -> outbound), a proposal a person confirms at binding. `@memwise/shared`'s MCP pool keeps an identical copy.
- `stubTools(tools, stubs)`: the same definitions with example-case results; `.calls` counts real runs.

## Models

- `createModelGateway({ roles, providers, sink })`: role -> provider and model, budget check before the call (`BudgetExceededError`), fallbacks in order, every attempt reported to the sink. A reply with `stopReason` `error`/`aborted` is a failure, so the DBOS step policy retries (D38).
- `piAiProvider({ id, apiKey?, baseUrl? })`: pi-ai with `anthropic` or `openai` (or any pi-ai `provider`), pi-ai retries off.
- `scriptedProvider(script)`: deterministic replies by role and turn, for example cases and tests.

## Open engine

`McpClientPool.setEffectJournal(journal)` in `@memwise/shared` records every MCP tool call with its annotation-seeded class. Off unless set.
