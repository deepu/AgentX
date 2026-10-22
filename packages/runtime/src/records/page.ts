// Record pages (24 §6, §11): drawn on request from the entity's layout and the record's data,
// never stored. Every field the viewer may see, with where its value came from (the version that
// last changed it, a plugin, a linked domain, a calculation), what they may edit, the parent chain,
// related records, cases about it, the transitions they may make, flags, signatures ("changed
// since signed"), notes, mentions, what it can start, its documents and its history. With
// `review`, the page also carries a person step's proposed values, checks and outcomes.
import {
  evaluateCondition, PgCaseStore, PgEntityStore, PgFlagStore, PgMentionStore, PgNoteStore, PgRecordVersions, PgSignatureStore,
  withActor, type RecordVersionRow, type StoredEntityRow,
} from '@memwise/db';
import {
  defaultPageLayout, domainOf, keyOf, resolveEntity, type CaseValue, type CheckResult, type EntityTypeDef, type PageBlock,
  type WorkflowDef,
} from '@memwise/defs';
import { recordContentHash } from '../regulated/content.ts';
import { signedRecordField } from '../regulated/signatures.ts';
import {
  pageBlockKey, type Actor, type ChartData, type DocumentValue, type RecordField, type RecordFieldSource, type RecordKpi, type RecordPage,
  type RecordReview, type RecordTextView, type RecordTransitionOption, type RecordVersionSummary, type SignatureView,
} from '../types.ts';
import { chartData } from './charts.ts';
import { textView } from './quotes.ts';
import { assigneeOf } from '../driver.ts';
import { maySee } from '../views.ts';
import { domainOfEntity, inverseOf, isControlled, isRegulated, recordTitle, refEntity, type RecordsDeps } from './context.ts';
import { checkTransition, transitionsFrom, type Mover } from './lifecycle.ts';
import { stepReview } from './review.ts';
import { mayWrite } from './service.ts';

const entityStore = new PgEntityStore();
const versionsStore = new PgRecordVersions();
const signatures = new PgSignatureStore();
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** Every block of a layout, in order. */
export const layoutBlocks = (layout: RecordPage['layout']): PageBlock[] => Object.values(layout.areas).flat();

/** Labels for version authors: a person's name, the step's title, the source. */
export async function byLabels(deps: RecordsDeps, versions: { by: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const people = [...new Set(versions.map((v) => v.by).filter((b) => b.startsWith('person_')))];
  for (const id of people) out.set(id, (await deps.people.get(id))?.name ?? id);
  const steps = [...new Set(versions.map((v) => v.by).filter((b) => b.startsWith('step:')).map((b) => b.slice(5)))];
  if (steps.length) {
    const { rows } = await deps.pool.query(`select id, step_id, workflow_id, workflow_hash from mw.step_runs where id = any($1::text[])`, [steps]);
    for (const r of rows) {
      const wf = await deps.defs.workflow(r.workflow_id, r.workflow_hash).catch(() => undefined);
      out.set(`step:${r.id}`, `${wf?.steps[r.step_id]?.title ?? r.step_id} (${wf?.title ?? r.workflow_id})`);
    }
  }
  for (const v of versions) {
    if (out.has(v.by)) continue;
    if (v.by.startsWith('source:')) out.set(v.by, v.by.slice(7).replace(/^domain:/, ''));
    else if (v.by === 'system') out.set(v.by, 'MemWise');
  }
  return out;
}

export const versionSummary = (v: RecordVersionRow, labels: Map<string, string>): RecordVersionSummary => ({
  version: v.version, at: v.at, by: v.by, ...(labels.get(v.by) ? { byLabel: labels.get(v.by)! } : {}),
  ...(v.via ? { via: v.via } : {}), ...(v.reason ? { reason: v.reason } : {}), changed: v.changed, hash: v.hash,
});

/** Where a version's change came from, as a field source. */
function sourceOfVersion(v: RecordVersionRow, labels: Map<string, string>, workflows: Map<string, string>): RecordFieldSource {
  if (v.by.startsWith('step:')) {
    const stepRunId = v.by.slice(5);
    return { kind: 'step', stepRunId, ...(workflows.get(stepRunId) ? { workflowId: workflows.get(stepRunId)! } : {}) };
  }
  if (v.by.startsWith('source:')) return { kind: 'source', source: v.by.slice(7) };
  if (v.by === 'system') return { kind: 'domain' };
  return { kind: 'person', personId: v.by, ...(labels.get(v.by) ? { name: labels.get(v.by)! } : {}) };
}

/** Signatures on a record, each with whether the record still hashes as it did. */
export async function signatureViews(db: import('@memwise/db').Queryable, def: EntityTypeDef, id: string, values: Record<string, unknown>): Promise<SignatureView[]> {
  const now = recordContentHash(def, id, values).hash;
  return (await signatures.forRecord(db, keyOf(def), id)).map((s) => ({
    id: s.id, stepRunId: s.stepRunId ?? '', caseId: s.caseId ?? '', personId: s.personId, name: s.name, meaning: s.meaning, at: s.at,
    entity: s.entity, recordId: s.recordId, contentHash: s.contentHash, changedSince: s.contentHash !== now,
  }));
}

/** A record's title by entity and id, read under the actor (undefined: not there or not visible). */
async function titleOf(deps: RecordsDeps, actor: Actor, def: EntityTypeDef, id: string): Promise<{ row: StoredEntityRow; title: string } | undefined> {
  const row = await withActor(deps.pool, actor, (db) => entityStore.get(db, def, id));
  return row ? { row, title: recordTitle(def, id, { ...row.values, ...(row.lifecycle ? { status: row.lifecycle } : {}) }) } : undefined;
}

/** Values with the title template's references named by their records' titles ("{article}" reads as the paper, not its id). */
async function refsNamed(deps: RecordsDeps, actor: Actor, entities: Record<string, EntityTypeDef>, def: EntityTypeDef, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = { ...values };
  for (const [, name] of (def.title ?? '').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const target = refEntity(entities, def, name!);
    const v = values[name!];
    const t = target && typeof v === 'string' && v ? await titleOf(deps, actor, target, v) : undefined;
    if (t) out[name!] = t.title;
  }
  return out;
}

export async function buildPage(deps: RecordsDeps, def: EntityTypeDef, id: string, actor: Actor, opts: { review?: { stepRunId: string } } = {}): Promise<RecordPage | undefined> {
  const entities = deps.entities();
  const project = deps.project();
  const key = keyOf(def);
  const domain = domainOfEntity(def);
  const row = await withActor(deps.pool, actor, (db) => entityStore.get(db, def, id));
  if (!row) return undefined;
  const values = { ...row.values };
  const layout = def.page ?? defaultPageLayout(def);
  const blocks = layoutBlocks(layout);

  // ---- history and sources
  const versions = await versionsStore.list(deps.pool, key, id);
  const labels = await byLabels(deps, versions);
  const stepRuns = versions.filter((v) => v.by.startsWith('step:')).map((v) => v.by.slice(5));
  const workflows = new Map<string, string>();
  if (stepRuns.length) {
    const { rows } = await deps.pool.query(`select id, workflow_id from mw.step_runs where id = any($1::text[])`, [stepRuns]);
    for (const r of rows) workflows.set(r.id, r.workflow_id);
  }
  const lastChange = (field: string) => [...versions].reverse().find((v) => v.changed.includes(field) || (v.version === 1 && v.values[field] !== undefined && v.values[field] !== null));

  const followedBy = new Map<string, { target: string; recordId?: string }>();
  for (const [k, l] of Object.entries(def.links ?? {})) {
    const target = l.target || k;
    for (const f of l.follow) followedBy.set(f, { target, ...(row.followed?.[target]?.recordId ? { recordId: row.followed[target]!.recordId! } : {}) });
  }
  const canWrite = actor.kind === 'person' && mayWrite(deps, actor, domain);
  const hidden = new Set(row.hidden);
  const fields: RecordField[] = [];
  const refs: { field: RecordField; target: EntityTypeDef; id: string }[] = [];
  const own: [string, { typeSource: string; required?: boolean; description?: string }][] = [
    ...Object.entries(def.fields),
    ...Object.entries(def.relationships).filter(([n, r]) => r.cardinality === 'one' && !(n in def.fields)).map(([n, r]) => [n, { typeSource: `Ref<${r.target}>` }] as [string, { typeSource: string }]),
  ];
  for (const [name, f] of own) {
    const owner = def.ownership?.[name];
    const v = lastChange(name);
    const source: RecordFieldSource = owner && owner !== 'domain' ? { kind: 'plugin', plugin: owner } : v ? sourceOfVersion(v, labels, workflows) : { kind: 'domain' };
    const isHidden = hidden.has(name) || !maySee(actor, def.fields[name], domain);
    const field: RecordField = {
      name, type: f.typeSource, value: isHidden ? null : values[name] ?? null, source,
      editable: canWrite && !isHidden && (!owner || owner === 'domain'),
      ...(isHidden ? { hidden: true } : {}), ...(f.required ? { required: true } : {}), ...(f.description ? { description: f.description } : {}),
      ...(isControlled(project, def, name) ? { controlled: true } : {}),
    };
    fields.push(field);
    const target = refEntity(entities, def, name);
    if (target && typeof field.value === 'string') refs.push({ field, target, id: field.value });
  }
  for (const [name, c] of Object.entries(def.calculated ?? {})) {
    fields.push({ name, type: c.kind === 'rollup' && c.rollup === 'percent' ? 'Percentage' : 'Number', value: values[name] ?? null, source: { kind: 'calculated' }, editable: false, calculated: true, ...(c.description ? { description: c.description } : {}) });
  }
  for (const [name, link] of followedBy) {
    const target = resolveEntity(entities, domain, link.target);
    const tdomain = target ? domainOfEntity(target) : link.target.split('.')[0]!;
    fields.push({
      name, type: target?.fields[name]?.typeSource ?? 'Text', value: hidden.has(name) ? null : values[name] ?? null,
      source: { kind: 'link', domain: tdomain, entity: target ? keyOf(target) : link.target, ...(link.recordId ? { recordId: link.recordId } : {}) },
      editable: false, followed: true, ...(hidden.has(name) ? { hidden: true } : {}),
    });
  }
  for (const r of refs) {
    const t = await titleOf(deps, actor, r.target, r.id);
    if (t) r.field.ref = { entity: keyOf(r.target), id: r.id, title: t.title };
  }

  const status = row.lifecycle;
  const title = recordTitle(def, id, await refsNamed(deps, actor, entities, def, { ...values, ...(status ? { status } : {}) }));

  // ---- parents (root first)
  const parents: RecordPage['parents'] = [];
  let at: { def: EntityTypeDef; values: Record<string, unknown> } = { def, values };
  for (let depth = 0; depth < 12 && at.def.parent; depth++) {
    const parentId = at.values[at.def.parent];
    const pdef = refEntity(entities, at.def, at.def.parent);
    if (!pdef || typeof parentId !== 'string') break;
    const t = await titleOf(deps, actor, pdef, parentId);
    if (!t) break;
    parents.unshift({ entity: keyOf(pdef), id: parentId, title: t.title, ...(t.row.lifecycle ? { status: t.row.lifecycle } : {}) });
    at = { def: pdef, values: t.row.values };
  }

  // ---- related records: the first ten of each, and how many there are
  const related: RecordPage['related'] = {};
  const relNames = [...new Set(blocks.flatMap((b) => (b.kind === 'related' ? b.relationships : [])))];
  for (const rel of relNames) {
    const inv = inverseOf(entities, def, rel);
    if (!inv) continue;
    const r = await withActor(deps.pool, actor, (db) => entityStore.query(db, inv.target, entities, { filter: `${inv.via} = params.record`, params: { record: id }, limit: 10 }));
    // A row's own values: not the reference back to this record, nor other references (bare ids
    // that mean nothing on the page; the row's title names it).
    const own = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([f]) => f !== inv.via && !refEntity(entities, inv.target, f)));
    const rows = await Promise.all(r.rows.map(async (x) => ({ entity: keyOf(inv.target), id: x.id, title: recordTitle(inv.target, x.id, await refsNamed(deps, actor, entities, inv.target, x.values)), ...(x.lifecycle ? { status: x.lifecycle } : {}), values: own(x.values) })));
    const shown = new Set(rows.flatMap((x) => Object.keys(x.values)));
    const types = Object.fromEntries(Object.entries(inv.target.fields).filter(([f]) => shown.has(f)).map(([f, d]) => [f, d.typeSource]));
    related[rel] = { entity: keyOf(inv.target), total: r.total, rows, ...(Object.keys(types).length ? { types } : {}) };
  }

  // ---- cases whose values point at this record through a Ref to its entity
  const cases: RecordPage['cases'] = [];
  {
    const { rows } = await deps.pool.query(
      `select distinct on (r.case_id) r.id, r.case_id, r.workflow_id, r.workflow_hash, r.state, r.status, r.updated_at, c.values
         from mw.runs r join mw.cases c on c.id = r.case_id
        where exists (select 1 from jsonb_each(c.values) e where e.value ->> 'value' = $1)
        order by r.case_id, r.created_at desc`, [id]);
    rows.sort((a, b) => iso(b.updated_at).localeCompare(iso(a.updated_at)));
    for (const r of rows.slice(0, 50)) {
      const wf = await deps.defs.workflow(r.workflow_id, r.workflow_hash).catch(() => undefined);
      if (!wf) continue;
      const points = Object.entries(r.values as Record<string, CaseValue>).some(([k, v]) => {
        const t = wf.caseType.fields[k]?.type;
        return v.value === id && t?.kind === 'ref' && resolveEntity(entities, domainOf(wf), t.entity) === def;
      });
      if (!points) continue;
      // Who the case waits on: a person's step or a wait state; not a block (a `wait_until` waits on
      // the data) nor an agent or system step.
      const st = wf.states[r.state];
      const step = st ? wf.steps[st.step ?? r.state] : undefined;
      const byPerson = !!st && !st.block && (!step || step.performer === 'person');
      const waitingOn = r.status === 'active' && byPerson ? assigneeOf(wf, r.state) : undefined;
      cases.push({ caseId: r.case_id, runId: r.id, workflowId: wf.id, title: wf.title ?? wf.id, state: r.state, status: r.status, updatedAt: iso(r.updated_at), ...(waitingOn ? { waitingOn } : {}) });
      if (cases.length >= 20) break;
    }
  }

  // ---- lifecycle: the transitions out of the current state, as this viewer may make them
  let lifecycle: RecordPage['lifecycle'];
  const chart = def.lifecycleChart;
  if (chart) {
    const mover: Mover = actor.kind === 'person' ? { kind: 'person', actor } : actor.kind === 'system' ? { kind: 'system' } : { kind: 'step', caseId: actor.token.caseId };
    const transitions: RecordTransitionOption[] = [];
    await withActor(deps.pool, actor, async (db) => {
      for (const [name, to] of Object.entries(transitionsFrom(chart, status))) {
        const t = chart.transitions[name];
        const check = await checkTransition(db, def, entities, project, { id, transition: name }, mover);
        const guard = t?.guard ? await evaluateCondition(db, def, entities, id, t.guard).then((g) => ({ condition: t.guard!, holds: g.holds })).catch(() => ({ condition: t.guard!, holds: false })) : undefined;
        // A transition no role may make is the playbooks' (an "activate" `by: [step]`): never a person's button.
        const automatic = !!t && !chart.fromList && !t.by.some((b) => b.kind === 'role');
        transitions.push({
          name, to, allowed: check.ok, ...(!check.ok ? { reason: check.message } : {}), ...(guard ? { guard } : {}), ...(t?.signed ? { signed: true } : {}),
          ...(automatic ? { automatic: true } : {}),
          ...(t?.label ? { label: t.label } : {}),
          ...(t?.primary ? { primary: true } : {}),
        });
      }
    });
    // The states on the shortest way from the first state to the current one, so a page doesn't
    // tick a branch the record never took (kept → rejected skips reviewed).
    const via = new Map<string, string | null>([[chart.initial, null]]);
    for (let queue = [chart.initial]; queue.length && status && !via.has(status);) {
      const s = queue.shift()!;
      for (const to of Object.values(chart.states[s]?.on ?? {})) if (!via.has(to)) { via.set(to, s); queue.push(to); }
    }
    const passed: string[] = [];
    for (let s = status && via.has(status) ? via.get(status)! : null; s; s = via.get(s) ?? null) passed.unshift(s);
    lifecycle = { states: Object.keys(chart.states), ...(status ? { current: status, passed } : {}), transitions };
  }

  // ---- flags, signatures, notes, mentions
  const flagsNow = await new PgFlagStore().list(deps.pool, { entity: key, recordId: id, open: true });
  const sigs = await signatureViews(deps.pool, def, id, values);
  const note = await new PgNoteStore().get(deps.pool, key, id);
  const mentionRows = await new PgMentionStore().forTarget(deps.pool, key, id);

  // ---- workflows this record can start: triggers on its entity, or a case field that is a Ref to it
  const start: RecordPage['start'] = [];
  for (const wf of Object.values(project?.workflows ?? {})) {
    const wd = domainOf(wf);
    const byTrigger = (wf.startsOn ?? []).some((t) => 'entity' in t && resolveEntity(entities, wd, t.entity) === def);
    const byField = Object.values(wf.caseType.fields).some((f) => f.type.kind === 'ref' && resolveEntity(entities, wd, f.type.entity) === def);
    if (byTrigger || byField) start.push({ workflowId: wf.id, title: wf.title ?? wf.id });
  }

  // ---- documents for viewer blocks; a Text field's viewer shows the text with its quotes lit (25 §4)
  const documents: Record<string, DocumentValue | null> = {};
  const texts: Record<string, RecordTextView> = {};
  for (const b of blocks) {
    if (b.kind !== 'viewer') continue;
    const t = def.fields[b.field]?.type;
    if (t?.kind === 'scalar' && t.name === 'Text') {
      if (texts[b.field]) continue;
      const text = hidden.has(b.field) || typeof values[b.field] !== 'string' ? null : values[b.field] as string;
      texts[b.field] = await textView(deps, def, id, b.field, text, actor);
    } else {
      documents[b.field] = hidden.has(b.field) ? null : ((values[b.field] as DocumentValue | undefined) ?? null);
    }
  }

  // ---- KPI tiles and charts (25 §5)
  const kpis: Record<string, RecordKpi> = {};
  for (const b of blocks) {
    if (b.kind !== 'kpis') continue;
    for (const name of b.fields) {
      const f = fields.find((x) => x.name === name);
      const v = f && !f.hidden ? f.value : null;
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
      kpis[name] = { field: name, value: n, type: f?.type ?? 'Number', ...(f?.description ? { description: f.description } : {}) };
    }
  }
  const charts: Record<string, ChartData> = {};
  for (const [area, list] of Object.entries(layout.areas)) {
    for (const [i, b] of (list ?? []).entries()) {
      if (b.kind !== 'chart') continue;
      const inv = inverseOf(entities, def, b.of);
      if (!inv) continue; // a chart of a calculated field draws nothing yet
      const filter = [`${inv.via} = params.record`, ...(b.where?.trim() ? [`(${b.where})`] : [])].join(' and ');
      charts[pageBlockKey(area, i)] = await withActor(deps.pool, actor, (db) => chartData(deps, actor, db, inv.target, b, filter, { record: id }));
    }
  }

  const labelsAll = labels;
  const history = [...versions].reverse().slice(0, 20).map((v) => versionSummary(v, labelsAll));

  const page: RecordPage = {
    entity: key, domain, ...(row.project ? { project: row.project } : {}), entityName: def.entity, regulated: isRegulated(project, def), id, title, ...(status ? { status } : {}),
    layout, fields, parents, related, cases, ...(lifecycle ? { lifecycle } : {}),
    flags: flagsNow, signatures: sigs,
    ...(note ? { notes: { body: note.body, version: note.version, by: labels.get(note.by) ?? (await deps.people.get(note.by))?.name ?? note.by, at: note.at } } : {}),
    mentions: mentionRows.map((m) => ({ sourceKind: m.sourceKind, sourceId: m.sourceId, label: m.label ?? m.sourceId, at: m.at, ...(m.caseId ? { caseId: m.caseId } : {}) })),
    start, documents, history,
    ...(Object.keys(kpis).length ? { kpis } : {}),
    ...(Object.keys(charts).length ? { charts } : {}),
    ...(Object.keys(texts).length ? { texts } : {}),
  };
  if (opts.review) {
    const review = await buildReview(deps, def, id, actor, opts.review.stepRunId);
    if (review) page.review = review;
  }
  return page;
}

/**
 * Review mode (24 §11): a person step waiting on this record. The values it writes, as proposed
 * on the case (with where each came from: confidence, page and quote when an extraction read
 * it), the checks of the agent steps that prepared them, the outcomes, and the signature it needs.
 */
export async function buildReview(deps: RecordsDeps, def: EntityTypeDef, recordId: string, actor: Actor, stepRunId: string): Promise<RecordReview | undefined> {
  const { rows } = await deps.pool.query(
    `select s.id, s.run_id, s.case_id, s.workflow_id, s.workflow_hash, s.step_id, s.status, s.assignee, s.started_at
       from mw.step_runs s where s.id = $1`, [stepRunId]);
  const s = rows[0];
  if (!s || s.status !== 'waiting') return undefined;
  const wf: WorkflowDef = await deps.defs.workflow(s.workflow_id, s.workflow_hash);
  const step = wf.steps[s.step_id];
  if (!step || step.performer !== 'person') return undefined;
  const entities = deps.entities();
  const kind = stepReview(wf, step, entities);
  const snapshot = await new PgCaseStore().get(deps.pool, s.case_id);
  const values = snapshot?.values ?? {};
  const covered = kind?.kind === 'document' ? kind.field : signedRecordField(wf, step, entities)?.field;
  if (!covered || values[covered]?.value !== recordId) return undefined;

  const domain = domainOf(wf);
  const proposed: RecordReview['proposed'] = Object.entries(step.writes).map(([field, w]) => {
    const cv = values[field];
    const p = cv?.provenance as (CaseValue['provenance'] & { confidence?: number; page?: number; quote?: string; document?: string }) | undefined;
    const visible = maySee(actor, wf.caseType.fields[field], domain);
    return {
      field, type: w.typeSource, value: visible ? cv?.value ?? null : null, ...(cv && visible ? { provenance: cv.provenance } : {}),
      ...(p?.confidence !== undefined ? { confidence: p.confidence } : {}), ...(p?.page !== undefined ? { page: p.page } : {}),
      ...(p?.quote ? { quote: p.quote } : {}), ...(p?.document ? { document: p.document } : {}), ...(w.required ? { required: true } : {}),
    };
  });
  // A proposed reference is shown by its record's title, as the viewer may read it.
  for (const p of proposed) {
    const w = step.writes[p.field]!;
    if (w.type.kind !== 'ref' || typeof p.value !== 'string') continue;
    const target = resolveEntity(entities, domain, w.type.entity);
    const t = target ? await titleOf(deps, actor, target, p.value) : undefined;
    if (target && t) p.ref = { entity: keyOf(target), id: p.value, title: t.title };
  }

  // The checks of the agent steps of this case that ran before the review.
  const { rows: earlier } = await deps.pool.query(
    `select id, checkpoint from mw.step_runs where case_id = $1 and performer = 'agent' and started_at <= $2 order by started_at, id`, [s.case_id, s.started_at]);
  const checks: RecordReview['checks'] = [];
  for (const r of earlier) {
    const list = (Array.isArray(r.checkpoint) ? r.checkpoint : (r.checkpoint?.checks ?? [])) as CheckResult[];
    for (const c of list) if (c && typeof c.rule === 'string') checks.push({ ...c, stepRunId: r.id });
  }

  // Comments made when this step was answered before (a send-back) and on earlier attempts.
  const { rows: comments } = await deps.pool.query(
    `select decided_by, comment, finished_at from mw.step_runs where run_id = $1 and comment is not null and id <> $2 order by finished_at`, [s.run_id, stepRunId]);

  const review: RecordReview = {
    stepRunId, runId: s.run_id, caseId: s.case_id, workflowId: wf.id, stepId: step.id, title: step.title ?? step.id,
    ...(step.instructions ? { instructions: step.instructions } : {}),
    proposed, checks, outcomes: step.outcomes,
    ...(comments.length ? { returnedComments: comments.map((c) => ({ by: c.decided_by ?? 'someone', comment: c.comment, at: iso(c.finished_at) })) } : {}),
  };
  if (step.sign && actor.kind === 'person') {
    const person = await deps.people.get(actor.personId);
    review.sign = { meaning: step.sign, as: { personId: actor.personId, name: person?.name ?? actor.personId, roles: [...new Set([...actor.roles, ...(actor.grants ?? []).filter((g) => g.domain === domain).map((g) => g.role)])] } };
  }
  return review;
}
