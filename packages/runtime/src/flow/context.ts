// What the flow piece needs from the kernel, injected so each module stays small and testable.
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import { DEFAULT_DOMAIN, type DomainDef, type EntityTypeDef, type WorkflowDef } from '@memwise/defs';
import type pg from 'pg';
import { driverIdOf } from '../ids.ts';
import type { RunEvent } from '../machine.ts';
import type { Queryable } from '../runs.ts';
import type { Actor, DocumentValue, KernelChange, RecordWriteResult, StartRunInput } from '../types.ts';

export interface FlowDeps {
  pool: pg.Pool;
  client: DBOSClient;
  /** The live workflows: the indexed project's, else the latest indexed definitions. */
  workflows(): Promise<WorkflowDef[]>;
  /** Entity types by key. */
  entities(): Record<string, EntityTypeDef>;
  /** Domains by id (empty when the project has none). */
  domains(): Promise<Record<string, DomainDef>>;
  /** `workspace.yaml stormLimit` (default 25). */
  stormLimit(): Promise<number>;
  /** The kernel's startRun, as the kernel itself (any field may be set), with who its steps act for. */
  start(input: StartRunInput, opts?: { actsFor?: string }): Promise<{ runId: string; caseId: string }>;
  saveFile(input: { name: string; mime: string; data: Uint8Array }, actor: Actor): Promise<DocumentValue>;
  /** A condition on one record, as the system actor. */
  evaluate(entityKey: string, recordId: string, condition: string): Promise<{ holds: boolean; values: Record<string, unknown> }>;
  /** A lifecycle transition as the system actor (kernel.records.transition). */
  transition(input: { entity: string; id: string; transition: string; reason?: string }): Promise<RecordWriteResult>;
  emit(change: KernelChange): void;
  /**
   * Stage 3 (26 §3): whether a project runs this playbook (active, and not left out of it). A
   * record's trigger fires only in a project that does; absent, every project does.
   */
  projectRuns?(project: string, workflowId: string): Promise<boolean>;
  log?: (message: string) => void;
}

/** A domain's display name ("Main" for the default domain without one). */
export const domainName = (domains: Record<string, DomainDef>, id: string) =>
  domains[id]?.name ?? (id === DEFAULT_DOMAIN ? 'Main' : id);

/**
 * Send an event to a run's driver inside the caller's transaction, once per `idemKey` (the same
 * path as kernel.sendEvent, without the person checks: the kernel itself is sending).
 */
export async function sendInTx(db: Queryable, client: DBOSClient, runId: string, event: RunEvent, idemKey: string, forSeq?: number) {
  const ev: RunEvent = forSeq === undefined ? { ...event } : { ...event, for: forSeq };
  const ins = await db.query(
    `insert into mw.inbox (run_id, idem_key, event, for_seq) values ($1, $2, $3, $4) on conflict do nothing`,
    [runId, idemKey, JSON.stringify(ev), forSeq ?? null]);
  if (ins.rowCount) await client.sendInTransaction(db as pg.PoolClient, driverIdOf(runId), ev, 'events', `${runId}:${idemKey}`);
  return !!ins.rowCount;
}

/** A run id derived from a key, so a retried firing or hand-off finds the run it made before. */
export function derivedRunId(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return `run_${hash.slice(0, 26)}`;
}
