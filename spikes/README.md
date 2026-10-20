# Phase 0 spikes

Throwaway prototypes that answer the five yes-or-no questions in [the build plan](../docs/memwise/17-build-plan.md#phase-0--rename-skeleton-and-spikes). Each folder is a standalone project outside the Bun workspaces (its own `package.json` and lockfile), with a `RESULT.md` that gives the verdict, the exact commands, the evidence and the caveats. The decisions they led to are D35–D39 in the [decision log](../docs/memwise/15-decisions.md).

| Spike | Verdict | Answer | Folder |
|---|---|---|---|
| S1 · DBOS under Bun | Pass | Steps, durable sleep, events and messages survive `kill -9` under Bun and Node alike; no Node workers needed | [s1-s2-dbos](s1-s2-dbos/RESULT.md) |
| S2 · DBOS versioning | Pass, with conditions | A run stays on the version it started on; drain with old-version workers or fork on purpose. Definition versions should be run inputs, with DBOS's version an explicit engine label | [s1-s2-dbos](s1-s2-dbos/RESULT.md) |
| S3 · Bundled Postgres | Pass on Linux; macOS and Windows from CI | Postgres 18 from `embedded-postgres`: ~0.9 s first init, ~140 ms warm start, 24 MB idle; minor upgrades in place; PGlite only as fallback | [s3-bundled-postgres](s3-bundled-postgres/RESULT.md) |
| S4 · Step loop on `pi-ai` | Pass (caching checked against a stand-in server) | Every model and tool call a DBOS step; a killed loop resumes without repeating finished calls and with byte-identical requests | [s4-pi-ai-step-loop](s4-pi-ai-step-loop/RESULT.md) |
| S5 · XState with DBOS | Pass | One driver workflow per run over a snapshot in our tables; every crash point and a 3-day timer hold across restarts | [s5-xstate-dbos](s5-xstate-dbos/RESULT.md) |

The spikes need a local Postgres (S1, S2, S4 and S5 start a throwaway cluster from the system's Postgres 16 binaries; S3 downloads its own). The S3 measurements also run on macOS, Windows and Linux in [`.github/workflows/spike-s3-postgres.yml`](../.github/workflows/spike-s3-postgres.yml).

This code is not part of MemWise and is not maintained; Phase 1 builds the real packages (`@memwise/runtime`, `@memwise/step-engine`, `@memwise/db`) from these results.
