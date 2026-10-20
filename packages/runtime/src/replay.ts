// A recorded case as an example case that replays it (20 §5, 05 §12): its inputs, the tool
// results and model turns it got, the people's answers and approvals, and how it ended. Run on
// a draft, the replay shows where the new version would go differently or break.
import { PgCaseStore } from '@memwise/db';
import type { CaseValue, ExampleCase, ExampleSubmission, ScriptedTurn, WorkflowDef } from '@memwise/defs';
import { toolNameFromModel } from '@memwise/gateway';
import type pg from 'pg';
import { answeredBySubmit, stateKind } from './machine.ts';
import { getTransitions } from './runs.ts';
import { pathOf, type DefinitionCache } from './views.ts';

export interface Correction { step: string; outcome: string; note?: string }

const plain = (values: Record<string, CaseValue>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));
/** `case-<last 8 of the id>`: enough to tell cases apart in a folder of examples. */
export const exampleNameFor = (caseId: string) => `case-${caseId.replace(/^case_/, '').slice(-8).toLowerCase()}`;

/** Turns of one model call as the scripted provider replays them: text and dotted tool names. */
function scriptedTurn(response: unknown): ScriptedTurn | undefined {
  const content = (response as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
  // The journal keeps the provider-safe name (`gst__validate_gstin`); examples use the dotted one.
  const toolCalls = content.filter((b) => b?.type === 'toolCall')
    .map((b) => ({ name: toolNameFromModel(String(b.name)), args: (b.arguments ?? {}) as Record<string, unknown> }));
  return { ...(text ? { text } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
}

/**
 * The model's turn index within its step run, as the scripted provider counts it (the number of
 * assistant messages before the call): `model:<n>` is turn n-1; a verifier call (`verify:<n>`)
 * starts a fresh conversation, so it is always turn 0.
 */
function turnIndex(journalKey: string): number | undefined {
  const m = /^(model|verify):(\d+)$/.exec(journalKey);
  if (!m) return undefined;
  return m[1] === 'verify' ? 0 : Number(m[2]) - 1;
}

export async function caseToExample(pool: pg.Pool, defs: DefinitionCache, caseId: string, opts: { name?: string; correction?: Correction } = {}): Promise<ExampleCase> {
  const { rows: runs } = await pool.query(
    `select * from mw.runs where case_id = $1 order by created_at, id limit 1`, [caseId]);
  const run = runs[0];
  if (!run) throw new Error(`no case ${caseId}`);
  const workflow: WorkflowDef = await defs.workflow(run.workflow_id, run.workflow_hash);
  const transitions = await getTransitions(pool, run.id);
  const first = transitions[0]?.from ?? run.state;
  const history = await new PgCaseStore().history(pool, caseId);
  const current = (await new PgCaseStore().get(pool, caseId))?.values ?? {};

  const steps = (await pool.query(
    `select id, step_id, performer, status, outcome, comment, outputs, decided_by, started_at from mw.step_runs
      where run_id = $1 order by started_at, id`, [run.id])).rows;
  const correction = opts.correction;
  let from = 0; // index of the first step run the example covers
  if (correction) {
    if (!workflow.states[correction.step]) throw new Error(`${workflow.id} has no step ${correction.step}`);
    const at = steps.map((s) => s.step_id).lastIndexOf(correction.step);
    if (at < 0) throw new Error(`case ${caseId} never reached ${correction.step}`);
    from = at;
  }
  const covered = steps.slice(from);
  const coveredIds = covered.map((s) => s.id as string);

  // Case values: the inputs, or with a correction the values as they were when that step started.
  let caseValues: Record<string, unknown>;
  if (correction) {
    const startedAt = new Date(covered[0].started_at).getTime();
    caseValues = {};
    for (const e of history) if (new Date(e.at).getTime() <= startedAt) caseValues[e.field] = e.value;
  } else {
    caseValues = Object.fromEntries(history.filter((e) => e.provenance.kind === 'input').map((e) => [e.field, e.value]));
  }
  for (const [k, v] of Object.entries(caseValues)) if (v === null || v === undefined) delete caseValues[k];

  // Tool results by tool, in call order; model turns by role and turn index (first seen wins).
  const journal = coveredIds.length ? (await pool.query(
    `select j.step_run_id, j.journal_key, j.kind, j.name, j.response, j.error from mw.step_journal j join mw.step_runs s on s.id = j.step_run_id
      where j.step_run_id = any($1::text[]) and j.kind in ('tool', 'model') order by s.started_at, s.id, j.started_at, j.journal_key`,
    [coveredIds])).rows : [];
  const results: Record<string, unknown[]> = {};
  const turns: Record<string, ScriptedTurn[]> = {};
  for (const j of journal) {
    if (j.kind === 'tool') {
      const r = j.response as { status?: string; result?: unknown } | null;
      if (r?.status === 'ok') (results[j.name] ??= []).push(r.result);
    } else if (!j.error && j.response) {
      const i = turnIndex(j.journal_key);
      const turn = scriptedTurn(j.response);
      if (i === undefined || !turn) continue;
      const list = (turns[j.name] ??= []);
      if (list[i] === undefined) list[i] = turn;
    }
  }
  const tools = Object.fromEntries(Object.entries(results).map(([t, rs]) => [t, rs.length === 1 ? rs[0] : { results: rs }]));
  // A role whose turns have a gap can't be scripted from turn 0 on; keep what is contiguous.
  const model: Record<string, ScriptedTurn[]> = {};
  for (const [role, list] of Object.entries(turns)) {
    const gap = list.findIndex((t) => t === undefined);
    const kept = gap < 0 ? list : list.slice(0, gap);
    if (kept.length) model[role] = kept;
  }

  // The people's answers (and conversation steps' chats), per state in order. A step left by a
  // timer has no answer: the replay waits there, as the case did not.
  const answers: Record<string, ExampleSubmission[]> = {};
  for (const s of covered) {
    if (!answeredBySubmit(stateKindOf(workflow, s.step_id)) || s.status !== 'completed' || !s.decided_by || !s.outcome) continue;
    const values = plain((s.outputs ?? {}) as Record<string, CaseValue>);
    const isCorrected = correction && s.id === covered[0].id;
    (answers[s.step_id] ??= []).push({
      outcome: isCorrected ? correction.outcome : s.outcome,
      ...(Object.keys(values).length ? { values } : {}),
      ...(s.comment && !isCorrected ? { comment: s.comment } : {}),
    });
  }
  const submit = Object.fromEntries(Object.entries(answers).map(([state, list]) => [state, list.length === 1 ? list[0]! : list]));

  const decided = coveredIds.length ? (await pool.query(
    `select tool, status from mw.approvals where step_run_id = any($1::text[]) and status in ('approved', 'rejected') order by requested_at, id`,
    [coveredIds])).rows : [];
  const approvals: Record<string, 'approve' | 'reject'> = {};
  for (const a of decided) approvals[a.tool] ??= a.status === 'approved' ? 'approve' : 'reject';

  const name = opts.name ?? exampleNameFor(caseId);
  const label = `${workflow.title ?? workflow.id} v${workflow.version}`;
  const example: ExampleCase = {
    name,
    description: correction
      ? `From case ${caseId} (${label}): ${correction.step} should have ended ${correction.outcome}${correction.note ? `. ${correction.note}` : ''}.`
      : `Replays case ${caseId} (${label}) as it went: ${pathOf(first, transitions).join(' → ')}.`,
    ...(correction ? { startAt: correction.step } : first !== workflow.start ? { startAt: first } : {}),
    case: caseValues,
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(Object.keys(model).length ? { model } : {}),
    ...(Object.keys(approvals).length ? { approvals } : {}),
    ...(Object.keys(submit).length ? { submit } : {}),
    expect: {},
    file: `${workflow.dir}/examples/${name}.yaml`,
  };

  if (correction) {
    // Only the corrected outcome is known; where the case would have gone from there is not.
    example.expect.outcome = correction.outcome;
    return example;
  }
  const firstStep = steps.find((s) => s.step_id === first);
  if (firstStep?.outcome && workflow.steps[first]) example.expect.outcome = firstStep.outcome;
  example.expect.state = run.state;
  // Final values the steps wrote. Ids minted on the way (a Ref to a new record) differ in a replay.
  const writes: Record<string, unknown> = {};
  for (const [field, v] of Object.entries(current)) {
    if (v.provenance.kind === 'input' || isRefField(workflow, field)) continue;
    writes[field] = v.value;
  }
  if (Object.keys(writes).length) example.expect.writes = writes;
  const effects = (await pool.query(
    `select tool, count(*)::int as n from mw.effects where step_run_id like $1 and status = 'done' group by tool order by tool`,
    [`${run.id}/%`])).rows;
  if (effects.length) example.expect.effects = Object.fromEntries(effects.map((e) => [e.tool, e.n]));
  return example;
}

function stateKindOf(workflow: WorkflowDef, state: string) {
  try { return stateKind(workflow, state); } catch { return 'wait' as const; }
}

function isRefField(workflow: WorkflowDef, field: string): boolean {
  let t = workflow.caseType.fields[field]?.type;
  while (t?.kind === 'list') t = t.of;
  return t?.kind === 'ref';
}
