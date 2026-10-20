# @memwise/policy

Policy layers (platform → plugin → domain → workflow → step, tighten only), the compiler that turns them into the effective policy a step runs under, and the effective-policy view with the origin of each rule.

**Boundary.** May depend on `@memwise/defs` only. Pure functions, no I/O. It produces rules; enforcing them is the gateway's and the database's job.

**API** (docs/memwise/18-kernel-interfaces.md):

- `PLATFORM_DEFAULTS`: read, draft and write allowed; outbound and irreversible need approval; taint on, outbound from a tainted session needs approval.
- `stepLayer(step, workflowId)`: the step's tool list (a step may call only what it lists), required tools, budget and model roles (its `model`, plus `VERIFIER_ROLE` (`verifier`) when it has prose checkpoint rules), merged with its `policy:` block (the stricter wins). The built-ins `step.finish` and `checkpoint.verdict` never need listing.
- `layersFor({ domainPolicy, plugins, workflow, step })`: the stack, top to bottom.
- `compilePolicy(layers)` → `{ effective, violations }`. A lower layer may only tighten (D30): treatments only rise, allow lists and model roles intersect, deny and require lists grow, budgets and rate limits only fall. An attempt to loosen is a `PolicyViolation` naming the rule it tried to loosen, and is ignored. Every effective rule carries the layer that set it; restating a rule keeps the upper origin, except a platform default, which the restating layer claims. Budgets set by the step layer apply to one step run; budgets set above it are run budgets (all step runs of the run together), also kept apart in `runBudgets` because a step that tightens a budget hides the run's in `budgets`.
- `decide(effective, request)` → `PolicyDecision`: deny for denied or unlisted tools, otherwise the strictest of the class treatment, the per-tool rule and (for outbound and irreversible calls from a tainted session) the taint treatment.
- `describePolicy(effective)`: the effective policy as text, each rule with its layer, e.g. `outbound: approve  (domain, domain/policy.yaml)`. Run budgets hidden by a step budget are shown as `run tokens` etc. Rate limits and money budgets are marked `(not enforced until Phase 2)`.
- `violationsToDiagnostics(violations)`: `policy-loosened` errors for `memwise check`.

Not here yet: rate-limit counting and money budgets (compiled and shown, enforced from Phase 2), RLS and column policies (Phase 2).
