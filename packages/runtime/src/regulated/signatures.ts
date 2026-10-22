// E-signatures on person steps (24 §9, D77): a step with `sign:` is answered only with the
// person's password. Every attempt is logged; five wrong passwords in 15 minutes lock signing for
// 30 minutes. A right one writes the signature in the transaction that accepts the answer: who,
// when (server time), the meaning, and the content hash of the record it covers, as the record
// will be once the step's values are on it. Agents never sign: no tool signs, and only a person
// step can be signed.
import { contentHash, PgEntityStore, PgSignatureStore, withRecordContext, type PgPeopleStore, type Queryable } from '@memwise/db';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_DOMAIN, keyOf, type EntityTypeDef, type ProjectDefs, type StepDef, type WorkflowDef } from '@memwise/defs';
import { caseFieldOf, isDocumentLike, refTarget, stepReview } from '../records/review.ts';
import { CHANGE_PLAYBOOK, type PersonActor, type SignatureInput, type SubmitResult } from '../types.ts';
import { recordContentHash } from './content.ts';

export const SIGN_FAILURES_BEFORE_LOCK = 5;
export const SIGN_FAILURE_WINDOW_MS = 15 * 60_000;
export const SIGN_LOCK_MS = 30 * 60_000;

export interface SigningDeps {
  people: PgPeopleStore;
  entities(): Record<string, EntityTypeDef>;
  /** The live project (domains, workflows), for the regulated playbook review. */
  project?(): ProjectDefs | undefined;
}

/** What signing the review of a change to a regulated domain's playbook means. */
export const PLAYBOOK_REVIEW_MEANING = 'Reviewed and approved this playbook change for use';

/** Whether a live playbook belongs to a regulated domain (its changes go live only signed, 24 §9). */
export function isRegulatedPlaybook(project: ProjectDefs | undefined, workflowId: string | undefined): boolean {
  const wf = workflowId ? project?.workflows[workflowId] : undefined;
  return !!wf && !!project?.domains?.[wf.domain ?? DEFAULT_DOMAIN]?.regulated;
}

/**
 * The step as it must be signed: its own `sign:`, or (24 §9) the approving review of
 * change-playbook when the playbook it changes is in a regulated domain.
 */
export function signingStep(deps: SigningDeps | undefined, workflow: WorkflowDef, step: StepDef, outcome: string,
  caseValues: Record<string, { value: unknown }>): StepDef {
  if (step.sign || workflow.id !== CHANGE_PLAYBOOK || step.performer !== 'person' || outcome !== 'approved') return step;
  const playbook = caseValues.playbook?.value;
  return isRegulatedPlaybook(deps?.project?.(), typeof playbook === 'string' ? playbook : undefined) ? { ...step, sign: PLAYBOOK_REVIEW_MEANING } : step;
}

/** The record a signed step covers: its review record, else its first read of a document-like record. */
export function signedRecordField(workflow: WorkflowDef, step: StepDef, entities: Record<string, EntityTypeDef>): { field: string; def: EntityTypeDef } | undefined {
  const review = stepReview(workflow, step, entities);
  if (review?.kind === 'document') {
    const def = refTarget(workflow, review.field, entities);
    if (def) return { field: review.field, def };
  }
  for (const read of step.reads) {
    const field = caseFieldOf(read);
    const def = refTarget(workflow, field, entities);
    if (def && isDocumentLike(def)) return { field, def };
  }
  return undefined;
}

const time = (iso: string) => new Date(iso).toISOString().slice(11, 16);

/**
 * Checks the signature of an answer to a signed step: undefined when the step isn't signed or
 * the password is right (then call `writeSignature` once the answer is queued); else the refusal.
 */
export async function checkSignature(deps: SigningDeps, step: StepDef, by: PersonActor, signature: SignatureInput | undefined, stepRunId: string): Promise<SubmitResult | undefined> {
  if (!step.sign) return undefined;
  if (step.performer !== 'person') {
    return { applied: false, status: 'forbidden', message: 'only a person can sign; this step is answered another way' };
  }
  return checkSigningPassword(deps.people, by, signature, step.sign, { stepRunId });
}

/**
 * Checks a signing password (any signature: a step's, a change request's): undefined when it is
 * right, else the refusal. Every wrong one is logged; too many lock signing (24 §9).
 */
export async function checkSigningPassword(people: PgPeopleStore, by: PersonActor, signature: SignatureInput | undefined, meaning: string,
  detail: Record<string, unknown>): Promise<SubmitResult | undefined> {
  if (!(await people.hasPassword(by.personId))) {
    return { applied: false, status: 'password-not-set', message: 'you have no password to sign with yet: choose one, then sign' };
  }
  if (!signature?.password) {
    return { applied: false, status: 'signature-required', message: `this needs your signature ("${meaning}"): enter your password to sign` };
  }
  const now = Date.now();
  const lock = await people.lockState(by.personId);
  if (lock.lockedUntil && new Date(lock.lockedUntil).getTime() > now) {
    return { applied: false, status: 'locked', message: `signing is locked after too many wrong passwords; try again after ${time(lock.lockedUntil)} (server time, UTC)` };
  }
  const person = await people.get(by.personId);
  const ok = person ? await people.verifyPassword(person.email, signature.password) : undefined;
  if (!ok || ok.id !== by.personId) {
    await people.recordAuthEvent(by.personId, 'signature-failed', detail);
    const after = await people.lockState(by.personId);
    if (after.recentFailures >= SIGN_FAILURES_BEFORE_LOCK) {
      const until = new Date(now + SIGN_LOCK_MS).toISOString();
      await people.recordAuthEvent(by.personId, 'locked', { ...detail, until, failures: after.recentFailures });
      return { applied: false, status: 'signature-failed', message: `that password is not right; after ${after.recentFailures} wrong passwords signing is locked until ${time(until)} (server time, UTC)` };
    }
    return { applied: false, status: 'signature-failed', message: `that password is not right (${after.recentFailures} of ${SIGN_FAILURES_BEFORE_LOCK} tries before signing locks)` };
  }
  return undefined;
}

/**
 * Writes the signature of an accepted answer, in the caller's transaction. It covers the step's
 * record as it will be: its values now with the answer's values for fields of that entity (by
 * name) on top. A step without such a record signs the case's answer itself (entity `case`).
 */
export async function writeSignature(db: Queryable, deps: SigningDeps, input: {
  workflow: WorkflowDef; step: StepDef; stepRunId: string; caseId: string; by: PersonActor; values: Record<string, unknown>;
  caseValues: Record<string, { value: unknown }>;
}): Promise<string | undefined> {
  const { workflow, step } = input;
  if (!step.sign) return undefined;
  const person = await deps.people.get(input.by.personId);
  const covered = signedRecordField(workflow, step, deps.entities());
  const recordId = covered ? (input.values[covered.field] ?? input.caseValues[covered.field]?.value) : undefined;
  let entity = 'case';
  let target = input.caseId;
  let hash: { hash: string; manifest: Record<string, unknown> };
  if (covered && typeof recordId === 'string') {
    const store = new PgEntityStore();
    const row = await store.get(db, covered.def, recordId);
    const merged: Record<string, unknown> = { ...(row?.values ?? {}) };
    const corrected: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.values)) {
      if (!(k in covered.def.fields)) continue;
      merged[k] = v;
      if (row && !isDeepStrictEqual(row.values[k] ?? null, v ?? null)) corrected[k] = v;
    }
    // What the person corrected while reviewing goes onto the record now, in the same transaction,
    // so the record is what they signed (a later signed transition checks it against the record).
    if (row && Object.keys(corrected).length) {
      const reason = `corrected at review, signed "${step.sign}"`;
      await withRecordContext(db, { by: input.by.personId, via: input.stepRunId, reason });
      await store.update(db, covered.def, recordId, corrected, { reason });
      await withRecordContext(db, { by: undefined, via: undefined, reason: undefined });
    }
    entity = keyOf(covered.def);
    target = recordId;
    hash = recordContentHash(covered.def, recordId, merged);
  } else {
    const manifest = { entity: 'case', recordId: input.caseId, values: input.values };
    hash = { hash: contentHash(manifest), manifest };
  }
  const id = await new PgSignatureStore().add(db, {
    stepRunId: input.stepRunId, caseId: input.caseId, personId: input.by.personId, name: person?.name ?? input.by.personId,
    meaning: step.sign, entity, recordId: target, contentHash: hash.hash, manifest: hash.manifest,
  });
  await deps.people.recordAuthEvent(input.by.personId, 'signature-ok', { stepRunId: input.stepRunId, signatureId: id }, db);
  return id;
}
