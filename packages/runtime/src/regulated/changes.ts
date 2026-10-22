// Change requests (26 §8, D115–D117): in a regulated domain a change to a playbook (and the rules
// and record types that ride in its draft) goes live only through a change request. The request
// holds what changes (its draft), why, validation runs on past cases, and two Part 11 signatures:
// the person who raised it sends it to QA; QA's signature publishes the draft as the next version.
// Runs already started keep the version they pinned (D36), so old cases finish on the old one.
//
// A validation run asks: on these past cases, would the draft's AI checks have done what the
// person at the next person step did? It re-runs the changed agent step's checkpoint rules (the
// verifier model role, as the step engine does) on the result and evidence each case recorded,
// and compares the verdict with the person's decision: "41 of 42 match QC".
import {
  changeRequestLabel, contentHash, PgAuditLog, PgChangeRequestStore, PgSignatureStore, withTransaction, type ChangeRequestRow, type ChangeValidationRow,
  type PgPeopleStore, type Queryable,
} from '@memwise/db';
import {
  DEFAULT_DOMAIN, diffDraft, loadDraft, type Diagnostic, type DraftDiff, type ProjectDefs, type StepDef, type WorkflowDef,
} from '@memwise/defs';
import type { ModelGateway } from '@memwise/gateway';
import { parseVerdict, verifierRequest, type Evidence, type FinishArgs } from '@memwise/step-engine';
import { resolve } from 'node:path';
import type pg from 'pg';
import type { Actor, Authoring, KernelChange, PersonActor } from '../types.ts';
import { checkSigningPassword } from './signatures.ts';
import type {
  AuditLogService, ChangeFileDiff, ChangeRequestSummary, ChangeRequestView, ChangeSignoff, ChangeSignResult, ChangesService,
  ChangeStepRow, ChangeValidation, ValidationCaseResult, ValidationSet,
} from './types.ts';
import { listDiff, wordDiff } from './word-diff.ts';

/** What the raiser's and QA's signatures mean (stored with each signature). */
export const RAISER_MEANING = 'Raised this change and sent it to QA';
export const QA_MEANING = 'Approved this change for use';
/** Past cases a validation run reads by default. */
export const DEFAULT_VALIDATION_LIMIT = 50;
/** Verifier calls in flight at once during a validation run. */
const VALIDATION_PARALLEL = 4;

export interface ChangesDeps {
  pool: pg.Pool;
  projectDir?: string;
  /** The live project as last indexed. */
  project(): ProjectDefs | undefined;
  authoring(): Authoring | undefined;
  models: ModelGateway;
  verifierRole: string;
  people: PgPeopleStore;
  auditLog: () => AuditLogService;
  emit(change: KernelChange): void;
}

/** The service, and what the kernel itself calls: the inbox items and Authoring's hooks. */
export interface ChangesKernelService extends ChangesService {
  inboxItems(actor: Actor): Promise<import('../types.ts').InboxItem[]>;
  onDraftCreated(meta: { id: string; workflowId: string; title: string; kind: string }, by: Actor): Promise<void>;
  publishRefusal(draft: { id: string; workflowId: string; kind: string }, changeRequest: string | undefined): Promise<string | undefined>;
  writeRefusal(draftId: string): Promise<string | undefined>;
}

const store = new PgChangeRequestStore();
const signatures = new PgSignatureStore();
const auditStore = new PgAuditLog();

/** The project (domain) of a live playbook. */
const projectOf = (wf: Pick<WorkflowDef, 'domain'>) => wf.domain ?? DEFAULT_DOMAIN;

/**
 * Whether the person holds `role` in `domain`: workspace-wide, or by a grant there. With `project`
 * (a study of the app, Stage 3) a grant in that study counts too, as `mw.actor_has_role_in_project`.
 * Without it the act is the whole app's (a change request, an app-level inspector link), so only a
 * grant across the app counts: a study's grant reaches that study, not its app.
 */
export function holdsRole(actor: Actor, role: string, domain: string, project?: string): boolean {
  if (actor.kind !== 'person') return false;
  return actor.roles.includes(role)
    || !!actor.grants?.some((g) => g.role === role && g.domain === domain && (!g.project || (project !== undefined && g.project === project)));
}

/**
 * Whether the person reaches `project` of `domain` (a study), or with none the whole app, as
 * `mw.domain_project_visible`: no grant in the domain (workspace-wide roles), or a grant there
 * that reaches it. A grant in one study doesn't reach the app as a whole.
 */
export function reaches(actor: Actor, domain: string, project?: string): boolean {
  if (actor.kind !== 'person') return true;
  const inDomain = (actor.grants ?? []).filter((g) => g.domain === domain);
  return !inDomain.length || inDomain.some((g) => !g.project || (project !== undefined && g.project === project));
}

/** The role whose signature makes a change request of a domain live: `qa:`, else the owner. */
export function qaRoleOf(project: ProjectDefs | undefined, domain: string): string | undefined {
  const d = project?.domains?.[domain];
  return d?.qa ?? d?.owner;
}

/** Steps in the playbook's order: the states that have a step, as the playbook lists them. */
const stepOrder = (wf: WorkflowDef | undefined) => (wf ? Object.keys(wf.states).filter((s) => wf.steps[s]) : []);

/** The first person step after `from` (breadth first along the transitions). */
export function nextPersonStep(wf: WorkflowDef, from: string): StepDef | undefined {
  const seen = new Set<string>([from]);
  let frontier = [...new Set(Object.values(wf.states[from]?.on ?? {}))];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of frontier) {
      if (seen.has(s) || s === 'end') continue;
      seen.add(s);
      const step = wf.steps[s];
      if (step?.performer === 'person') return step;
      next.push(...Object.values(wf.states[s]?.on ?? {}));
    }
    frontier = next;
  }
  return undefined;
}

function fileKind(path: string): ChangeFileDiff['kind'] {
  if (/\/workflow\.ya?ml$/.test(path)) return 'playbook';
  if (/\/steps\//.test(path)) return 'step';
  if (/(^|\/)policy\.ya?ml$/.test(path)) return 'rules';
  if (/\/entities\//.test(path)) return 'record-type';
  if (/\/examples\//.test(path)) return 'example';
  return 'other';
}

const MAX_FILE_LINES = 200;

export function readableFiles(diff: DraftDiff | undefined): ChangeFileDiff[] {
  return (diff?.files ?? []).filter((f) => !f.path.endsWith('.memwise-draft.json')).map((f) => {
    const lines = f.hunks.flatMap((h) => h.lines.map((l) => ({ kind: l.kind === 'same' ? 'context' as const : l.kind, text: l.text })));
    return {
      path: f.path, kind: fileKind(f.path), status: f.status === 'deleted' ? 'removed' : f.status,
      lines: lines.length > MAX_FILE_LINES ? lines.slice(0, MAX_FILE_LINES) : lines,
    };
  });
}

/** The steps table of a change request: every step, with its title and rules diffed word by word. */
export function stepRows(live: WorkflowDef | undefined, draft: WorkflowDef | undefined, roleTitle: (role: string) => string | undefined): ChangeStepRow[] {
  const after = stepOrder(draft);
  const before = stepOrder(live);
  const order = [...after];
  // A removed step goes back where it was: after the step that came before it live.
  for (const [i, id] of before.entries()) {
    if (order.includes(id)) continue;
    const prev = before.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  }
  const who = (s: StepDef) => ({ performer: s.performer, ...(s.assignee ? { role: s.assignee, ...(roleTitle(s.assignee) ? { roleTitle: roleTitle(s.assignee)! } : {}) } : {}) });
  return order.map((id, i) => {
    const a = live?.steps[id];
    const b = draft?.steps[id];
    const shown = (b ?? a)!;
    const whoChanged = !!a && !!b && (a.performer !== b.performer || a.assignee !== b.assignee);
    const instructionsChanged = !!a && !!b && a.instructions.trim() !== b.instructions.trim();
    const outcomesChanged = !!a && !!b && (a.outcomes.join('|') !== b.outcomes.join('|')
      || JSON.stringify(live?.states[id]?.on ?? {}) !== JSON.stringify(draft?.states[id]?.on ?? {}));
    const rulesChanged = !!a && !!b && a.checkpoint.join('\n') !== b.checkpoint.join('\n');
    const change: ChangeStepRow['change'] = !a ? 'added' : !b ? 'removed'
      : a.hash !== b.hash || a.title !== b.title || whoChanged || instructionsChanged || outcomesChanged || rulesChanged ? 'changed' : 'same';
    return {
      n: i + 1, stepId: id, change,
      title: wordDiff(a?.title, b?.title),
      who: who(shown),
      ...(whoChanged ? { whoBefore: who(a!) } : {}),
      rules: listDiff(a?.checkpoint ?? [], b?.checkpoint ?? []),
      instructionsChanged, outcomesChanged,
    };
  });
}

const plainCaseValue = (v: unknown): unknown => (v && typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v);

/** A few words for a case: its document's name, else its first short text values. */
function caseTitle(values: Record<string, unknown>): string {
  const plain = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, plainCaseValue(v)]));
  for (const v of Object.values(plain)) {
    if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { sha256?: unknown }).sha256 === 'string') return (v as { name: string }).name;
  }
  const texts = Object.values(plain).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 80 && !/^[a-z]+_[0-9A-Z]{20,}$/.test(v));
  return texts.slice(0, 2).join(' · ') || '';
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export function createChangesService(deps: ChangesDeps): ChangesKernelService {
  const names = new Map<string, string>();
  async function nameOf(personId: string): Promise<string> {
    if (!names.has(personId)) names.set(personId, (await deps.people.get(personId).catch(() => undefined))?.name ?? personId);
    return names.get(personId)!;
  }
  const person = async (id: string) => ({ id, name: await nameOf(id) });

  function authoring(): Authoring {
    const a = deps.authoring();
    if (!a) throw new Error('change requests need the project folder (createKernel({ projectDir }))');
    return a;
  }
  const root = () => resolve(deps.projectDir ?? authoring().projectDir);

  function liveWorkflow(id: string): WorkflowDef | undefined {
    return deps.project()?.workflows[id];
  }

  /**
   * The request a change is made to, by its id only: numbers (`CR-014`) are per project, so a bare
   * number could name another project's request. Reads resolve labels with their project.
   */
  async function requireCr(id: string): Promise<ChangeRequestRow> {
    if (!/^cr_/.test(id)) throw new Error(`name the change request by its id (cr_…), not ${id}: numbers are per project`);
    const cr = await store.find(deps.pool, id);
    if (!cr) throw new Error(`there is no change request ${id}`);
    return cr;
  }

  const changed = (cr: ChangeRequestRow) => deps.emit({ kind: 'regulated', project: cr.project });

  /** A change request's entry in its project's trail; in `db`'s transaction when given. */
  async function audit(cr: ChangeRequestRow, by: PersonActor | undefined, action: string, data: Record<string, unknown> = {}, db?: Queryable) {
    const entry = {
      project: cr.project, actorKind: by ? 'person' as const : 'system' as const, actor: by?.personId ?? 'system', ...(by ? { actorLabel: await nameOf(by.personId) } : {}),
      action, entity: 'change_request', recordId: cr.id,
      data: { number: cr.number, label: changeRequestLabel(cr.number), workflow: cr.workflowId, ...data },
    };
    if (db) await auditStore.append(db, entry);
    else await deps.auditLog().append(entry);
  }

  /** The latest signature of a role (a request sent back and sent again is signed again). */
  const latestSig = <T extends { manifest: Record<string, unknown> }>(sigs: T[], role: 'raiser' | 'qa') => sigs.filter((x) => x.manifest.role === role).at(-1);

  async function summary(cr: ChangeRequestRow, validations?: ChangeValidationRow[], draftHash?: string): Promise<ChangeRequestSummary> {
    const live = liveWorkflow(cr.workflowId);
    const vs = validations ?? (await store.validations(deps.pool, cr.id));
    const hash = draftHash ?? (await authoring().getDraft(cr.draftId).catch(() => undefined))?.contentHash;
    const last = vs.at(-1);
    return {
      id: cr.id, number: cr.number, label: changeRequestLabel(cr.number), project: cr.project, workflowId: cr.workflowId,
      playbookTitle: live?.title ?? cr.workflowId, title: cr.title, status: cr.status, raisedBy: await person(cr.raisedBy),
      raisedAt: cr.raisedAt, updatedAt: cr.updatedAt,
      ...(last ? { validation: { passed: last.passed, total: last.total, status: last.status, current: last.draftHash === hash } } : {}),
    };
  }

  async function validationView(v: ChangeValidationRow, hash: string | undefined): Promise<ChangeValidation> {
    return {
      id: v.id, draftHash: v.draftHash, current: v.draftHash === hash, setLabel: v.setLabel, total: v.total, passed: v.passed,
      checkErrors: v.checkErrors, status: v.status, results: v.results as ValidationCaseResult[], at: v.at,
      ...(v.by ? { by: v.by, byName: await nameOf(v.by) } : {}),
    };
  }

  async function view(cr: ChangeRequestRow, actor: Actor): Promise<ChangeRequestView> {
    const a = authoring();
    const project = deps.project();
    const draft = await a.getDraft(cr.draftId).catch(() => undefined);
    const hash = draft?.contentHash ?? '';
    const live = liveWorkflow(cr.workflowId);
    const loaded = await loadDraft(root(), cr.draftId).catch(() => undefined);
    const diff = await diffDraft(root(), cr.draftId).catch(() => undefined);
    const diagnostics: Diagnostic[] = cr.status === 'open' || cr.status === 'in_review' ? await a.quickCheck(cr.draftId).catch(() => []) : [];
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const roleTitle = (r: string) => project?.roles[r]?.title;
    const validations = await store.validations(deps.pool, cr.id);
    const sigs = await signatures.forRecord(deps.pool, 'change_request', cr.id);
    // An open request isn't signed yet (one sent back to its raiser keeps the old signature in the trail).
    const raiserSig = cr.status === 'open' ? undefined : latestSig(sigs, 'raiser');
    const qaSig = cr.status === 'open' ? undefined : latestSig(sigs, 'qa');
    const qaRole = qaRoleOf(project, cr.project);
    const signoffs: ChangeSignoff[] = [
      {
        role: 'raiser', person: await person(cr.raisedBy), meaning: RAISER_MEANING,
        status: raiserSig ? 'signed' : cr.status === 'open' ? 'waiting' : 'not-yet',
        ...(raiserSig ? { signedAt: raiserSig.at, signatureId: raiserSig.id } : {}),
      },
      {
        role: 'qa', ...(qaRole ? { roleId: qaRole, ...(roleTitle(qaRole) ? { roleTitle: roleTitle(qaRole)! } : {}) } : {}), meaning: QA_MEANING,
        status: qaSig ? 'signed' : cr.status === 'in_review' ? 'waiting' : 'not-yet',
        ...(qaSig ? { person: { id: qaSig.personId, name: qaSig.name }, signedAt: qaSig.at, signatureId: qaSig.id } : {}),
      },
    ];
    const open = await deps.pool.query<{ n: number }>(
      `select count(*)::int as n from mw.runs where workflow_id = $1 and status = 'active' and workflow_hash = $2`, [cr.workflowId, live?.hash ?? '']);
    const last = validations.at(-1);
    const validated = !!last && last.status === 'passed' && last.draftHash === hash;
    const isRaiser = actor.kind === 'person' && actor.personId === cr.raisedBy;
    const isQa = actor.kind === 'person' && !!qaRole && holdsRole(actor, qaRole, cr.project) && !isRaiser;
    const base = await summary(cr, validations, hash);
    return {
      ...base,
      draftId: cr.draftId, draftHash: hash, reason: cr.reason, regulated: !!project?.domains?.[cr.project]?.regulated,
      ...(live ? { liveVersion: live.version } : {}),
      ...(loaded?.workflow ? { nextVersion: loaded.workflow.version } : {}),
      ...(cr.toVersion !== undefined ? { toVersion: cr.toVersion } : {}),
      openCasesOnLive: open.rows[0]?.n ?? 0,
      steps: cr.status === 'published' || cr.status === 'withdrawn' ? [] : stepRows(live, loaded?.workflow, roleTitle),
      files: cr.status === 'published' || cr.status === 'withdrawn' ? [] : readableFiles(diff),
      checks: { errors: errors.length, warnings: diagnostics.length - errors.length, messages: errors.slice(0, 5).map((d) => d.message) },
      validationSet: cr.validationSet as ValidationSet,
      validations: await Promise.all(validations.map((v) => validationView(v, hash))),
      signoffs,
      ...(cr.chatId ? { chatId: cr.chatId } : {}),
      ...(cr.closedAt ? { closedAt: cr.closedAt } : {}),
      ...(cr.closedBy ? { closedBy: await person(cr.closedBy) } : {}),
      can: {
        edit: cr.status === 'open',
        validate: cr.status === 'open' && actor.kind === 'person',
        send: cr.status === 'open' && isRaiser && validated && !!cr.reason.trim() && errors.length === 0,
        approve: cr.status === 'in_review' && isQa && validated,
        withdraw: (cr.status === 'open' || cr.status === 'in_review') && (isRaiser || isQa
          || (actor.kind === 'person' && !!project?.domains?.[cr.project]?.owner && holdsRole(actor, project.domains[cr.project]!.owner!, cr.project))),
      },
    };
  }

  // ---------------------------------------------------------------- validation

  interface PastCase { caseId: string; values: Record<string, unknown>; agentRun: string; personRun: { id: string; outcome: string; decided_by: string | null; comment: string | null; finished_at: Date } }

  async function pastCases(workflowId: string, agentStep: string, personStep: string, set: ValidationSet): Promise<PastCase[]> {
    const where = Object.entries(set.where ?? {});
    const { rows } = await deps.pool.query<{
      case_id: string; values: Record<string, unknown>; agent_run: string; person_run: string; outcome: string; decided_by: string | null; comment: string | null; finished_at: Date;
    }>(
      `select distinct on (p.case_id) p.case_id, c.values, a.id as agent_run, p.id as person_run, p.outcome, p.decided_by, p.comment, p.finished_at
         from mw.step_runs p
         join mw.cases c on c.id = p.case_id
         join lateral (select a.id from mw.step_runs a where a.case_id = p.case_id and a.step_id = $2 and a.status = 'completed'
                        and a.started_at <= p.started_at order by a.started_at desc limit 1) a on true
        where p.workflow_id = $1 and p.step_id = $3 and p.status = 'completed' and p.outcome is not null
          and ($4::text[] is null or p.case_id = any($4))
          and ($5::timestamptz is null or p.finished_at >= $5) and ($6::timestamptz is null or p.finished_at < $6)
          and (select bool_and(c.values -> w.key ->> 'value' = w.value) from jsonb_each_text($7::jsonb) w) is not false
        order by p.case_id, p.finished_at desc`,
      [workflowId, agentStep, personStep, set.caseIds ?? null, set.since ?? null, set.until ?? null, JSON.stringify(Object.fromEntries(where.map(([k, v]) => [k, String(v)])))]);
    return rows
      .sort((x, y) => y.finished_at.getTime() - x.finished_at.getTime())
      .slice(0, set.caseIds ? set.caseIds.length : set.limit ?? DEFAULT_VALIDATION_LIMIT)
      .map((r) => ({ caseId: r.case_id, values: r.values, agentRun: r.agent_run, personRun: { id: r.person_run, outcome: r.outcome, decided_by: r.decided_by, comment: r.comment, finished_at: r.finished_at } }));
  }

  /** The agent step run's last proposed result (its last `step.finish`) and the tool results it saw. */
  async function recorded(stepRunId: string): Promise<{ args?: FinishArgs; evidence: Evidence[] }> {
    const { rows } = await deps.pool.query<{ journal_key: string; kind: string; name: string; call_id: string | null; request: any; response: any }>(
      `select journal_key, kind, name, call_id, request, response from mw.step_journal where step_run_id = $1 and kind in ('tool', 'checkpoint') order by started_at, journal_key`,
      [stepRunId]);
    const evidence: Evidence[] = [];
    let args: FinishArgs | undefined;
    let round = 0;
    for (const r of rows) {
      if (r.kind === 'tool' && r.response?.status === 'ok') evidence.push({ tool: r.name, callId: r.call_id ?? '', args: r.request?.args ?? r.request, result: r.response.result });
      const m = /^checkpoint:(\d+):structural$/.exec(r.journal_key);
      if (m && Number(m[1]) >= round && r.request) { round = Number(m[1]); args = r.request as FinishArgs; }
    }
    return { ...(args ? { args } : {}), evidence };
  }

  async function validateCase(cr: ChangeRequestRow, step: StepDef, personStep: StepDef, c: PastCase): Promise<ValidationCaseResult> {
    const accepted = c.personRun.outcome === personStep.outcomes[0];
    const base = {
      caseId: c.caseId, title: caseTitle(c.values), finishedAt: c.personRun.finished_at.toISOString(),
      decided: { stepId: personStep.id, outcome: c.personRun.outcome, ...(c.personRun.decided_by ? { by: await nameOf(c.personRun.decided_by) } : {}), ...(c.personRun.comment ? { comment: c.personRun.comment } : {}) },
      accepted,
    };
    const { args, evidence } = await recorded(c.agentRun);
    if (!args) return { ...base, ai: 'error', matches: false, error: 'the case has no recorded result of the step to check' };
    let ai: 'pass' | 'fail' = 'pass';
    let failedRules: { rule: string; reason?: string }[] = [];
    if (args.outcome !== step.outcomes[0]) {
      // The agent didn't accept it itself (unsure): the AI checks alone would not have let it through.
      ai = 'fail';
      failedRules = [{ rule: `outcome ${step.outcomes[0]}`, reason: `the step ended ${args.outcome}` }];
    } else if (step.checkpoint.length) {
      try {
        const r = await deps.models.call(verifierRequest(step.checkpoint, args, evidence, Date.now()), { role: deps.verifierRole, sessionId: `crv:${cr.id}:${c.caseId}` });
        const verdict = parseVerdict(r.message, step.checkpoint);
        failedRules = verdict.filter((v) => !v.passed).map((v) => ({ rule: v.rule, ...(v.reason ? { reason: v.reason } : {}) }));
        if (failedRules.length) ai = 'fail';
      } catch (e) {
        return { ...base, ai: 'error', matches: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { ...base, ai, matches: (ai === 'pass') === accepted, ...(failedRules.length ? { failedRules } : {}) };
  }

  /** The agent steps a validation re-checks: those the draft changes (rules, instructions), else every one with rules. */
  function checkedSteps(live: WorkflowDef | undefined, draft: WorkflowDef): StepDef[] {
    const agents = Object.values(draft.steps).filter((s) => s.performer === 'agent' && s.checkpoint.length && nextPersonStep(draft, s.id));
    const touched = agents.filter((s) => {
      const a = live?.steps[s.id];
      return !a || a.checkpoint.join('\n') !== s.checkpoint.join('\n') || a.instructions.trim() !== s.instructions.trim();
    });
    return touched.length ? touched : agents;
  }

  // ---------------------------------------------------------------- the service

  const service: ChangesService = {
    async list(filter, actor) {
      const rows = await store.list(deps.pool, filter);
      void actor;
      return Promise.all(rows.map((cr) => summary(cr)));
    },

    async get(idOrNumber, actor, project) {
      const cr = await store.find(deps.pool, idOrNumber, project);
      return cr ? view(cr, actor) : undefined;
    },

    async forDraft(draftId) {
      const cr = await store.byDraft(deps.pool, draftId);
      return cr ? summary(cr) : undefined;
    },

    async open(input, by) {
      const live = liveWorkflow(input.workflowId);
      if (!live) throw new Error(`there is no playbook ${input.workflowId}`);
      const project = projectOf(live);
      if (!deps.project()?.domains?.[project]?.regulated) {
        throw new Error(`${live.title ?? live.id} is not in a regulated domain: change it with a draft, no change request needed`);
      }
      // A change request changes the app's playbook for every study of it: a grant in one study isn't enough.
      if (!reaches(by, project)) throw new Error(`a change to ${live.title ?? live.id} is the whole app's: it needs a role across ${deps.project()?.domains?.[project]?.name ?? project}, not in one of its projects`);
      const a = authoring();
      let draftId = input.draftId;
      if (draftId) {
        const d = await a.getDraft(draftId);
        if (!d || d.meta.workflowId !== input.workflowId || d.meta.kind !== 'change' || d.meta.status !== 'open') {
          throw new Error(`draft ${draftId} is not an open change of ${input.workflowId}`);
        }
        const has = await store.byDraft(deps.pool, draftId);
        if (has) return view(has, by);
      } else {
        // Authoring opens the request itself for a regulated playbook's new draft (below, `onDraftCreated`).
        const meta = await a.createDraft({ workflowId: input.workflowId, title: input.title ?? `Change ${live.title ?? live.id}`, kind: 'change' }, by);
        draftId = meta.id;
        const made = await store.byDraft(deps.pool, draftId);
        if (made) {
          const patched = (input.reason || input.validationSet || input.title)
            ? (await store.update(deps.pool, made.id, { ...(input.reason ? { reason: input.reason } : {}), ...(input.validationSet ? { validationSet: input.validationSet as Record<string, unknown> } : {}) }))!
            : made;
          return view(patched, by);
        }
      }
      const cr = await openFor({ id: draftId, workflowId: input.workflowId, title: input.title ?? `Change ${live.title ?? live.id}` }, by, input);
      return view(cr, by);
    },

    async update(id, patch, by) {
      const cr = await requireCr(id);
      if (cr.status !== 'open') throw new Error(`${changeRequestLabel(cr.number)} is ${cr.status.replace('_', ' ')}: it can't be changed now`);
      const next = (await store.update(deps.pool, cr.id, {
        ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason.trim() } : {}),
        ...(patch.validationSet ? { validationSet: patch.validationSet as Record<string, unknown> } : {}),
      }))!;
      changed(next);
      return view(next, by);
    },

    async setChat(id, chatId) {
      const cr = await requireCr(id);
      await store.update(deps.pool, cr.id, { chatId });
    },

    async validate(id, by, opts = {}) {
      const cr = await requireCr(id);
      if (cr.status !== 'open') throw new Error(`${changeRequestLabel(cr.number)} is ${cr.status.replace('_', ' ')}: validate it while it is open`);
      if (opts.set) await store.update(deps.pool, cr.id, { validationSet: opts.set as Record<string, unknown> });
      const set = (opts.set ?? cr.validationSet) as ValidationSet;
      const a = authoring();
      const draft = await a.getDraft(cr.draftId);
      if (!draft) throw new Error(`the draft of ${changeRequestLabel(cr.number)} is gone`);
      const diagnostics = await a.quickCheck(cr.draftId);
      const checkErrors = diagnostics.filter((d) => d.severity === 'error').length;
      const loaded = await loadDraft(root(), cr.draftId).catch(() => undefined);
      const results: ValidationCaseResult[] = [];
      if (loaded?.workflow && !checkErrors) {
        if (!deps.models.roles()[deps.verifierRole]) throw new Error(`no model is set up for the ${deps.verifierRole} role, so the AI checks can't be run on past cases`);
        const live = liveWorkflow(cr.workflowId);
        for (const step of checkedSteps(live, loaded.workflow)) {
          const personStep = nextPersonStep(loaded.workflow, step.id)!;
          const cases = await pastCases(cr.workflowId, step.id, personStep.id, set);
          results.push(...(await inBatches(cases, VALIDATION_PARALLEL, (c) => validateCase(cr, step, personStep, c))));
        }
      }
      const passed = results.filter((r) => r.matches).length;
      const status = !checkErrors && results.length > 0 && passed === results.length ? 'passed' : 'failed';
      const row = await store.addValidation(deps.pool, {
        crId: cr.id, draftHash: draft.contentHash, setLabel: set.label ?? '', total: results.length, passed, checkErrors, status, results, by: by.personId,
      });
      await audit(cr, by, 'change.validated', { passed, total: results.length, status, checkErrors, draftHash: draft.contentHash });
      changed(cr);
      return validationView(row, draft.contentHash);
    },

    async sign(id, input, by) {
      const cr = await requireCr(id);
      const label = changeRequestLabel(cr.number);
      const project = deps.project();
      const a = authoring();
      const draft = await a.getDraft(cr.draftId);
      if (!draft) return { applied: false, status: 'failed', message: `the draft of ${label} is gone` };
      const hash = draft.contentHash;
      const validations = await store.validations(deps.pool, cr.id);
      const last = validations.at(-1);
      const validated = !!last && last.status === 'passed' && last.draftHash === hash;

      if (cr.status === 'open') {
        if (by.personId !== cr.raisedBy) {
          return { applied: false, status: 'not-your-turn', message: `${label} is sent to QA by the person who raised it (${await nameOf(cr.raisedBy)})` };
        }
        if (!reaches(by, cr.project)) return { applied: false, status: 'forbidden', message: `${label} is the whole app's: sending it needs a role across the app, not in one of its projects` };
        if (!cr.reason.trim()) return { applied: false, status: 'no-reason', message: `give the reason for ${label} before sending it to QA` };
        if (!validated) return { applied: false, status: 'not-validated', message: `${label} needs a validation run that passes on the draft as it is now` };
        const refused = await checkSigningPassword(deps.people, by, input, RAISER_MEANING, { changeRequest: cr.id });
        if (refused) return { applied: refused.applied, status: refused.status, ...(refused.message ? { message: refused.message } : {}) };
        const next = await withTransaction(deps.pool, async (db) => {
          await signChange(db, cr, by, 'raiser', hash, last!.id);
          return (await store.update(db, cr.id, { status: 'in_review' }))!;
        });
        changed(next);
        return { applied: true, status: 'applied', view: await view(next, by) };
      }

      if (cr.status === 'in_review') {
        const qaRole = qaRoleOf(project, cr.project);
        if (!qaRole || !holdsRole(by, qaRole, cr.project)) {
          return { applied: false, status: 'forbidden', message: `${label} is signed by ${qaRole ? project?.roles[qaRole]?.title ?? qaRole : 'QA'}` };
        }
        if (by.personId === cr.raisedBy) {
          return { applied: false, status: 'forbidden', message: `you raised ${label}; someone else in QA signs it` };
        }
        const sigs = await signatures.forRecord(deps.pool, 'change_request', cr.id);
        const qaSigned = latestSig(sigs, 'qa');
        // QA signed and the draft went live, but the request wasn't closed (the app stopped in
        // between): close it with the version that was made, without publishing again.
        if (qaSigned && draft.meta.status === 'published') {
          const made = await a.publish(cr.draftId, { hash, by: by.personId, source: 'app', changeRequest: cr.id });
          if (made.status !== 'published') return { applied: false, status: 'failed', message: made.message };
          return finishPublished(cr, by, made);
        }
        const sent = latestSig(sigs, 'raiser');
        if (!sent || sent.manifest.draftHash !== hash || !validated) {
          // Changed after it was sent: back to the raiser, who validates and signs it again.
          const back = await withTransaction(deps.pool, async (db) => {
            const row = (await store.update(db, cr.id, { status: 'open' }))!;
            await audit(row, by, 'change.returned', {
              why: 'changed after it was sent to QA', sentHash: (sent?.manifest.draftHash as string | undefined) ?? null, draftHash: hash,
            }, db);
            return row;
          });
          changed(back);
          return {
            applied: false, status: 'stale', view: await view(back, by),
            message: `${label} changed after it was sent to QA: it went back to ${await nameOf(cr.raisedBy)} to validate and sign again`,
          };
        }
        const refused = await checkSigningPassword(deps.people, by, input, QA_MEANING, { changeRequest: cr.id });
        if (refused) return { applied: refused.applied, status: refused.status, ...(refused.message ? { message: refused.message } : {}) };
        // QA's signature and the marker that publishing started are kept first, in one transaction:
        // no version goes live without the signature that approved it.
        if (!qaSigned || qaSigned.manifest.draftHash !== hash) {
          await withTransaction(deps.pool, async (db) => {
            await signChange(db, cr, by, 'qa', hash, last!.id);
            await audit(cr, by, 'change.publishing', { draftHash: hash }, db);
          });
        }
        const published = await a.publish(cr.draftId, { hash, by: by.personId, source: 'app', changeRequest: cr.id });
        if (published.status !== 'published') {
          // Signed, not live (the live files changed): the request stays with QA, and signing again retries.
          await audit(cr, by, 'change.publish_failed', { status: published.status, message: published.message ?? null });
          changed(cr);
          return { applied: false, status: published.status === 'stale' ? 'stale' : published.status === 'conflict' ? 'conflict' : 'failed', message: published.message };
        }
        return finishPublished(cr, by, published);
      }
      return { applied: false, status: 'failed', message: `${label} is ${cr.status}` };
    },

    async withdraw(id, by, reason) {
      const cr = await requireCr(id);
      const v = await view(cr, by);
      if (!v.can.withdraw) throw new Error(`${changeRequestLabel(cr.number)} can't be withdrawn by you now`);
      const next = (await store.update(deps.pool, cr.id, { status: 'withdrawn', closedAt: new Date().toISOString(), closedBy: by.personId }))!;
      await authoring().discardDraft(cr.draftId, by).catch(() => undefined);
      await audit(next, by, 'change.withdrawn', reason ? { reason } : {});
      changed(next);
      return view(next, by);
    },

    async setNextNumber(project, next) {
      await store.setNextNumber(deps.pool, project, next);
    },
  };

  /** Closes a request whose draft QA's signature published. */
  async function finishPublished(cr: ChangeRequestRow, by: PersonActor, published: { workflowId: string; version: number; hash: string }): Promise<ChangeSignResult> {
    const next = (await store.update(deps.pool, cr.id, {
      status: 'published', toVersion: published.version, toHash: published.hash, closedAt: new Date().toISOString(), closedBy: by.personId,
    }))!;
    await audit(next, by, 'change.published', { version: published.version, hash: published.hash, fromVersion: cr.fromVersion ?? null });
    changed(next);
    return {
      applied: true, status: 'applied', view: await view(next, by),
      published: { workflowId: published.workflowId, version: published.version, hash: published.hash },
    };
  }

  async function signChange(db: pg.PoolClient, cr: ChangeRequestRow, by: PersonActor, role: 'raiser' | 'qa', draftHash: string, validationId: string) {
    const values = { number: cr.number, workflow: cr.workflowId, title: cr.title, reason: cr.reason, draftHash, validation: validationId, role };
    await signatures.add(db, {
      personId: by.personId, name: await nameOf(by.personId), meaning: role === 'raiser' ? RAISER_MEANING : QA_MEANING,
      entity: 'change_request', recordId: cr.id, contentHash: contentHash({ entity: 'change_request', recordId: cr.id, values }),
      manifest: { ...values, project: cr.project },
    });
    await deps.people.recordAuthEvent(by.personId, 'signature-ok', { changeRequest: cr.id, role }, db);
  }

  /** Opens the request of a regulated playbook's draft (raised by whoever made the draft). */
  async function openFor(draft: { id: string; workflowId: string; title: string }, by: PersonActor, input: { reason?: string; validationSet?: ValidationSet } = {}): Promise<ChangeRequestRow> {
    const live = liveWorkflow(draft.workflowId)!;
    const cr = await store.create(deps.pool, {
      project: projectOf(live), workflowId: draft.workflowId, draftId: draft.id, title: draft.title, raisedBy: by.personId,
      fromVersion: live.version, fromHash: live.hash,
      ...(input.reason ? { reason: input.reason } : {}), ...(input.validationSet ? { validationSet: input.validationSet as Record<string, unknown> } : {}),
    });
    await audit(cr, by, 'change.opened', { title: cr.title, fromVersion: live.version });
    changed(cr);
    return cr;
  }

  return Object.assign(service, {
    /** Sign-offs waiting on this person: QA's on requests sent to QA, the raiser's on open ones that passed validation. */
    async inboxItems(actor: Actor): Promise<import('../types.ts').InboxItem[]> {
      if (actor.kind !== 'person' || !deps.authoring()) return [];
      const project = deps.project();
      const items: import('../types.ts').InboxItem[] = [];
      for (const cr of await store.list(deps.pool, { status: ['open', 'in_review'] })) {
        if (cr.status === 'in_review') {
          const qa = qaRoleOf(project, cr.project);
          if (!qa || !holdsRole(actor, qa, cr.project) || actor.personId === cr.raisedBy) continue;
          items.push({ kind: 'change-request', id: `change-request:${cr.id}:qa`, changeRequest: await summary(cr), signoff: 'qa', since: cr.updatedAt });
        } else if (actor.personId === cr.raisedBy) {
          const s = await summary(cr);
          if (s.validation?.status === 'passed' && s.validation.current) items.push({ kind: 'change-request', id: `change-request:${cr.id}:raiser`, changeRequest: s, signoff: 'raiser', since: cr.updatedAt });
        }
      }
      return items;
    },
    /**
     * Authoring's hook: a new change draft of a regulated domain's playbook opens its request.
     * Not for drafts made by the system (no one to raise it).
     */
    async onDraftCreated(meta: { id: string; workflowId: string; title: string; kind: string }, by: Actor): Promise<void> {
      if (meta.kind !== 'change' || by.kind !== 'person') return;
      const live = liveWorkflow(meta.workflowId);
      if (!live || !deps.project()?.domains?.[projectOf(live)]?.regulated) return;
      await openFor(meta, by);
    },
    /** Authoring's hook: why the draft can't be published other than through its request, if it can't. */
    async publishRefusal(draft: { id: string; workflowId: string; kind: string }, changeRequest: string | undefined): Promise<string | undefined> {
      const cr = await store.byDraft(deps.pool, draft.id);
      if (cr) return cr.id === changeRequest ? undefined : `this draft is ${changeRequestLabel(cr.number)}: it goes live when QA signs the change request`;
      // A regulated playbook's change with no request (made by an agent or the system, which don't
      // open one) or published under another request's name goes live only through a request of its own.
      const live = liveWorkflow(draft.workflowId);
      if (draft.kind === 'change' && live && deps.project()?.domains?.[projectOf(live)]?.regulated) {
        return `${live.title ?? live.id} is in a regulated domain: this draft has no change request, so it can't go live (open a change request for it)`;
      }
      if (changeRequest) return `this draft is not the draft of that change request`;
      return undefined;
    },
    /** Authoring's hook: a request's draft changes only while the request is open. */
    async writeRefusal(draftId: string): Promise<string | undefined> {
      const cr = await store.byDraft(deps.pool, draftId);
      if (!cr || cr.status === 'open') return undefined;
      const label = changeRequestLabel(cr.number);
      return cr.status === 'in_review'
        ? `${label} is in review: its draft can't be changed while QA has it. Withdraw it to change it, or QA sends it back.`
        : `${label} is ${cr.status}: its draft can't be changed now`;
    },
  });
}


