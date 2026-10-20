// A person answering a waiting person or external step (19 §4), or a conversation step's chat
// answering for its person (Phase 3, `via`). Checked here; applied by the driver's commit, so
// the values are written only if the outcome is accepted by the run.
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgCaseStore } from '@memwise/db';
import { validateValue, type RecordTypes, type WorkflowDef } from '@memwise/defs';
import type pg from 'pg';
import { driverIdOf } from './ids.ts';
import type { Submission, SubmissionMessage } from './driver.ts';
import type { SubmitResult, SubmitStepInput } from './types.ts';

export interface SubmitDeps {
  withTransaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T>;
  workflow(id: string, hash: string): Promise<WorkflowDef>;
  entities(): RecordTypes;
  client: DBOSClient;
}

export async function submitStep(deps: SubmitDeps, input: SubmitStepInput): Promise<SubmitResult> {
  return deps.withTransaction(async (db) => {
    const { rows } = await db.query(
      `select s.id, s.run_id, s.case_id, s.step_id, s.status, s.workflow_id, s.workflow_hash, s.assignee, r.entered_seq, r.state, r.status as run_status
         from mw.step_runs s join mw.runs r on r.id = s.run_id where s.id = $1 for update of s, r`, [input.stepRunId]);
    const s = rows[0];
    if (!s) return { applied: false, status: 'missing', message: `no step ${input.stepRunId}` };
    if (s.status !== 'waiting' || s.run_status !== 'active' || s.state !== s.step_id || !input.stepRunId.startsWith(`${s.run_id}/${s.entered_seq}/`)) {
      return { applied: false, status: 'stale', message: 'this step is no longer waiting for an answer' };
    }
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
    if (role && !input.by.roles.includes(role)) {
      return { applied: false, status: 'forbidden', message: `only someone with the ${role} role can answer this step` };
    }
    if (!step.outcomes.includes(input.outcome)) {
      return { applied: false, status: 'unknown-outcome', message: `"${input.outcome}" is not one of: ${step.outcomes.join(', ')}` };
    }

    const records: RecordTypes = { ...deps.entities(), ...workflow.caseType.types };
    const errors: Record<string, string[]> = {};
    const values = input.values ?? {};
    for (const [field, value] of Object.entries(values)) {
      const w = step.writes[field];
      if (!w) { errors[field] = ['this step does not fill in this field']; continue; }
      if (value === null || value === undefined) continue;
      const errs = validateValue(w.type, value, records);
      if (errs.length) errors[field] = errs;
    }
    const required = Object.entries(step.writes).filter(([, w]) => w.required);
    if (required.length) {
      const current = (await new PgCaseStore().get(db, s.case_id))?.values ?? {};
      for (const [field] of required) {
        const v = values[field];
        if ((v === undefined || v === null || v === '') && current[field] === undefined) (errors[field] ??= []).push('required');
      }
    }
    if (Object.keys(errors).length) return { applied: false, status: 'invalid', errors, message: 'some values need fixing' };

    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
    const submission: Submission = {
      stepRunId: input.stepRunId, by: input.by.personId, at: new Date().toISOString(), values: clean,
      ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
      ...(input.via ? { via: { chatId: input.via.chatId, ...(input.via.rationale?.trim() ? { rationale: input.via.rationale.trim() } : {}) } } : {}),
    };
    const event: SubmissionMessage = { type: input.outcome, for: s.entered_seq, by: input.by.personId, submission };
    const idemKey = `submit:${input.stepRunId}`;
    const ins = await db.query(
      `insert into mw.inbox (run_id, idem_key, event, for_seq) values ($1, $2, $3, $4) on conflict do nothing`,
      [s.run_id, idemKey, JSON.stringify(event), s.entered_seq]);
    if (!ins.rowCount) return { applied: false, status: 'stale', message: 'this step was already answered' };
    // Same database as DBOS's system schema: the message commits with the inbox row.
    await deps.client.sendInTransaction(db, driverIdOf(s.run_id), event, 'events', `${s.run_id}:${idemKey}`);
    return { applied: true, status: 'applied' };
  });
}
