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
  PgPeopleStore, newPersonId, hashPassword, checkPassword, sha256, AUTH_FAILURE_WINDOW_MS, type Person, type Role, type AuthEventKind,
} from './stores/people.ts';
export { PgNotificationStore, type Notification, type NewNotification } from './stores/notifications.ts';
export { PgExplanationStore, type StoredExplanation, type ExplanationCite } from './stores/explanations.ts';
export { PgFileStore, type StoredFile } from './stores/files.ts';
export { PgChatAnchorStore, recordAnchorId, parseRecordAnchorId, type ChatAnchor, type ChatAnchorKind } from './stores/chat-anchors.ts';
export { PgRateCounter } from './stores/rates.ts';
export {
  applyDomainSchema, columnType, compileRls, domainCreators, domainToolNames, entityColumns, entityIdPrefix,
  entityTableName, snake, syncEntityTables, SYSTEM_COLUMNS, type ColumnType, type EntityColumn, type RlsOptions,
} from './domain/tables.ts';
export { PgEntityStore, type CreateEntityOptions, type StoredEntityRow } from './domain/entities.ts';

// ---------------------------------------------------------------- Phase 3 (docs/memwise/20-phase-3-interfaces.md)
export { PgVersionStore, type VersionRow, type NewVersion } from './stores/versions.ts';

// ---------------------------------------------------------------- Phase 4 (docs/memwise/22-phase-4-interfaces.md)
export {
  PgPluginStore, PgBindingVersionStore, PgIdentityStore, type PluginRow, type BindingVersionRow, type NewIdentityLink,
  type NewIdentityCandidate,
} from './stores/plugins.ts';

// ---------------------------------------------------------------- Phase 6 (docs/memwise/24-phase-6-interfaces.md)
export {
  RECORD_COLUMNS, tableOf, viewOf, domainUpdaters, type DomainSchemaOptions, type EntityRef,
} from './domain/tables.ts';
// Literature (docs/memwise/25-literature-poc.md §3): keyed records.
export { keyColumns, keyIndexName } from './domain/tables.ts';
export {
  withRecordContext, RecordWriteError, type RecordContext, type RecordWriteErrorCode, type EntityQuery, type EntityQueryResult,
  type EntityAggregate,
} from './domain/entities.ts';
export {
  compileCondition, compileConditionSource, conditionType, evaluateCondition, ConditionCompileError, bindTo, literal,
  type ConditionContext, type ConditionType,
} from './conditions.ts';
export {
  recordColumns, inverseOf, targetOf, linkPairing, linkColumn, conditionTypeOf, type RecordColumn,
} from './domain/model.ts';
export { compileReadViews, compileRecordTriggers, scopePredicate, viewContext, ROLLUP_EVENT_DEPTH } from './domain/records-sql.ts';
export {
  PgRecordVersions, PgSignatureStore, PgEntityEvents, contentHash, canonicalJson, type RecordVersionRow, type ChainCheck,
  type NewSignature, type SignatureRow,
} from './stores/records.ts';
export { PgGrantStore } from './stores/grants.ts';
export {
  PgNoteStore, PgMentionStore, mentionTokens, type RecordNote, type NewMention, type MentionRow, type MentionSourceKind,
} from './stores/notes.ts';
export { PgFlagStore, type FlagRow } from './stores/flags.ts';
export { PgViewStore, PgPageStore, type WrittenPage, type WrittenPageVersion } from './stores/pages.ts';

// ---------------------------------------------------------------- Stage 5: regulated projects (docs/memwise/26-projects-and-pages.md §8)
export {
  PgChangeRequestStore, PgAuditLog, PgInspectorStore, auditEntryHash, checkAuditChain, changeRequestLabel,
  type ChangeRequestRow, type ChangeRequestStatus, type ChangeValidationRow, type NewAuditEntry, type AuditEntryRow, type AuditFilter,
  type AuditActorKind, type AuditChainCheck, type InspectorLinkRow, type InspectorQuestionRow, type InspectorPerson,
} from './stores/regulated.ts';
