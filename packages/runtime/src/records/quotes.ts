// Quotes on records (docs/memwise/25-literature-poc.md §4, D82): a Text field with `quote_of:
// <ref field>.<text field>` must hold words of the referenced record's text. Checked by code
// (`quoteIn` in @memwise/defs, the step engine's normaliser) after every create and update; a
// value that isn't there raises a flag on the record ("Quote not found in the source"), closed
// when a later version matches. And the quotes a record page's text viewer lights up: the
// quotes its values were read from, and the quote fields of related records pointing at it.
import { PgCaseStore, PgEntityStore, PgFlagStore, PgRecordVersions, withActor, type Queryable, type RecordVersionRow } from '@memwise/db';
import { findQuote, keyOf, quoteIn, type CaseValue, type EntityEvent, type EntityTypeDef, type FieldDef } from '@memwise/defs';
import type { Actor, RecordQuoteHighlight, RecordTextView } from '../types.ts';
import { entityByName, recordTitle, refEntity, type RecordsDeps } from './context.ts';

const entityStore = new PgEntityStore();
const flagStore = new PgFlagStore();
const SYSTEM = { kind: 'system' } as const;

/** The flag a quote that isn't in its source raises (one per record and field). */
export const QUOTE_FLAG_MESSAGE = 'Quote not found in the source';
export const quoteFlagKey = (field: string) => `quote_of:${field}`;

/** An entity's fields with `quote_of`. */
export const quoteFields = (def: EntityTypeDef): [string, NonNullable<FieldDef['quoteOf']>][] =>
  Object.entries(def.fields).flatMap(([name, f]) => (f.quoteOf ? [[name, f.quoteOf] as [string, NonNullable<FieldDef['quoteOf']>]] : []));

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

/**
 * Checks a record's quote fields against their sources: raises the flag for each value that
 * isn't in its source, closes it for each that is (or is empty). Run as the system, so a
 * field's access list never hides the source. Returns, for each quote field with a value,
 * whether it was found.
 */
export async function checkQuotes(db: Queryable, entities: Record<string, EntityTypeDef>, def: EntityTypeDef, recordId: string)
  : Promise<Record<string, boolean>> {
  const fields = quoteFields(def);
  const found: Record<string, boolean> = {};
  if (!fields.length) return found;
  const row = await entityStore.get(db, def, recordId);
  if (!row) return found;
  const entity = keyOf(def);
  for (const [field, of] of fields) {
    const value = row.values[field];
    if (blank(value)) { await flagStore.close(db, entity, recordId, quoteFlagKey(field)); continue; }
    const target = refEntity(entities, def, of.ref);
    const sourceId = row.values[of.ref];
    const source = target && typeof sourceId === 'string' ? await entityStore.get(db, target, sourceId) : undefined;
    const text = source?.values[of.field];
    const ok = typeof value === 'string' && typeof text === 'string' && quoteIn(value, text);
    found[field] = ok;
    if (ok) {
      await flagStore.close(db, entity, recordId, quoteFlagKey(field));
    } else {
      const where = !source ? `no ${of.ref} to quote from` : `not in the ${target!.entity}'s ${of.field}`;
      await flagStore.raise(db, { entity, recordId, invariant: quoteFlagKey(field), message: `${QUOTE_FLAG_MESSAGE}: ${field} is ${where}`, ...(row.project ? { project: row.project } : {}) });
    }
  }
  return found;
}

/** Records of other entities quoting a record of `def` (a changed abstract re-checks the evidence quoting it). */
export function quotingEntities(entities: Record<string, EntityTypeDef>, def: EntityTypeDef): { def: EntityTypeDef; ref: string; text: string }[] {
  const out: { def: EntityTypeDef; ref: string; text: string }[] = [];
  for (const other of Object.values(entities)) {
    for (const [, of] of quoteFields(other)) {
      if (refEntity(entities, other, of.ref) === def && !out.some((o) => o.def === other && o.ref === of.ref)) out.push({ def: other, ref: of.ref, text: of.field });
    }
  }
  return out;
}

/** Re-checks the quotes of a record, then those quoting it when its quoted text changed. Whether any quote was checked. */
export async function recheckQuotes(db: Queryable, entities: Record<string, EntityTypeDef>, def: EntityTypeDef, recordId: string, changed?: string[])
  : Promise<boolean> {
  let moved = Object.keys(await checkQuotes(db, entities, def, recordId)).length > 0;
  for (const q of quotingEntities(entities, def)) {
    if (changed && !changed.includes(q.text)) continue;
    const r = await entityStore.query(db, q.def, entities, { filter: `${q.ref} = params.record`, params: { record: recordId }, limit: 500 });
    for (const row of r.rows) {
      const found = await checkQuotes(db, entities, q.def, row.id);
      moved ||= Object.keys(found).length > 0;
    }
  }
  return moved;
}

/** The records consumer (run by the flow dispatcher like `invariants`): quotes are re-checked on every create and change. */
export function quotesConsumer(deps: Pick<RecordsDeps, 'pool' | 'entities' | 'emit'>): { name: string; handle(event: EntityEvent): Promise<void> } {
  return {
    name: 'quotes',
    async handle(event) {
      if (event.kind === 'entered') return;
      const entities = deps.entities();
      const def = entityByName(entities, event.entity);
      if (!def) return;
      if (!quoteFields(def).length && !quotingEntities(entities, def).length) return;
      const moved = await withActor(deps.pool, SYSTEM, (db) => recheckQuotes(db, entities, def, event.recordId, event.kind === 'changed' ? event.fields : undefined));
      if (moved) deps.emit({ kind: 'records', entity: keyOf(def), recordId: event.recordId });
    },
  };
}

// ---------------------------------------------------------------- the text viewer (25 §4)

/** Where a value's quote is kept: on its case value's provenance (judgement, or a reader tool's). */
const quoteOfValue = (cv: CaseValue | undefined): string | undefined => {
  const p = cv?.provenance as { quote?: unknown } | undefined;
  return typeof p?.quote === 'string' && p.quote.trim() ? p.quote : undefined;
};

/**
 * The quote a record field's value was read from, through the version that last changed it:
 * its `via` is a step run; that step's case holds the value with its provenance. A system step
 * that copies case values onto the record (`save`) maps the field from a case field, whose
 * provenance still names the step that read it (with its quote); an agent step writing the
 * record itself has the value as its own case write of the same name.
 */
async function quoteThroughStep(deps: RecordsDeps, cases: Map<string, Record<string, CaseValue>>, version: RecordVersionRow, field: string)
  : Promise<string | undefined> {
  const stepRunId = version.via ?? (version.by.startsWith('step:') ? version.by.slice(5) : undefined);
  if (!stepRunId) return undefined;
  const { rows } = await deps.pool.query(`select case_id, workflow_id, workflow_hash, step_id from mw.step_runs where id = $1`, [stepRunId]);
  const s = rows[0];
  if (!s) return undefined;
  if (!cases.has(s.case_id)) cases.set(s.case_id, (await new PgCaseStore().get(deps.pool, s.case_id))?.values ?? {});
  const values = cases.get(s.case_id)!;
  const wf = await deps.defs.workflow(s.workflow_id, s.workflow_hash).catch(() => undefined);
  const step = wf?.steps[s.step_id];
  // The case fields that fed this record field: the step's map (a copy), else the field itself.
  const from = new Set<string>();
  for (const args of Object.values(step?.map ?? {})) {
    const src = args[field];
    if (src && 'case' in src) from.add(src.case.split('.')[0]!);
  }
  if (!from.size) from.add(field);
  for (const f of from) {
    const q = quoteOfValue(values[f]);
    if (q) return q;
  }
  return undefined;
}

/**
 * A Text field shown in a viewer block, with the quotes to light up (25 §4): the quotes each of
 * the record's own values was read from, and the `quote_of` values of related records quoting
 * this field (Evidence quoting an Article's abstract), each with where it is in the text.
 */
export async function textView(deps: RecordsDeps, def: EntityTypeDef, id: string, field: string, text: string | null, actor: Actor)
  : Promise<RecordTextView> {
  const entities = deps.entities();
  const highlights: RecordQuoteHighlight[] = [];
  const add = (h: Omit<RecordQuoteHighlight, 'found' | 'start' | 'end'>) => {
    const at = text ? findQuote(h.quote, text) : undefined;
    highlights.push({ ...h, found: !!at, ...(at ? { start: at.start, end: at.end } : {}) });
  };
  if (text) {
    // ---- the record's own values, from the versions that last changed them
    const versions = await new PgRecordVersions().list(deps.pool, keyOf(def), id);
    const latest = versions.at(-1);
    const cases = new Map<string, Record<string, CaseValue>>();
    for (const name of Object.keys(def.fields)) {
      if (name === field || !latest || blank(latest.values[name])) continue;
      const v = [...versions].reverse().find((x) => x.changed.includes(name) || (x.version === 1 && !blank(x.values[name])));
      if (!v) continue;
      const quote = await quoteThroughStep(deps, cases, v, name);
      if (quote) add({ quote, field: name, kind: 'value', value: latest.values[name] });
    }
    // ---- related records quoting this field
    for (const q of quotingEntities(entities, def).filter((x) => x.text === field)) {
      const r = await withActor(deps.pool, actor, (db) => entityStore.query(db, q.def, entities, { filter: `${q.ref} = params.record`, params: { record: id }, limit: 200 }));
      for (const row of r.rows) {
        for (const [qf, of] of quoteFields(q.def)) {
          const v = row.values[qf];
          if (of.ref !== q.ref || of.field !== field || typeof v !== 'string' || !v.trim()) continue;
          add({
            quote: v, field: qf, kind: 'related',
            record: { entity: keyOf(q.def), id: row.id, title: recordTitle(q.def, row.id, row.values), ...(row.lifecycle ? { status: row.lifecycle } : {}) },
          });
        }
      }
    }
  }
  return { text, highlights };
}
