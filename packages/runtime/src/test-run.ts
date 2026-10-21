// A test run of a draft on one record (26 §5, Stage 4, D121): the draft's playbook started for a
// real record, in a throwaway database, as an example case. The record, the records its Ref fields
// point at (up its parents) and the records that point at it (its documents, its people) are copied
// in as the person sees them; the model turns the record's latest case of the playbook got are
// replayed; each person step is answered with its first outcome and each effect that would leave the
// building is approved but stubbed, so nothing is sent. What the run did comes back as its trace.
import { DEFAULT_DOMAIN, keyOf, type EffectClass, type EntityTypeDef, type ExampleCase, type ProjectDefs, type WorkflowDef } from '@memwise/defs';
import { readOnlyFields } from './domain-tools.ts';
import { domainOfEntity, entityByName } from './records/context.ts';
import type { RecordQuery, RecordQueryResult } from './types.ts';

/** The example case a test run is, by this name (and only it runs). */
export const TEST_RUN_EXAMPLE = 'test-run';

/** Rows copied per relationship, and how far up the Ref fields the copy goes. */
const CHILD_ROWS = 100;
const ANCESTOR_DEPTH = 4;

export interface TestRunSource {
  project: ProjectDefs;
  /** The draft's playbook. */
  workflow: WorkflowDef;
  record: { entity: string; id: string };
  /** Records as the person sees them. */
  query(q: RecordQuery): Promise<RecordQueryResult>;
  /** The record's latest case of the playbook, replayed: its model turns are used. */
  latestCase?: ExampleCase;
  latestCaseId?: string;
  /** A bound tool's effect class, for stubbing what would leave the building. */
  effectOf(tool: string): EffectClass | undefined;
}

export interface TestRunExample {
  example: ExampleCase;
  /** The record's title. */
  title: string;
  /** The case field the record went into. */
  field: string;
  /** Records copied in, by entity key. */
  copied: Record<string, number>;
}

const OUTSIDE: EffectClass[] = ['outbound', 'irreversible'];

/** The case field a record of this type starts the playbook with: its first `Ref<Entity>` field, required first. */
export function recordCaseField(project: ProjectDefs, workflow: WorkflowDef, entity: string): string | undefined {
  const domain = workflow.domain ?? DEFAULT_DOMAIN;
  const target = entityByName(project.entities, entity, domain);
  if (!target) return undefined;
  const fields = Object.entries(workflow.caseType.fields)
    .filter(([, f]) => f.type.kind === 'ref' && entityByName(project.entities, f.type.entity, domain) === target)
    .sort(([, a], [, b]) => Number(!!b.required) - Number(!!a.required));
  return fields[0]?.[0];
}

export async function testRunExample(src: TestRunSource): Promise<TestRunExample> {
  const { project, workflow } = src;
  const domain = workflow.domain ?? DEFAULT_DOMAIN;
  const def = entityByName(project.entities, src.record.entity, domain);
  if (!def) throw new Error(`there is no record type ${src.record.entity}`);
  const field = recordCaseField(project, workflow, keyOf(def));
  if (!field) throw new Error(`${workflow.title ?? workflow.id} doesn't start from a ${def.entity}: none of its case fields is a Ref<${def.entity}>`);

  // Rows by entity key then id, in the order they must be created (what a row points at comes first).
  const rows = new Map<string, { def: EntityTypeDef; values: Record<string, unknown>; status?: string }>();
  const order: string[] = [];
  const keyOfRow = (d: EntityTypeDef, id: string) => `${keyOf(d)}\u0000${id}`;

  async function fetch(d: EntityTypeDef, filter: string, limit: number) {
    const r = await src.query({ entity: keyOf(d), filter, limit });
    return r.rows;
  }

  /** Adds a row after the rows its Ref fields point at (up to `depth` levels up). */
  async function add(d: EntityTypeDef, row: RecordQueryResult['rows'][number], depth: number): Promise<void> {
    const k = keyOfRow(d, row.id);
    if (rows.has(k)) return;
    rows.set(k, { def: d, values: {} }); // reserved, so a cycle stops here
    const writable = Object.keys(d.fields).filter((f) => !(f in readOnlyFields(d, [f], { creating: true })) && !row.hidden.includes(f));
    const values: Record<string, unknown> = {};
    for (const f of writable) {
      const v = row.values[f];
      if (v === null || v === undefined) continue;
      const type = d.fields[f]!.type;
      if (type.kind === 'ref') {
        const target = entityByName(project.entities, type.entity, domainOfEntity(d));
        if (!target || typeof v !== 'string') continue;
        if (!rows.has(keyOfRow(target, v)) && depth > 0) {
          const [parent] = await fetch(target, `id = '${v.replace(/'/g, "''")}'`, 1);
          if (parent) await add(target, parent, depth - 1);
        }
        if (!rows.has(keyOfRow(target, v))) {
          if (d.fields[f]!.required) { rows.delete(k); return; } // can't be created without it
          continue;
        }
      }
      // Document values name stored files the throwaway database doesn't have.
      if (type.kind === 'scalar' && ['Document', 'File', 'Image'].includes(type.name)) {
        if (d.fields[f]!.required) { rows.delete(k); return; }
        continue;
      }
      values[f] = v;
    }
    rows.set(k, { def: d, values: { id: row.id, ...values }, ...(row.status ? { status: row.status } : {}) });
    order.push(k);
  }

  const [record] = await fetch(def, `id = '${src.record.id.replace(/'/g, "''")}'`, 1);
  if (!record) throw new Error('That record was not found, or you may not see it.');
  await add(def, record, ANCESTOR_DEPTH);
  if (!rows.get(keyOfRow(def, record.id))?.values.id) throw new Error(`${record.title} can't be copied for a test run: a field it needs could not be read.`);
  // The records pointing at it: its `many` relationships.
  for (const rel of Object.values(def.relationships)) {
    if (rel.cardinality !== 'many') continue;
    const target = entityByName(project.entities, rel.target, domainOfEntity(def));
    if (!target) continue;
    const via = rel.via ?? Object.entries(target.fields).find(([, f]) => f.type.kind === 'ref'
      && entityByName(project.entities, f.type.entity, domainOfEntity(target)) === def)?.[0];
    if (!via || !target.fields[via]) continue;
    for (const child of await fetch(target, `${via} = '${record.id.replace(/'/g, "''")}'`, CHILD_ROWS)) await add(target, child, ANCESTOR_DEPTH);
  }

  const records: Record<string, Record<string, unknown>[]> = {};
  const copied: Record<string, number> = {};
  for (const k of order) {
    const r = rows.get(k)!;
    const key = keyOf(r.def);
    (records[key] ??= []).push({ ...r.values, ...(r.status ? { status: r.status } : {}) });
    copied[key] = (copied[key] ?? 0) + 1;
  }

  // Each person step answered with its first outcome; external steps wait (the run stops there).
  const submit: NonNullable<ExampleCase['submit']> = {};
  for (const [state, s] of Object.entries(workflow.states)) {
    const step = s.step ? workflow.steps[s.step] : undefined;
    if (step?.performer === 'person' && step.outcomes[0]) submit[state] = { outcome: step.outcomes[0] };
  }
  // What would leave the building is approved, and stubbed: nothing is sent.
  const tools: Record<string, unknown> = {};
  const approvals: Record<string, 'approve'> = {};
  for (const step of Object.values(workflow.steps)) {
    for (const t of new Set([...step.tools.allowed, ...step.tools.required])) {
      const effect = src.effectOf(t);
      if (effect && !OUTSIDE.includes(effect)) continue;
      tools[t] = { test_run: true, sent: false };
      approvals[t] = 'approve';
    }
  }

  const example: ExampleCase = {
    name: TEST_RUN_EXAMPLE,
    description: `A test run of ${workflow.title ?? workflow.id} on ${record.title}${src.latestCaseId ? `, replaying the model turns of case ${src.latestCaseId}` : ''}.`,
    case: { [field]: record.id },
    records,
    ...(src.latestCase?.model ? { model: src.latestCase.model } : {}),
    ...(Object.keys(tools).length ? { tools, approvals } : {}),
    ...(Object.keys(submit).length ? { submit } : {}),
    expect: {},
    file: `${workflow.dir}/examples/${TEST_RUN_EXAMPLE}.yaml`,
  };
  return { example, title: record.title, field, copied };
}
