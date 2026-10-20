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

// ---------------------------------------------------------------- Phase 2 (docs/memwise/19-phase-2-interfaces.md)
export { withActor, setActor, actorSettings, actorLabel, APP_ROLE, type Actor } from './actor.ts';
export { ulid } from './ids.ts';
export {
  PgPeopleStore, newPersonId, hashPassword, checkPassword, sha256, type Person, type Role,
} from './stores/people.ts';
export { PgNotificationStore, type Notification, type NewNotification } from './stores/notifications.ts';
export { PgExplanationStore, type StoredExplanation, type ExplanationCite } from './stores/explanations.ts';
export { PgFileStore, type StoredFile } from './stores/files.ts';
export { PgChatAnchorStore, type ChatAnchor } from './stores/chat-anchors.ts';
export { PgRateCounter } from './stores/rates.ts';
export {
  applyDomainSchema, columnType, compileRls, domainCreators, domainToolNames, entityColumns, entityIdPrefix,
  entityTableName, snake, syncEntityTables, SYSTEM_COLUMNS, type ColumnType, type EntityColumn, type RlsOptions,
} from './domain/tables.ts';
export { PgEntityStore, type CreateEntityOptions, type StoredEntityRow } from './domain/entities.ts';
