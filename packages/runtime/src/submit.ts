// A person answering a waiting person or external step (19 §4), a conversation step's chat
// answering for its person (Phase 3, `via`), or an outside participant through a link (Phase 5,
// external.ts). Checked here; applied by the driver's commit, so the values are written only if
// the outcome is accepted by the run.
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgCaseStore, type Queryable } from '@memwise/db';
import { domainOf, hasRole, scopedEntities, seesProjectIn, validateValue, type EntityTypeDef, type Provenance, type RecordTypes, type StepDef, type WorkflowDef } from '@memwise/defs';
import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { driverIdOf } from './ids.ts';
import type { Submission, SubmissionMessage } from './driver.ts';
import { storeMentions } from './records/context.ts';
import { checkSignature, signingStep, writeSignature, type SigningDeps } from './regulated/signatures.ts';
import { CHANGE_PLAYBOOK, type SubmitResult, type SubmitStepInput } from './types.ts';

export interface SubmitDeps {
  withTransaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T>;
  workflow(id: string, hash: string): Promise<WorkflowDef>;
  entities(): RecordTypes;
  client: DBOSClient;
  /**
   * Phase 5: provenance for values a person kept as the step's extraction suggested them
   * (`sources`), read in the submitting transaction; absent: every value is the person's.
   */
  sourcedProvenance?(db: pg.PoolClient, stepRunId: string, values: Record<string, unknown>, sources: Record<string, string>, by: string):
    Promise<Record<string, Provenance>>;
  /** Phase 6: e-signatures for steps with `sign:` (24 §9); absent: such a step can't be answered. */
  signing?: SigningDeps;
  /**
   * Who may answer beyond the step's role (a page's answer change: only its reviewers), read in
   * the submitting transaction; a message refuses the answer. Absent: the role decides.
   */
  mayAnswer?(db: pg.PoolClient, s: WaitingStep, by: SubmitStepInput['by'], outcome: string): Promise<string | undefined>;
}

/** The waiting step run and its run, locked for the answer. */
export interface WaitingStep {
  id: string;
  run_id: string;
  case_id: string;
  step_id: string;
  workflow_id: string;
  workflow_hash: string;
  assignee: string | null;
  entered_seq: number;
  /** Stage 3: the run's project. */
  project?: string | null;
  /** Every app that project runs (D105). */
  project_apps?: string[] | null;
}

/**
 * Locks the step run and its run and checks the step still waits for an answer: the run is
 * active, in this step's state, on the entry the step run belongs to.
 */
export async function lockWaitingStep(db: pg.PoolClient, stepRunId: string): Promise<WaitingStep | SubmitResult> {
  const { rows } = await db.query(
    `select s.id, s.run_id, s.case_id, s.step_id, s.status, s.workflow_id, s.workflow_hash, s.assignee, r.entered_seq, r.state, r.status as run_status, r.project, mw.project_apps(r.project) as project_apps
       from mw.step_runs s join mw.runs r on r.id = s.run_id where s.id = $1 for update of s, r`, [stepRunId]);
  const s = rows[0];
  if (!s) return { applied: false, status: 'missing', message: `no step ${stepRunId}` };
  if (s.status !== 'waiting' || s.run_status !== 'active' || s.state !== s.step_id || !stepRunId.startsWith(`${s.run_id}/${s.entered_seq}/`)) {
    return { applied: false, status: 'stale', message: 'this step is no longer waiting for an answer' };
  }
  return s;
}

/**
 * Field -> problems for an answer to `step`: only its writes, each of its type, and every
 * required write either given or already on the case.
 */
export async function answerErrors(db: pg.PoolClient, step: StepDef, caseId: string, values: Record<string, unknown>, records: RecordTypes): Promise<Record<string, string[]>> {
  const errors: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(values)) {
    const w = step.writes[field];
    if (!w) { errors[field] = ['this step does not fill in this field']; continue; }
    if (value === null || value === undefined) continue;
    const errs = validateValue(w.type, value, records);
    if (errs.length) errors[field] = errs;
  }
  const required = Object.entries(step.writes).filter(([, w]) => w.required);
  if (required.length) {
    const current = (await new PgCaseStore().get(db, caseId))?.values ?? {};
    for (const [field] of required) {
      const v = values[field];
      if ((v === undefined || v === null || v === '') && current[field] === undefined) (errors[field] ??= []).push('required');
    }
  }
  return errors;
}

/**
 * Queues the answer as the run's event, the submission beside it, in the caller's transaction:
 * the inbox row and the DBOS message commit together. False when the step was already answered.
 */
export async function queueSubmission(db: pg.PoolClient, client: DBOSClient, s: WaitingStep, outcome: string, submission: Submission): Promise<boolean> {
  const event: SubmissionMessage = { type: outcome, for: s.entered_seq, by: submission.by, submission };
  const idemKey = `submit:${s.id}`;
  const ins = await db.query(
    `insert into mw.inbox (run_id, idem_key, event, for_seq) values ($1, $2, $3, $4) on conflict do nothing`,
    [s.run_id, idemKey, JSON.stringify(event), s.entered_seq]);
  if (!ins.rowCount) return false;
  // Same database as DBOS's system schema: the message commits with the inbox row.
  await client.sendInTransaction(db, driverIdOf(s.run_id), event, 'events', `${s.run_id}:${idemKey}`);
  return true;
}

/**
 * The step's open links can't be used any more once it is answered (23 §3): `usedLinkId` is the
 * one that answered it; the others close as `answered`.
 */
export async function closeStepLinks(db: Queryable, runId: string, stepId: string, reason: 'answered' | 'left', usedLinkId?: string) {
  if (usedLinkId) {
    await db.query(`update mw.external_links set used_at = now() where id = $1 and used_at is null`, [usedLinkId]);
  }
  await db.query(
    `update mw.external_links set closed_at = now(), closed_reason = $3
      where kind = 'step' and run_id = $1 and step_id = $2 and used_at is null and closed_at is null`, [runId, stepId, reason]);
}

/**
 * The record types a workflow's values are checked against: its domain's entities by bare name,
 * every other one by key (24 §2), and its case file's own `types:`.
 */
export const recordTypesFor = (entities: RecordTypes, workflow: WorkflowDef): RecordTypes =>
  ({ ...scopedEntities(entities as Record<string, EntityTypeDef>, domainOf(workflow)), ...workflow.caseType.types });

/** Values with nothing in them left out (a cleared field is not written). */
export const cleanValues = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));

/** submitStep, plus how the answer came in when not through the app (an inbox link: `email`, `whatsapp`). */
export async function submitStep(deps: SubmitDeps, input: SubmitStepInput, opts: { channel?: string } = {}): Promise<SubmitResult> {
  return deps.withTransaction(async (db) => {
    const s = await lockWaitingStep(db, input.stepRunId);
    if ('applied' in s) return s;
    const workflow = await deps.workflow(s.workflow_id, s.workflow_hash);
    const step = workflow.steps[s.step_id];
    const conversation = step?.performer === 'agent' && step.engine === 'open';
    if (!step || (step.performer !== 'person' && step.performer !== 'external' && !conversation)) {
      return { applied: false, status: 'stale', message: 'this step is not answered by a person' };
    }
    // A conversation is ended by its chat, never by a form; a form step never by a chat.
    if (conversation && !input.via) {
      return { applied: false, status: 'forbidden', message: 'this step is a conversation: it is answered from its chat' };
    }
    if (!conversation && input.via) {
      return { applied: false, status: 'forbidden', message: 'this step is answered by a person, not from a chat' };
    }
    if (input.via && !input.via.chatId?.trim()) {
      return { applied: false, status: 'invalid', errors: { via: ['the chat id is missing'] }, message: 'some values need fixing' };
    }
    const role = step.assignee ?? s.assignee ?? undefined;
    // Stage 3: the role held in the run's project (a grant in another study doesn't answer this one).
    if (input.by.kind === 'person' && s.project && !seesProjectIn(input.by, s.project_apps?.length ? s.project_apps : [domainOf(workflow)], s.project)) {
      return { applied: false, status: 'forbidden', message: 'this step belongs to a project you are not in' };
    }
    if (role && !hasRole(input.by, role, domainOf(workflow), s.project ?? undefined)) {
      return { applied: false, status: 'forbidden', message: `only someone with the ${role} role can answer this step` };
    }
    if (!step.outcomes.includes(input.outcome)) {
      return { applied: false, status: 'unknown-outcome', message: `"${input.outcome}" is not one of: ${step.outcomes.join(', ')}` };
    }
    const refusal = await deps.mayAnswer?.(db, s, input.by, input.outcome);
    if (refusal) return { applied: false, status: 'forbidden', message: refusal };

    const values = input.values ?? {};
    const errors = await answerErrors(db, step, s.case_id, values, recordTypesFor(deps.entities(), workflow));
    if (Object.keys(errors).length) return { applied: false, status: 'invalid', errors, message: 'some values need fixing' };

    // Phase 6: a signed step needs the person's password; checked before anything is queued.
    const signed = workflow.id === CHANGE_PLAYBOOK
      ? signingStep(deps.signing, workflow, step, input.outcome, (await new PgCaseStore().get(db, s.case_id))?.values ?? {})
      : step;
    if (signed.sign) {
      if (!deps.signing) return { applied: false, status: 'forbidden', message: 'signing is not available here' };
      const refused = await checkSignature(deps.signing, signed, input.by, input.signature, input.stepRunId);
      if (refused) return refused;
    }

    const clean = cleanValues(values);
    const provenance = input.sources && Object.keys(input.sources).length && deps.sourcedProvenance
      ? await deps.sourcedProvenance(db, input.stepRunId, clean, input.sources, input.by.personId)
      : {};
    // A value sent back as the case already has it (a review screen sends every value) keeps where
    // it came from; only what the person changed or added is theirs, as for external answers (D68).
    if (!input.via) {
      const had = (await new PgCaseStore().get(db, s.case_id))?.values ?? {};
      for (const [field, v] of Object.entries(clean)) {
        const h = had[field];
        if (!provenance[field] && h?.provenance && isDeepStrictEqual(h.value, v)) provenance[field] = h.provenance;
      }
    }
    const submission: Submission = {
      stepRunId: input.stepRunId, by: input.by.personId, at: new Date().toISOString(), values: clean,
      ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
      ...(input.via ? { via: { chatId: input.via.chatId, ...(input.via.rationale?.trim() ? { rationale: input.via.rationale.trim() } : {}) } } : {}),
      ...(Object.keys(provenance).length ? { provenance } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
    };
    if (!(await queueSubmission(db, deps.client, s, input.outcome, submission))) {
      return { applied: false, status: 'stale', message: 'this step was already answered' };
    }
    if (signed.sign && deps.signing) {
      const current = (await new PgCaseStore().get(db, s.case_id))?.values ?? {};
      await writeSignature(db, deps.signing, { workflow, step: signed, stepRunId: input.stepRunId, caseId: s.case_id, by: input.by, values: clean, caseValues: current });
    }
    // Phase 6: records the comment mentions (`[[qa.Report:repo_…]]`) are "mentioned in" it.
    if (submission.comment?.includes('[[')) {
      await storeMentions(db, deps.entities() as Record<string, EntityTypeDef>, { kind: 'comment', id: input.stepRunId, label: `${step.title ?? step.id} (${workflow.title ?? workflow.id})`, caseId: s.case_id }, submission.comment);
    }
    // Staff answered it themselves: links sent to the client for it can't be used any more.
    if (step.performer === 'external') await closeStepLinks(db, s.run_id, s.step_id, 'answered');
    return { applied: true, status: 'applied' };
  });
}
