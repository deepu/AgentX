# @memwise/step-engine

The agent loop for workflow steps on `@earendil-works/pi-ai`, with every model call and tool call journaled as a DBOS step so a killed step resumes without repeating calls.

**Boundary.** May depend on `@memwise/defs` and `@memwise/gateway`. Every tool call goes through the gateway; every model call through the model gateway.

**Status.** Empty skeleton (Phase 0). Filled in from Phase 1 (design follows spike S4); see [the build plan](../../docs/memwise/17-build-plan.md).
