# @memwise/defs

Definition formats (`workflow.yaml`, `steps/*.md`, `case.yaml`, entity types, `policy.yaml`), their JSON Schemas, the static checks, and the indexer that loads a project folder's definitions into Postgres.

**Boundary.** Depends on no other `@memwise/*` package. The indexer writes through a small store interface that `@memwise/db` implements, so formats and checks stay pure and usable from the CLI and the editor.

**Status.** Empty skeleton (Phase 0). Filled in from Phase 1; see [the build plan](../../docs/memwise/17-build-plan.md).
