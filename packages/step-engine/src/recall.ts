/**
 * Recall tools (07 §3): "memory" for workflow steps is the step records. These are ordinary
 * `read` tools, so they go through the gateway, are journaled and can be required by a step.
 */
import type { CaseValue, StepRecord, StepRecordReader } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';

/** Recall results go back into the prompt: keep them bounded. */
const MAX_RECORD_CHARS = 12_000;
const MAX_ENTRY_CHARS = 1_500;
const MAX_SIMILAR = 10;

const plainValues = (values: Record<string, CaseValue>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));

const clipJson = (v: unknown, n: number): unknown => {
  const s = JSON.stringify(v);
  return s === undefined || s.length <= n ? v : `${s.slice(0, n)}… (truncated)`;
};

function summary(r: StepRecord) {
  return {
    stepRunId: r.stepRunId, caseId: r.caseId, stepId: r.stepId, attempt: r.attempt,
    workflow: `${r.workflowId} v${r.workflowVersion}`, status: r.status, outcome: r.outcome,
    outputs: plainValues(r.outputs), rationale: r.rationale, checkpoint: r.checkpoint,
    tainted: r.tainted, startedAt: r.startedAt, finishedAt: r.finishedAt,
  };
}

export function recallTools(reader: StepRecordReader): ToolDefinition[] {
  const stepRecord: ToolDefinition<{ step_run_id: string }> = {
    name: 'recall.step_record',
    description: 'Read the record of an earlier step run in this workflow: its outcome, outputs, rationale, checks and the calls it made.',
    inputSchema: {
      type: 'object',
      properties: { step_run_id: { type: 'string', description: 'The step run id, e.g. run_01J…/2/check.' } },
      required: ['step_run_id'],
      additionalProperties: false,
    },
    effect: 'read',
    async execute(args, ctx) {
      const r = await reader.get(args.step_run_id);
      // Other workflows' records are not this step's business.
      if (!r || r.workflowId !== ctx.token.workflowId) return { found: false };
      const out = { found: true, ...summary(r), journal: [] as unknown[], journalTruncated: false };
      let size = JSON.stringify(out).length;
      for (const e of r.journal) {
        const entry = {
          key: e.journalKey, kind: e.kind, name: e.name,
          request: clipJson(e.request, MAX_ENTRY_CHARS), response: clipJson(e.response, MAX_ENTRY_CHARS),
          ...(e.error ? { error: e.error } : {}),
        };
        size += JSON.stringify(entry).length;
        if (size > MAX_RECORD_CHARS) { out.journalTruncated = true; break; }
        out.journal.push(entry);
      }
      return out;
    },
  };

  const similarCases: ToolDefinition<{ fields?: Record<string, unknown>; limit?: number }> = {
    name: 'recall.similar_cases',
    description: 'Find how this step ended on other, similar cases: outcome, outputs and rationale for each.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Case field values to match on, e.g. { "gstin": "29AAACA1234A1Z5" }.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SIMILAR },
      },
      additionalProperties: false,
    },
    effect: 'read',
    async execute(args, ctx) {
      const limit = Math.max(1, Math.min(MAX_SIMILAR, Math.floor(args.limit ?? 5)));
      const records = await reader.similar({
        workflowId: ctx.token.workflowId, stepId: ctx.token.stepId,
        caseValues: args.fields ?? {}, excludeCaseId: ctx.token.caseId, limit,
      });
      return {
        cases: records.slice(0, limit).map((r) => ({
          stepRunId: r.stepRunId, caseId: r.caseId, outcome: r.outcome, outputs: plainValues(r.outputs), rationale: r.rationale,
        })),
      };
    },
  };

  return [stepRecord, similarCases];
}
