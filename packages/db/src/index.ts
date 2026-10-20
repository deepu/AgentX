/**
 * @memwise/db: Postgres connections, migrations, the bundled cluster supervisor, test
 * databases, and the stores behind the kernel interfaces in `@memwise/defs` (contracts.ts).
 * See README.md and docs/memwise/18-kernel-interfaces.md.
 */

export { createPool, withTransaction, type PoolOptions, type Queryable } from './pool.ts';
export { migrate, MIGRATIONS_DIR, type MigrateOptions } from './migrate.ts';
export { defaultDataDir, startCluster, type Cluster, type ClusterOptions } from './cluster.ts';
export { embeddedBinaries, findBinaries, systemBinaries, type PgBinaries } from './binaries.ts';
export { createTestDatabase, postgresAvailable, type TestDatabase } from './testing.ts';
export { PgDefinitionStore } from './stores/definitions.ts';
export { PgEffectLedger } from './stores/ledger.ts';
export { PgStepRecorder, PgStepRecordReader } from './stores/steps.ts';
export { PgCaseStore, type CaseEvent, type NewCase } from './stores/cases.ts';
export { PgApprovalStore, type ApprovalRecord } from './stores/approvals.ts';
