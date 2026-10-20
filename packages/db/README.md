# @memwise/db

Postgres for the MemWise kernel: connections, migrations, the bundled server on desktop, test databases, and the stores behind the kernel interfaces in `@memwise/defs` (`contracts.ts`). It also holds the actors, people and the generated domain tables with their row-level security (RLS) rules (Phase 2).

**Boundary.** May depend on `@memwise/defs` only.

## What it provides

- **Connections.** `createPool(url, opts?)` returns a `pg.Pool`. `Queryable` is anything with `query` (a pool, a pooled client or a client), so stores can join a caller's transaction. `withTransaction(pool, fn)` runs `fn` in one transaction.
- **Migrations.** `migrate(pool)` applies `migrations/*.sql` in name order, each in its own transaction, and records them in `mw.schema_migrations` with a checksum. It holds a Postgres advisory lock, so parallel starts wait instead of colliding (D35). It refuses to run if an applied file has changed. `MEMWISE_MIGRATIONS_DIR` overrides the folder (bundles without `import.meta.url`). Changes go in a new numbered file, never in an applied one. DBOS's own schema is migrated by DBOS, not here.
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
- **Actors (19 §2).** `withActor(pool, actor, fn)` runs `fn` in a transaction; a person or step token switches to the NOLOGIN role `memwise_app` and sets `mw.actor_kind`, `mw.person`, `mw.roles`, `mw.step_token` (transaction-local), which the RLS policies read through `mw.actor_kind()`, `mw.actor_person()`, `mw.actor_has_role(r)`, `mw.token_case()`, `mw.token_step_run()`. The system actor stays the owner and is not subject to RLS. Migration 0002 creates the role (guarded, it is cluster-wide) and its grants; the app role never sees password hashes or tokens.
- **Phase 2 stores.** `PgPeopleStore` (people, roles, scrypt passwords, sha256-stored tokens; implements runtime's `PeopleService`), `PgNotificationStore`, `PgExplanationStore`, `PgFileStore(dir)` (content-addressed bytes, metadata in `mw.files`), `PgChatAnchorStore`, `PgRateCounter` (implements the gateway's `RateCounter`).
- **Domain tables (19 §3).** `applyDomainSchema(pool, entities, { creators? })` = `syncEntityTables` (schema `domain`, additive only) + `compileRls` (idempotent SQL): kernel tables are per-case for step tokens; domain tables are readable by people and steps, insertable by people and by step tokens for rows stamped with their own step run (and, with `creators` from `domainCreators`, only from steps allowed `domain.<entity>.create`). Fields with `access: [roles]` are not selectable on the table by the app role; `domain_read.<table>` (security-barrier view) nulls them per actor and lists them in `_hidden`. `PgEntityStore` (`create`, `get`, `list`) writes the table and reads the view.
- **Domains and records (Phase 6, 24 §3–§9, §16).**
  - **Names.** Tables are `domain.<domain>__<entity>` (`etmf__site`, `domain__customer`); `entityTableName(def | key)`, `domainToolNames(def | key)` (`<domain>.<entity>.create|get|update|transition|list`). `applyDomainSchema(pool, entities, { creators?, updaters?, domains? })` renames a Phase 2–5 `domain.<entity>` once (same transaction), adds `version` and `updated_by` (a field named `version` is stored in `fld_version`), and gives rows written before Phase 6 their first version ("recorded before version history").
  - **Row trigger** (one plpgsql function per table, owner's rights): server time and `version` are the database's; every insert and real change writes `mw.record_versions` (who from the actor or `mw.by`, via, reason, the row by field name, changed fields, `hash = sha256(prev_hash ‖ canonical JSON)`) and `mw.entity_events` (`created`, `changed`, `entered`, and `changed` for parents whose rollups the write affects, up to 5 levels), then notifies `{kind:'entity'}` and `{kind:'records', entity, recordId}`. In a regulated domain a person's change to a controlled field without `mw.reason` is refused (SQLSTATE `MW001`, `reason-required:`). `withRecordContext(db, { reason, via, transition, by })` sets the context.
  - **History is append-only**: the app role may only read versions and events; a trigger refuses update and delete for every role (signatures, notes and page versions too). `PgRecordVersions.verifyChain` recomputes the chain in Postgres and names the first broken version. `contentHash` (sha256 of sorted-key JSON) is what a signature covers.
  - **Read views** add calculated fields (rollups as subqueries over the related entity's view; row formulas) and fields followed through `mw.identity_links` (`plugin = 'domain:<other>'`) from the other domain's view, plus `_link__<table>` with the paired id. Field access uses `mw.actor_has_role_in(role, domain)` (a workspace-wide role or a grant in the domain).
  - **Grants and record scope.** `mw.grants` (`PgGrantStore`, `PgPeopleStore.actorFor` includes them; `setActor` passes them as `mw.grants`). A person whose grants in a domain are all scoped sees and writes only rows whose Ref column named by the scope (or, on the scoped entity itself, its id) holds one of the ids; other tables aren't filtered.
  - **Conditions** (`conditions.ts`): `compileCondition(ast, ctx)` to SQL with `$n` parameters (or quoted literals in views), `evaluateCondition` on one record. `PgEntityStore` gains `update` (`expectedVersion`), `transition`, `query` (filter, sort, group, columns, paging, total) and `aggregate` (count, sum, avg, percent); refusals are `RecordWriteError` with a code.
  - **Stores**: `PgSignatureStore`, `PgEntityEvents`, `PgNoteStore`, `PgMentionStore`, `PgFlagStore`, `PgViewStore`, `PgPageStore`; `PgPeopleStore.recordAuthEvent` / `lockState` / `setLockedUntil` (the kernel decides the lock policy).
- **Change notifications.** Triggers send `NOTIFY mw_changes` with `{kind:'run', runId, caseId, workflowId}` or `{kind:'inbox'}`.

## Running as root

`initdb`, `pg_ctl` and `postgres` refuse to run as root. When the process is root, `startCluster` runs them as the `postgres` OS user through `runuser` and gives that user the data dir. The data dir's parent folders must be traversable by that user. This exists only for containers and CI that run tests as root; the desktop app never runs as root.

## Tests

`bun test` in this folder. The tests start their own embedded cluster, or use `MEMWISE_TEST_DATABASE_URL` when it is set. The cluster test always uses the embedded binaries.
