// Extraction in the form (23 §5, D68): a component action. While an external or person step
// waits, its form may call the one `read` tool its `extract:` names, through the tool gateway
// under a component token for the waiting step run, journaled on that step run
// (`form.extract:<n>`). Each value is grounded in the document's text before it is offered.
import { validateValue, type Provenance, type RecordTypes, type StepDef, type StepToken, type WorkflowDef } from '@memwise/defs';
import { ulid, type PgFileStore, type Queryable } from '@memwise/db';
import type { ToolGateway } from '@memwise/gateway';
import { extractToolRefusal, type EffectivePolicy } from '@memwise/policy';
import { isDeepStrictEqual } from 'node:util';
import { documentText } from '../extract.ts';
import type { DocumentValue } from '../types.ts';
import { ground } from './ground.ts';
import type { StoredSuggestion } from './links.ts';
import { plainLabel } from './text.ts';

const TOKEN_TTL_MS = 10 * 60_000;

/** The token a form's own calls run under: the waiting step run, acting for the participant or person. */
export function componentToken(run: { id: string; case_id: string }, workflow: WorkflowDef, stepId: string, stepRunId: string, onBehalfOf: string, now = Date.now()): StepToken {
  return {
    runId: run.id, caseId: run.case_id, stepId, stepRunId, workflowId: workflow.id, workflowVersion: workflow.version,
    agentRole: `${workflow.id}.${stepId}.form`, onBehalfOf,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  };
}

export interface ExtractionInput {
  db: Queryable;
  tools: ToolGateway;
  files: PgFileStore;
  workflow: WorkflowDef;
  step: StepDef;
  stepRunId: string;
  run: { id: string; case_id: string };
  /** The documents to read, already checked to be ones this form may read. */
  documents: DocumentValue[];
  onBehalfOf: string;
  policy: EffectivePolicy;
  records: RecordTypes;
  /** Notes in words for a participant (true), or with the reasons, for staff. */
  forParticipant: boolean;
}

/** Reserves the next `form.extract:<n>` journal key on the step run (the entry is filled in after the call). */
async function reserveJournalKey(db: Queryable, stepRunId: string, tool: string, request: unknown): Promise<string> {
  const { rows } = await db.query(
    `select count(*)::int as n from mw.step_journal where step_run_id = $1 and journal_key like 'form.extract:%'`, [stepRunId]);
  for (let n = rows[0].n + 1; ; n++) {
    const key = `form.extract:${n}`;
    const ins = await db.query(
      `insert into mw.step_journal (step_run_id, journal_key, kind, name, call_id, request, effect, started_at)
       values ($1, $2, 'tool', $3, $2, $4, 'read', now()) on conflict do nothing`, [stepRunId, key, tool, JSON.stringify(request)]);
    if (ins.rowCount) return key;
  }
}

export async function runExtraction(x: ExtractionInput): Promise<{ suggestions: StoredSuggestion[]; notes: string[] }> {
  const def = x.step.extract!;
  const notes: string[] = [];
  const refused = extractToolRefusal(x.policy, def.tool, x.tools.bound()[def.tool]);
  if (refused) return { suggestions: [], notes: [x.forParticipant ? "Reading documents isn't available for this form; please type the answers in." : refused] };
  if (!x.documents.length) return { suggestions: [], notes: ['Upload a document first, then it can be read.'] };

  const resultNames = Object.keys(def.fields);
  const args = { documents: x.documents.map((d) => d.id), fields: resultNames };
  const token = componentToken(x.run, x.workflow, x.step.id, x.stepRunId, x.onBehalfOf);
  const key = await reserveJournalKey(x.db, x.stepRunId, def.tool, { args });
  const idempotencyKey = `${x.stepRunId}:${key}`;
  const started = Date.now();
  const decision = await x.tools.check({ tool: def.tool, args, token }, x.policy, { tainted: false });
  const result = decision.decision.verdict === 'allow'
    ? await x.tools.execute({ tool: def.tool, args, callId: key, idempotencyKey, token }, decision)
    : { status: 'denied' as const, reason: decision.decision.reason };
  const error = result.status === 'ok' ? null : result.status === 'error' ? result.error : result.reason;
  await x.db.query(
    `update mw.step_journal set request = $3, response = $4, error = $5, duration_ms = $6 where step_run_id = $1 and journal_key = $2`,
    [x.stepRunId, key, JSON.stringify({ args, idempotencyKey, onBehalfOf: x.onBehalfOf }), JSON.stringify(result), error, Date.now() - started]);
  if (result.status !== 'ok') {
    return { suggestions: [], notes: [x.forParticipant ? "The documents couldn't be read just now; please type the answers in." : `${def.tool} did not succeed: ${error}`] };
  }

  const out = result.result as { fields?: { name?: unknown; value?: unknown; document?: unknown; confidence?: unknown; quote?: unknown }[]; notes?: unknown } | null;
  if (Array.isArray(out?.notes)) for (const n of out!.notes) if (typeof n === 'string') notes.push(n);
  const texts = new Map<string, { doc: DocumentValue; text: string }>();
  const textOf = async (doc: DocumentValue) => {
    let t = texts.get(doc.id);
    if (!t) {
      const file = await x.files.read(x.db, doc.id);
      t = { doc, text: file ? documentText(file.meta.mime, file.meta.name, file.data).text : '' };
      texts.set(doc.id, t);
    }
    return t.text;
  };

  const suggestions: StoredSuggestion[] = [];
  for (const f of Array.isArray(out?.fields) ? out!.fields : []) {
    if (typeof f?.name !== 'string' || !Object.hasOwn(def.fields, f.name)) continue;
    const field = def.fields[f.name]!;
    const write = x.step.writes[field];
    if (!write || f.value === null || f.value === undefined || f.value === '') continue;
    let value = f.value;
    // Identifiers are printed with spaces and in any case; the field takes them upper-case and joined.
    if (write.type.kind === 'identifier' && typeof value === 'string') value = value.toUpperCase().replace(/[\s.-]+/g, '');
    if (validateValue(write.type, value, x.records).length) {
      notes.push(`${plainLabel(field)}: what was read (${JSON.stringify(f.value)}) doesn't look right, so it was left out.`);
      continue;
    }
    const doc = x.documents.find((d) => d.name === f.document) ?? x.documents.find((d) => d.id === f.document) ?? (x.documents.length === 1 ? x.documents[0] : undefined);
    if (!doc) continue;
    const g = ground(value, typeof f.confidence === 'number' ? f.confidence : undefined, write.type, await textOf(doc));
    suggestions.push({
      id: `sug_${ulid()}`, field, value, confidence: g.confidence, document: doc.name, documentId: doc.id,
      ...(typeof f.quote === 'string' && f.quote ? { quote: f.quote.slice(0, 500) } : {}),
      found: g.found, prefill: g.found && g.confidence >= def.minConfidence,
      tool: def.tool, callId: key, stepRunId: x.stepRunId,
    });
  }
  return { suggestions, notes };
}

/**
 * Provenance for the values a participant or person kept as a suggestion offered them (23 §5):
 * the tool's, with the document, the confidence and who confirmed it, only when the value is
 * still exactly the suggested one; a changed value is the answerer's own.
 */
export function keptProvenance(
  suggestions: StoredSuggestion[], values: Record<string, unknown>, sources: Record<string, string>, confirmedBy: string, at: string,
): Record<string, Provenance> {
  const out: Record<string, Provenance> = {};
  for (const [field, id] of Object.entries(sources)) {
    const s = suggestions.find((x) => x.id === id && x.field === field);
    if (!s || !Object.hasOwn(values, field) || !isDeepStrictEqual(values[field], s.value)) continue;
    out[field] = {
      kind: 'tool', at, stepRunId: s.stepRunId, tool: s.tool, callId: s.callId, tainted: true,
      document: s.document, confidence: s.confidence, confirmedBy, ...(s.quote ? { quote: s.quote } : {}),
    };
  }
  return out;
}
