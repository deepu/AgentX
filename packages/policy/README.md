# @memwise/policy

Policy layers (plugin → domain → workflow → step, tighten only), the compiler that turns them into gateway rules and RLS, and the effective-policy view with the origin of each rule.

**Boundary.** May depend on `@memwise/defs` only. It produces rules; enforcing them is the gateway's and the database's job.

**Status.** Empty skeleton (Phase 0). Filled in from Phase 1, extended in Phase 2; see [the build plan](../../docs/memwise/17-build-plan.md).
