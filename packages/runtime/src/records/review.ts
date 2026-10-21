// How a person step is reviewed (24 §11): its `review:` section, else chosen from what it reads
// and writes. A step that reads a `Ref` to a document-like record and writes fields of it is a
// document review (the record's page in review mode); a write of a list of records is a table
// review; anything else is the Phase 2 form or decision card.
import { domainOf, keyOf, resolveEntity, type EntityTypeDef, type StepDef, type ValueType, type WorkflowDef } from '@memwise/defs';
import { PgCaseStore, type Queryable } from '@memwise/db';

export type StepReview =
  | { kind: 'document'; entity: string; field: string }
  | { kind: 'table'; items: string }
  | { kind: 'diff' }
  | { kind: 'form' };

/** `case.document` → `document`. */
export const caseFieldOf = (path: string) => path.replace(/^case\./, '').split('.')[0]!;

/** The entity a case field points at (`Ref<Document>`), resolved in the workflow's domain. */
export function refTarget(workflow: WorkflowDef, field: string, entities: Record<string, EntityTypeDef>): EntityTypeDef | undefined {
  const t = workflow.caseType.fields[field]?.type;
  if (t?.kind !== 'ref') return undefined;
  return resolveEntity(entities, domainOf(workflow), t.entity);
}

/** A record a viewer can show: the `Document` entity, or one with a Document or File field. */
export function isDocumentLike(def: EntityTypeDef): boolean {
  return def.entity === 'Document' || Object.values(def.fields).some((f) => f.type.kind === 'scalar' && (f.type.name === 'Document' || f.type.name === 'File'));
}

const isRecordList = (t: ValueType) => t.kind === 'list' && (t.of.kind === 'ref' || t.of.kind === 'named');

/** The step's review, or undefined for an ordinary form or decision card. */
export function stepReview(workflow: WorkflowDef, step: StepDef, entities: Record<string, EntityTypeDef>): StepReview | undefined {
  if (step.performer !== 'person') return undefined;
  const r = step.review;
  if (r?.kind === 'document') {
    const field = caseFieldOf(r.record);
    const def = refTarget(workflow, field, entities);
    return def ? { kind: 'document', entity: keyOf(def), field } : undefined;
  }
  if (r) return r.kind === 'table' ? { kind: 'table', items: caseFieldOf(r.items) } : r;
  // Inferred: a document-like record it reads and whose fields it writes.
  const writes = Object.keys(step.writes);
  for (const read of step.reads) {
    const field = caseFieldOf(read);
    const def = refTarget(workflow, field, entities);
    if (def && isDocumentLike(def) && writes.some((w) => w in def.fields)) return { kind: 'document', entity: keyOf(def), field };
  }
  const list = Object.entries(step.writes).find(([, w]) => isRecordList(w.type));
  return list ? { kind: 'table', items: list[0] } : undefined;
}

/** An input or decision inbox item's `review` (InboxItem in types.ts). */
export type InboxReview = { kind: 'document'; entity: string; recordId?: string } | { kind: 'table'; items: string } | { kind: 'diff' } | { kind: 'form' };

/** The inbox item's `review`, with the record the case points at now. */
export async function inboxReview(db: Queryable, workflow: WorkflowDef, step: StepDef, caseId: string, entities: Record<string, EntityTypeDef>): Promise<InboxReview | undefined> {
  const review = stepReview(workflow, step, entities);
  if (review?.kind !== 'document') return review;
  const value = (await new PgCaseStore().get(db, caseId))?.values[review.field]?.value;
  return { kind: 'document', entity: review.entity, ...(typeof value === 'string' ? { recordId: value } : {}) };
}
