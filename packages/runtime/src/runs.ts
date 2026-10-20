// SQL over mw.runs, mw.transitions, mw.timers and mw.definitions (0001_kernel.sql). Every function
// takes the caller's connection so it can run inside the commit transaction.
import { DEFAULT_DOMAIN, type PolicyDoc, type ProjectDefs, type WorkflowDef } from '@memwise/defs';
import type { RunEvent } from './machine.ts';
import type { RunRecord, TimerRecord, TransitionRecord } from './types.ts';

export type { Queryable } from '@memwise/db';
import type { Queryable } from '@memwise/db';

/** What the driver keeps between iterations; plain JSON, because DBOS journals it. */
export interface RunRow {
  id: string;
  workflowId: string;
  workflowHash: string;
  caseId: string;
  state: string;
  status: RunRecord['status'];
  seq: number;
  enteredSeq: number;
  snapshot: { value: string; status: string; context: unknown };
  /** Pending timers, earliest first. */
  timers: { timerId: string; armedSeq: number; event: RunEvent; fireAtMs: number }[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function loadRunRow(db: Queryable, runId: string): Promise<RunRow> {
  const { rows } = await db.query(
    `select id, workflow_id, workflow_hash, case_id, state, status, seq, entered_seq, snapshot from mw.runs where id = $1`, [runId]);
  const r = rows[0];
  if (!r) throw new Error(`no run ${runId}`);
  const t = await db.query(
    `select timer_id, armed_seq, event, (extract(epoch from fire_at) * 1000)::bigint as fire_at_ms
       from mw.timers where run_id = $1 and status = 'pending' order by fire_at, timer_id`, [runId]);
  return {
    id: r.id, workflowId: r.workflow_id, workflowHash: r.workflow_hash, caseId: r.case_id, state: r.state,
    status: r.status, seq: r.seq, enteredSeq: r.entered_seq, snapshot: r.snapshot,
    timers: t.rows.map((x) => ({ timerId: x.timer_id, armedSeq: x.armed_seq, event: x.event, fireAtMs: Number(x.fire_at_ms) })),
  };
}

export async function getRunRecord(db: Queryable, runId: string): Promise<RunRecord | undefined> {
  const { rows } = await db.query(`select * from mw.runs where id = $1`, [runId]);
  const r = rows[0];
  if (!r) return undefined;
  const t = await db.query(
    `select timer_id, armed_seq, event, fire_at, status from mw.timers where run_id = $1 and status = 'pending' order by fire_at`, [runId]);
  return {
    id: r.id, workflowId: r.workflow_id, workflowVersion: r.workflow_version, workflowHash: r.workflow_hash,
    caseId: r.case_id, state: r.state, status: r.status, seq: r.seq, enteredSeq: r.entered_seq,
    ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
    timers: t.rows.map((x): TimerRecord => ({ timerId: x.timer_id, armedSeq: x.armed_seq, event: x.event, fireAt: iso(x.fire_at), status: x.status })),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export async function getTransitions(db: Queryable, runId: string): Promise<TransitionRecord[]> {
  const { rows } = await db.query(`select * from mw.transitions where run_id = $1 order by seq`, [runId]);
  return rows.map((r) => ({
    seq: r.seq, from: r.from_state, to: r.to_state, event: r.event, source: r.source, accepted: r.accepted,
    ...(r.note ? { note: r.note } : {}), ...(r.step_run_id ? { stepRunId: r.step_run_id } : {}), at: iso(r.at),
  }));
}

// ---------------------------------------------------------------- definitions

/** The run's pinned snapshot (D36). */
export async function loadWorkflowDef(db: Queryable, id: string, hash: string): Promise<WorkflowDef> {
  const { rows } = await db.query(`select body from mw.definitions where kind = 'workflow' and id = $1 and hash = $2`, [id, hash]);
  if (!rows[0]) throw new Error(`workflow ${id}@${hash} is not indexed`);
  return rows[0].body;
}

export async function latestWorkflowDef(db: Queryable, id: string): Promise<WorkflowDef | undefined> {
  const { rows } = await db.query(
    `select body from mw.definitions where kind = 'workflow' and id = $1 order by indexed_at desc limit 1`, [id]);
  return rows[0]?.body;
}

/** The domain policy layer is not part of the workflow snapshot; the latest indexed one applies. */
export async function loadDomainPolicy(db: Queryable): Promise<PolicyDoc | undefined> {
  const { rows } = await db.query(
    `select body from mw.definitions where kind = 'policy' and id = 'domain' order by indexed_at desc limit 1`);
  return rows[0]?.body;
}

/**
 * Phase 6 (24 §2): the workspace house rules and every domain's policy, as one row written at
 * index (like the plugin layers), read at run time: a workflow runs under the workspace layer and
 * its own domain's layer as they are now, not as they were when its snapshot was taken.
 */
export const DOMAIN_POLICIES_KIND = 'domain_policies';

export interface PolicySources {
  workspace?: PolicyDoc;
  /** Domain id -> its `policy.yaml`. */
  domains: Record<string, PolicyDoc>;
}

/** The row `kernel.index()` writes, from the loaded project. */
export function policySourcesOf(project: Pick<ProjectDefs, 'workspace' | 'domains' | 'domainPolicy'>): PolicySources {
  const domains: Record<string, PolicyDoc> = {};
  for (const [id, d] of Object.entries(project.domains ?? {})) if (d.policy) domains[id] = d.policy;
  if (project.domainPolicy && !domains[DEFAULT_DOMAIN]) domains[DEFAULT_DOMAIN] = project.domainPolicy;
  return { ...(project.workspace?.policy ? { workspace: project.workspace.policy } : {}), domains };
}

/** The policy sources as last indexed; a database indexed before Phase 6 has only the default domain's. */
export async function loadPolicySources(db: Queryable): Promise<PolicySources> {
  const { rows } = await db.query(
    `select body from mw.definitions where kind = $1 and id = 'workspace' order by indexed_at desc limit 1`, [DOMAIN_POLICIES_KIND]);
  if (rows[0]) return rows[0].body as PolicySources;
  const domain = await loadDomainPolicy(db);
  return { domains: domain ? { [DEFAULT_DOMAIN]: domain } : {} };
}

/** The workspace and domain layers for a workflow of `domain` (`layersFor`'s inputs). */
export function policyLayersFor(sources: PolicySources, domain: string = DEFAULT_DOMAIN): { workspacePolicy?: PolicyDoc; domainPolicy?: PolicyDoc } {
  const domainPolicy = sources.domains[domain];
  return { ...(sources.workspace ? { workspacePolicy: sources.workspace } : {}), ...(domainPolicy ? { domainPolicy } : {}) };
}

/** The workspace and domain layers of a workflow of a loaded project (checks, drafts). */
export const projectPolicyLayers = (project: Pick<ProjectDefs, 'workspace' | 'domains' | 'domainPolicy'>, workflow: Pick<WorkflowDef, 'domain'>) =>
  policyLayersFor(policySourcesOf(project), workflow.domain ?? DEFAULT_DOMAIN);

/** Definition kind of the bound plugins' policy layers (one row for the whole set, written at index). */
export const PLUGIN_POLICIES_KIND = 'plugin_policies';

/**
 * The plugin layers' sources as last indexed (22 §3): like the domain policy, not part of the
 * workflow snapshot; the bindings live now apply.
 */
export async function loadPluginPolicies(db: Queryable): Promise<import('@memwise/policy').PluginPolicy[]> {
  const { rows } = await db.query(
    `select body from mw.definitions where kind = $1 and id = 'domain' order by indexed_at desc limit 1`, [PLUGIN_POLICIES_KIND]);
  return rows[0]?.body ?? [];
}
