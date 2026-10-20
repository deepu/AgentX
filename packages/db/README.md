# @memwise/db

Postgres for the MemWise kernel: connections, migrations, the bundled server on desktop, test databases, and the stores behind the kernel interfaces in `@memwise/defs` (`contracts.ts`). Later it also becomes the target the policy compiler emits row-level security (RLS) rules into.

**Boundary.** May depend on `@memwise/defs` only.

## What it provides

- **Connections.** `createPool(url, opts?)` returns a `pg.Pool`. `Queryable` is anything with `query` (a pool, a pooled client or a client), so stores can join a caller's transaction. `withTransaction(pool, fn)` runs `fn` in one transaction.
- **Migrations.** `migrate(pool)` applies `migrations/*.sql` in name order, each in its own transaction, and records them in `mw.schema_migrations` with a checksum. It holds a Postgres advisory lock, so parallel starts wait instead of colliding (D35). It refuses to run if an applied file has changed. Changes go in a new numbered file, never in an applied one. DBOS's own schema is migrated by DBOS, not here.
- **Bundled Postgres (D37, spike S3).** `startCluster({ dataDir, port?, binDir?, log? })` returns a `Cluster` with `port`, `url(db?)`, `createDatabase`, `dropDatabase`, `stop()`. The cluster:
  - runs `initdb` on an empty data dir (builtin C.UTF-8 locale on PG 17+, trust auth, superuser `postgres`), then `pg_ctl start -w` and a real connection check;
  - listens on 127.0.0.1, uses a private Unix socket folder, and picks a free port when none is given;
  - adopts a server that is already running, and clears a stale `postmaster.pid` after a crash.

  Binaries come from `binDir`, else `@embedded-postgres/<platform>`, else a system install. `defaultDataDir()` is `~/.memwise/postgres/data`.
- **Test databases.** `createTestDatabase(prefix?)` returns `{ url, pool, drop() }`: a fresh, migrated database. It uses `MEMWISE_TEST_DATABASE_URL` (an admin URL) when set; otherwise it uses one throwaway cluster per process, which is stopped and deleted when the process exits. `postgresAvailable()` lets suites skip cleanly when there is no Postgres.
- **Stores.**
  - `PgDefinitionStore`, `PgEffectLedger`, `PgStepRecorder` and `PgStepRecordReader` implement the `contracts.ts` interfaces.
  - `PgCaseStore` (`create`, `get`, `applyWrites`, `history`) takes the caller's connection. One write batch is one change event (`seq` + 1), with a `case_events` row per field.
  - `PgApprovalStore` (`get`, `pending`, `decide`): a decision lands only on a pending approval.

## Running as root

`initdb`, `pg_ctl` and `postgres` refuse to run as root. When the process is root, `startCluster` runs them as the `postgres` OS user through `runuser` and gives that user the data dir. The data dir's parent folders must be traversable by that user. This exists only for containers and CI that run tests as root; the desktop app never runs as root.

## Tests

`bun test` in this folder. The tests start their own embedded cluster, or use `MEMWISE_TEST_DATABASE_URL` when it is set. The cluster test always uses the embedded binaries.
