// What people see (19 §4, §8): the inbox, the case list, a case with its values (hidden fields
// nulled for roles that lack access), timeline and path, and live counts for the map.
import { PgNotificationStore } from '@memwise/db';
import { DEFAULT_DOMAIN, domainOf, END_STATE, hasRole, type ApprovalRequest, type CaseValue, type EntityTypeDef, type FieldDef, type WorkflowDef } from '@memwise/defs';
import { compilePolicy, layersFor, pluginLayers, type CompiledPolicy, type PluginPolicy } from '@memwise/policy';
import type pg from 'pg';
import { assigneeOf } from './driver.ts';
import { REMIND_EVENT, stateKind } from './machine.ts';
import { heldWords } from './flow/describe.ts';
import { inboxReview } from './records/review.ts';
import { getTransitions, latestWorkflowDef, loadPluginPolicies, loadPolicySources, loadWorkflowDef, policyLayersFor, type PolicySources } from './runs.ts';
import type {
  Actor, CaseLinkView, CaseSummary, CaseView, InboxItem, LiveCounts, RunStatus, StepRunSummary, TransitionRecord, WaitingCondition,
} from './types.ts';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** Definitions by exact hash (immutable), and policies compiled from them. */
export class DefinitionCache {
  private workflows = new Map<string, WorkflowDef>();
  constructor(private readonly pool: pg.Pool) {}

  async workflow(id: string, hash: string): Promise<WorkflowDef> {
    const key = `${id}@${hash}`;
    let wf = this.workflows.get(key);
    if (!wf) { wf = await loadWorkflowDef(this.pool, id, hash); this.workflows.set(key, wf); }
    return wf;
  }

  latest(id: string): Promise<WorkflowDef | undefined> {
    return latestWorkflowDef(this.pool, id);
  }

  /**
   * The step's effective policy under the latest workspace, domain and plugin layers (what a step
   * run now would get). The domain layer is the workflow's own domain's (Phase 6, 24 §2).
   */
  async policy(workflow: WorkflowDef, stepId?: string, sources?: PolicySources, pluginPolicies?: PluginPolicy[]): Promise<CompiledPolicy> {
    const layers = policyLayersFor(sources ?? (await loadPolicySources(this.pool)), domainOf(workflow));
    const step = stepId ? workflow.steps[stepId] : undefined;
    const plugins = pluginLayers(pluginPolicies ?? (await loadPluginPolicies(this.pool)), workflow, step);
    return compilePolicy(layersFor({ ...layers, plugins, workflow, step }));
  }
}

export const isPerson = (a: Actor): a is Extract<Actor, { kind: 'person' }> => a.kind === 'person';
/**
 * The system actor sees everything; a person sees a restricted field only with one of its roles,
 * held workspace-wide or granted in the field's domain (Phase 6, 24 §2).
 */
export const maySee = (actor: Actor, field: FieldDef | undefined, domain: string = DEFAULT_DOMAIN) =>
  actor.kind === 'system' || !field?.access?.length || (isPerson(actor) && field.access.some((r) => hasRole(actor, r, domain)));

/** Every role the person holds anywhere: workspace-wide and granted in any domain (a prefilter; check per domain). */
export const anyRoles = (actor: Extract<Actor, { kind: 'person' }>): string[] =>
  [...new Set([...actor.roles, ...(actor.grants ?? []).map((g) => g.role)])];

/**
 * Roles that may decide an effect approval of this step: the policy's `approvals.by`, else the
 * step's assignee, else the workflow owner. Undefined: any signed-in person.
 */
export function approverRoles(policy: CompiledPolicy, workflow: WorkflowDef, stepId: string): string[] | undefined {
  const by = policy.effective.approvers?.value;
  if (by) return by;
  const assignee = workflow.steps[stepId]?.assignee;
  if (assignee) return [assignee];
  return workflow.owner ? [workflow.owner] : undefined;
}

export const mayApprove = (actor: Actor, roles: string[] | undefined, domain: string = DEFAULT_DOMAIN) =>
  actor.kind === 'system' || (isPerson(actor) && (!roles || roles.some((r) => hasRole(actor, r, domain))));

function summary(r: any, values: Record<string, CaseValue>, workflow?: WorkflowDef, actor?: Actor): CaseSummary {
  // A few leading values for a title, never a hidden one. Names and text first: jsonb sorts keys
  // by length, which would otherwise drop `client_name` behind `pan` and `flags`.
  const shown: Record<string, unknown> = {};
  const fields = workflow?.caseType.fields ?? {};
  const texty = (k: string) => { const t = fields[k]?.type; return t?.kind === 'scalar' && (t.name === 'PersonName' || t.name === 'Text'); };
  // Then references: the record a case is about names it when its texts don't (a paper's reading).
  const rank = (k: string) => (texty(k) ? 2 : fields[k]?.type.kind === 'ref' ? 1 : 0);
  const keys = Object.keys(values).sort((a, b) => rank(b) - rank(a));
  for (const k of keys) {
    if (Object.keys(shown).length >= 4) break;
    if (!actor || maySee(actor, fields[k], workflow ? domainOf(workflow) : DEFAULT_DOMAIN)) shown[k] = values[k]!.value;
  }
  return {
    caseId: r.case_id, runId: r.id, workflowId: r.workflow_id, workflowVersion: r.workflow_version, workflowHash: r.workflow_hash,
    state: r.state, status: r.status, ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), values: shown,
  };
}

export async function listCases(pool: pg.Pool, defs: DefinitionCache, filter: { workflowId?: string; status?: RunStatus; limit?: number }, actor: Actor): Promise<CaseSummary[]> {
  const { rows } = await pool.query(
    `select r.*, c.values from mw.runs r join mw.cases c on c.id = r.case_id
      where ($1::text is null or r.workflow_id = $1) and ($2::text is null or r.status = $2)
      order by r.updated_at desc, r.id desc limit $3`,
    [filter.workflowId ?? null, filter.status ?? null, filter.limit ?? 200]);
  const out: CaseSummary[] = [];
  for (const r of rows) out.push(summary(r, r.values ?? {}, await defs.workflow(r.workflow_id, r.workflow_hash).catch(() => undefined), actor));
  return out;
}

/** States entered, in order: the first state, then the target of every accepted move. */
export function pathOf(first: string, transitions: TransitionRecord[]): string[] {
  const path = [first];
  for (const t of transitions) if (t.accepted && t.event.type !== REMIND_EVENT) path.push(t.to);
  return path;
}

/** Phase 6: the hand-off links and the wait_until condition of a case (flow/handoffs.ts). */
export interface CaseFlowView {
  links(caseId: string, workflow: (id: string, hash: string) => Promise<WorkflowDef>): Promise<CaseLinkView[]>;
  waiting(runId: string): Promise<WaitingCondition | undefined>;
}

export async function getCaseView(pool: pg.Pool, defs: DefinitionCache, caseId: string, actor: Actor, flow?: CaseFlowView): Promise<CaseView | undefined> {
  const { rows } = await pool.query(
    `select r.*, c.values, c.tainted_fields from mw.runs r join mw.cases c on c.id = r.case_id
      where r.case_id = $1 order by r.created_at desc limit 1`, [caseId]);
  const r = rows[0];
  if (!r) return undefined;
  const workflow = await defs.workflow(r.workflow_id, r.workflow_hash);
  const fields = workflow.caseType.fields;
  const tainted = new Set<string>(r.tainted_fields ?? []);
  const values: CaseView['values'] = {};
  for (const [k, v] of Object.entries((r.values ?? {}) as Record<string, CaseValue>)) {
    values[k] = maySee(actor, fields[k], domainOf(workflow))
      ? { ...v, ...(tainted.has(k) ? { tainted: true } : {}) }
      : { value: null, provenance: v.provenance, hidden: true, ...(tainted.has(k) ? { tainted: true } : {}) };
  }
  const steps = await pool.query(
    `select id, step_id, performer, attempt, status, outcome, rationale, decided_by, comment, tainted, started_at, finished_at
       from mw.step_runs where run_id = $1 order by started_at, id`, [r.id]);
  const stepRuns: StepRunSummary[] = steps.rows.map((s) => ({
    stepRunId: s.id, stepId: s.step_id, performer: s.performer, attempt: s.attempt, status: s.status,
    ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.rationale ? { rationale: s.rationale } : {}),
    ...(s.decided_by ? { decidedBy: s.decided_by } : {}), ...(s.comment ? { comment: s.comment } : {}),
    tainted: s.tainted, startedAt: iso(s.started_at), ...(s.finished_at ? { finishedAt: iso(s.finished_at) } : {}),
  }));
  const transitions = await getTransitions(pool, r.id);
  const links = flow ? await flow.links(caseId, (id, hash) => defs.workflow(id, hash)) : [];
  const waiting = flow && r.status === 'active' && workflow.states[r.state]?.block?.kind === 'wait_until' ? await flow.waiting(r.id) : undefined;
  return {
    summary: summary(r, r.values ?? {}, workflow, actor),
    values, stepRuns, transitions,
    path: pathOf(transitions[0]?.from ?? r.state, transitions),
    ...(links.length ? { links } : {}), ...(waiting ? { waiting } : {}),
    domain: domainOf(workflow),
  };
}

export async function liveCounts(pool: pg.Pool, workflowId: string): Promise<LiveCounts> {
  const states = await pool.query(
    `select state, count(*)::int as n from mw.runs where workflow_id = $1 and status = 'active' group by state`, [workflowId]);
  const edges = await pool.query(
    `select t.from_state, t.to_state, count(*)::int as n from mw.transitions t join mw.runs r on r.id = t.run_id
      where r.workflow_id = $1 and t.accepted and t.event ->> 'type' <> $2 and t.at > now() - interval '30 days'
      group by t.from_state, t.to_state`, [workflowId, REMIND_EVENT]);
  return {
    workflowId,
    byState: Object.fromEntries(states.rows.map((s) => [s.state, s.n])),
    edges: Object.fromEntries(edges.rows.map((e) => [`${e.from_state}>${e.to_state}`, e.n])),
  };
}

/** Everything waiting on this person (19 §4). Steps and the kernel itself have no inbox. */
export async function inbox(pool: pg.Pool, defs: DefinitionCache, actor: Actor, entities?: Record<string, EntityTypeDef>): Promise<InboxItem[]> {
  if (!isPerson(actor)) return [];
  const items: InboxItem[] = [];
  // Roles held anywhere narrow the queries; each item is then checked in its workflow's domain.
  const roles = anyRoles(actor);

  // Person, external and conversation steps assigned to one of the person's roles (or to nobody
  // in particular). An agent step also waits while an effect approval is pending: that is not
  // a conversation, so agent rows count only when their step runs on the open engine.
  const waiting = await pool.query(
    `select s.id, s.run_id, s.case_id, s.workflow_id, s.workflow_hash, s.step_id, s.assignee, s.started_at, s.performer,
            (select min(t.fire_at) from mw.timers t where t.run_id = s.run_id and t.status = 'pending' and t.timer_id not like 'remind.%') as due_at,
            exists (select 1 from mw.external_links l
                     where l.kind = 'step' and l.run_id = s.run_id and l.step_id = s.step_id
                       and (l.step_run_id is null or l.step_run_id = s.id)
                       and l.used_at is null and l.closed_at is null and l.expires_at > now()) as link_open
       from mw.step_runs s join mw.runs r on r.id = s.run_id
      where s.status = 'waiting' and s.performer in ('person', 'external', 'agent') and r.status = 'active'
        and (s.assignee is null or s.assignee = any($1::text[]))
      order by s.started_at, s.id`, [roles]);
  for (const s of waiting.rows) {
    const wf = await defs.workflow(s.workflow_id, s.workflow_hash);
    const step = wf.steps[s.step_id];
    if (s.assignee && !hasRole(actor, s.assignee, domainOf(wf))) continue;
    if (s.performer === 'agent') {
      if (step?.engine !== 'open') continue;
      items.push({
        kind: 'conversation', id: `step:${s.id}`, stepRunId: s.id, runId: s.run_id, caseId: s.case_id, workflowId: s.workflow_id,
        stepId: s.step_id, ...(s.assignee ? { assignee: s.assignee } : {}), since: iso(s.started_at),
      });
      continue;
    }
    // An external step someone outside was sent a link to waits on them, not on staff (23 §3).
    if (s.performer === 'external' && s.link_open) continue;
    const ex = step?.extract;
    const review = step && entities ? await inboxReview(pool, wf, step, s.case_id, entities) : undefined;
    items.push({
      kind: step && Object.keys(step.writes).length ? 'input' : 'decision',
      id: `step:${s.id}`, stepRunId: s.id, runId: s.run_id, caseId: s.case_id, workflowId: s.workflow_id, stepId: s.step_id,
      ...(s.assignee ? { assignee: s.assignee } : {}), since: iso(s.started_at), ...(s.due_at ? { dueAt: iso(s.due_at) } : {}),
      ...(ex ? { extract: { documentsField: ex.documents, fields: [...new Set(Object.values(ex.fields))], minConfidence: ex.minConfidence } } : {}),
      // Phase 6 (24 §11): the domain, how the step is reviewed, and the signature it needs.
      domain: domainOf(wf), ...(review ? { review } : {}), ...(step?.sign ? { sign: { meaning: step.sign } } : {}),
    });
  }

  // Effect approvals a waiting step asked for, that this person may decide.
  const approvals = await pool.query(
    `select a.*, s.run_id, s.case_id, s.workflow_id, s.workflow_hash, s.step_id
       from mw.approvals a join mw.step_runs s on s.id = a.step_run_id
      where a.status = 'pending' and s.status = 'waiting' order by a.requested_at, a.id`);
  const policySources = approvals.rows.length ? await loadPolicySources(pool) : undefined;
  const pluginPolicies = approvals.rows.length ? await loadPluginPolicies(pool) : undefined;
  for (const a of approvals.rows) {
    const wf = await defs.workflow(a.workflow_id, a.workflow_hash);
    const policy = await defs.policy(wf, a.step_id, policySources, pluginPolicies);
    if (!mayApprove(actor, approverRoles(policy, wf, a.step_id), domainOf(wf))) continue;
    const approval: ApprovalRequest = {
      id: a.id, stepRunId: a.step_run_id, tool: a.tool, effect: a.effect, treatment: a.treatment, args: a.args,
      preview: a.preview, requestedAt: iso(a.requested_at),
    };
    items.push({ kind: 'approval', id: `approval:${a.id}`, approval, runId: a.run_id, caseId: a.case_id, workflowId: a.workflow_id, stepId: a.step_id, since: approval.requestedAt });
  }

  // Runs that need someone: stopped, or waiting in a state with no step file (e.g. needs_person).
  const runs = await pool.query(
    `select id, case_id, workflow_id, workflow_hash, state, status, stop_reason, updated_at from mw.runs
      where status = 'stopped' or status = 'active' order by updated_at, id`);
  for (const r of runs.rows) {
    const wf = await defs.workflow(r.workflow_id, r.workflow_hash).catch(() => undefined);
    if (!wf || r.state === END_STATE) continue;
    const stopped = r.status === 'stopped';
    if (!stopped && stateKind(wf, r.state) !== 'wait') continue;
    const role = stopped ? wf.owner : assigneeOf(wf, r.state);
    if (role && !hasRole(actor, role, domainOf(wf))) continue;
    items.push({
      kind: 'attention', id: `attention:${r.id}:${r.state}`, runId: r.id, caseId: r.case_id, workflowId: r.workflow_id, state: r.state,
      reason: stopped ? `stopped: ${r.stop_reason ?? 'no reason recorded'}` : `waiting in ${r.state}`,
      events: stopped ? [] : Object.keys(wf.states[r.state]?.on ?? {}), since: iso(r.updated_at),
    });
  }

  // Unread reminders for the person or their roles.
  const notes = await new PgNotificationStore().unread(pool, { personId: actor.personId, roles });
  if (notes.length) {
    const steps = await pool.query(`select id, case_id, workflow_id, workflow_hash, state from mw.runs where id = any($1::text[])`, [notes.map((n) => n.runId)]);
    const byRun = new Map(steps.rows.map((r) => [r.id as string, r]));
    for (const n of notes) {
      const r = byRun.get(n.runId);
      if (!r) continue;
      // A reminder for a role counts only where the person holds it: in the playbook's domain.
      if (n.role && !n.personId) {
        const wf = await defs.workflow(r.workflow_id, r.workflow_hash).catch(() => undefined);
        if (wf && !hasRole(actor, n.role, domainOf(wf))) continue;
      }
      const stepId = n.stepRunId ? n.stepRunId.split('/').at(-1)! : r.state;
      items.push({
        kind: 'reminder', id: `reminder:${n.id}`, runId: n.runId, caseId: r.case_id, workflowId: r.workflow_id, stepId,
        ...(n.stepRunId ? { stepRunId: n.stepRunId } : {}), text: n.text, since: n.createdAt,
      });
    }
  }
  return items;
}

/** Case values for a reader: hidden fields removed (explain, the step digest). */
export function visibleValues(values: Record<string, CaseValue>, fields: Record<string, FieldDef>, actor: Actor, domain: string = DEFAULT_DOMAIN): Record<string, CaseValue> {
  return Object.fromEntries(Object.entries(values).filter(([k]) => maySee(actor, fields[k], domain)));
}


/**
 * Phase 6 (24 §7): one item per trigger whose firings the storm guard held, for the workflow's
 * owner role ("300 cases would start from Activate a site").
 */
export async function heldTriggerItems(pool: pg.Pool, defs: DefinitionCache, actor: Actor, domainOwner: (domain: string) => string | undefined = () => undefined): Promise<InboxItem[]> {
  if (!isPerson(actor)) return [];
  const { rows } = await pool.query(
    `select trigger_id, workflow_id, count(*)::int as n, min(at) as since from mw.trigger_firings
      where status = 'held' group by trigger_id, workflow_id order by min(at), trigger_id`);
  const out: InboxItem[] = [];
  for (const r of rows) {
    const wf = await defs.latest(r.workflow_id);
    // As `triggers.release` decides: the playbook's owner role, else its domain's owner.
    const domain = wf?.domain ?? DEFAULT_DOMAIN;
    const role = wf?.owner ?? domainOwner(domain);
    if (role && !hasRole(actor, role, domain)) continue;
    out.push({
      kind: 'trigger-hold', id: `trigger-hold:${r.trigger_id}`, triggerId: r.trigger_id, workflowId: r.workflow_id, held: r.n,
      description: heldWords(r.n, wf?.title ?? r.workflow_id), since: iso(r.since),
    });
  }
  return out;
}
