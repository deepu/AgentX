# @memwise/gateway

The tool and effect gateway (effect classes, unclassified tools treated as `irreversible`, idempotency keys, secret injection, previews for `outbound`) and the thin model gateway (roles, budgets, a record of every call).

**Boundary.** May depend on `@memwise/defs` and `@memwise/policy`. It sits at the two existing chokepoints in `@memwise/shared` (the PreToolUse pipeline and the MCP client pool) and is called from them; it does not import the app.

**Status.** Empty skeleton (Phase 0). Filled in from Phase 1; see [the build plan](../../docs/memwise/17-build-plan.md).
