// Lifecycle transitions (24 §4, D74): who may make one, from which state, its guard, and the
// signature a signed transition needs. One check serves the entity tools (a step), the record
// page (a person) and the kernel itself, so every route refuses the same things in the same words.
import { evaluateCondition, PgEntityStore, PgSignatureStore, type Queryable } from '@memwise/db';
import { hasRole, keyOf, rolesIn, type EntityTypeDef, type LifecycleDef, type LifecycleTransitionDef, type ProjectDefs } from '@memwise/defs';
import { recordContentHash } from '../regulated/content.ts';
import type { PersonActor, RecordWriteResult } from '../types.ts';
import { domainOfEntity, plainValues } from './context.ts';

/** Who is making the transition. A step may act for a person (its token's `onBehalfOf`). */
export type Mover =
  | { kind: 'step'; caseId: string; person?: PersonActor }
  | { kind: 'person'; actor: PersonActor }
  | { kind: 'source'; source: string }
  | { kind: 'system' };

export type TransitionCheck =
  | { ok: true; from: string | undefined; to: string; transition: LifecycleTransitionDef }
  | { ok: false; status: RecordWriteResult['status']; message: string };

const entityStore = new PgEntityStore();
const signatures = new PgSignatureStore();

/** "a playbook step, someone with the study_manager role or the edc domain" */
function describeBy(t: LifecycleTransitionDef, chart: LifecycleDef): string {
  if (chart.fromList) return 'anyone with a role here';
  const parts = t.by.map((b) => b.kind === 'step' ? 'a playbook step' : b.kind === 'role' ? `someone with the ${b.role} role`
    : b.kind === 'source' ? `the ${b.source.replace(/^domain:/, '')} ${b.source.startsWith('domain:') ? 'domain' : 'connector'}` : 'MemWise itself');
  return parts.length ? parts.join(' or ') : 'nobody';
}

/** Whether `mover` is one of the transition's `by` (24 §4). */
export function mayMove(t: LifecycleTransitionDef, chart: LifecycleDef, mover: Mover, domain: string): boolean {
  if (mover.kind === 'system' && (chart.fromList || t.by.some((b) => b.kind === 'system'))) return true;
  // The list form: any role may move along it (and any step, as before).
  if (chart.fromList) {
    if (mover.kind === 'step') return true;
    if (mover.kind === 'person') return rolesIn(mover.actor, domain).length > 0;
    return false;
  }
  for (const b of t.by) {
    if (b.kind === 'step' && mover.kind === 'step') return true;
    if (b.kind === 'role') {
      if (mover.kind === 'person' && hasRole(mover.actor, b.role, domain)) return true;
      if (mover.kind === 'step' && mover.person && hasRole(mover.person, b.role, domain)) return true;
    }
    if (b.kind === 'source' && mover.kind === 'source' && (b.source === mover.source || b.source === `domain:${mover.source}`)) return true;
  }
  return false;
}

/** The transitions out of `state`, by name → target. */
export const transitionsFrom = (chart: LifecycleDef, state: string | undefined): Record<string, string> =>
  chart.states[state ?? chart.initial]?.on ?? {};

/**
 * Checks a transition of one record under `db`'s actor (the guard reads `domain_read`, so it sees
 * what the actor may see). `regulatedProject` decides whether `signed:` applies.
 */
export async function checkTransition(
  db: Queryable, def: EntityTypeDef, entities: Record<string, EntityTypeDef>, project: ProjectDefs | undefined,
  input: { id: string; transition: string }, mover: Mover,
): Promise<TransitionCheck> {
  const chart = def.lifecycleChart;
  if (!chart) return { ok: false, status: 'invalid', message: `a ${def.entity} has no lifecycle to move along` };
  const row = await entityStore.get(db, def, input.id);
  if (!row) return { ok: false, status: 'missing', message: `there is no ${def.entity} ${input.id}` };
  const from = row.lifecycle ?? undefined;
  const t = chart.transitions[input.transition];
  if (!t) {
    return { ok: false, status: 'invalid', message: `"${input.transition}" is not a transition of ${def.entity} (it has ${Object.keys(chart.transitions).join(', ') || 'none'})` };
  }
  const out = transitionsFrom(chart, from);
  const to = out[input.transition];
  if (!to) {
    const can = Object.keys(out);
    return { ok: false, status: 'invalid', message: `a ${def.entity} that is ${from ?? 'new'} can't be "${input.transition}"; from ${from ?? 'there'} it can ${can.length ? `be ${can.join(', ')}` : 'not move on'}` };
  }
  const domain = domainOfEntity(def);
  if (!mayMove(t, chart, mover, domain)) {
    return { ok: false, status: 'forbidden', message: `only ${describeBy(t, chart)} can move a ${def.entity} to ${to.replace(/_/g, ' ')} ("${input.transition}")` };
  }
  if (t.guard) {
    const g = await evaluateCondition(db, def, entities, input.id, t.guard);
    if (!g.holds) {
      return { ok: false, status: 'guard', message: `"${input.transition}" needs ${t.guard}; now ${plainValues(g.values) || 'it does not hold'}` };
    }
  }
  if (t.signed) {
    const sig = await matchingSignature(db, def, input.id, row.values, mover.kind === 'step' ? mover.caseId : undefined);
    if (!sig) {
      return {
        ok: false, status: 'signature-required',
        message: `"${input.transition}" needs a signature on this ${def.entity} that matches it as it is now${mover.kind === 'step' ? ', made in this case' : ''}; sign it in a person step first`,
      };
    }
  }
  return { ok: true, from, to, transition: t };
}

/** A signature on the record (in `caseId`, when given) whose content hash matches the record now. */
export async function matchingSignature(db: Queryable, def: EntityTypeDef, recordId: string, values: Record<string, unknown>, caseId?: string) {
  const { hash } = recordContentHash(def, recordId, values);
  const all = await signatures.forRecord(db, keyOf(def), recordId);
  return all.find((s) => s.contentHash === hash && (!caseId || s.caseId === caseId));
}
