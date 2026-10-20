/**
 * The output checkpoint (05 §8, 07 §8): structural checks on `step.finish`, then one verifier
 * call for the prose rules. Ported from the Conductor's verify/repair loop: a failed check is
 * fed back as repair context, a bounded number of times, instead of re-running the whole step.
 */
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { validateValue, type CaseValue, type CheckResult } from '@memwise/defs';
import { modelToolName, toolNameFromModel, type ModelRequest } from '@memwise/gateway';
import { agentWrites } from './context.ts';
import type { StepRunInput } from './types.ts';

/** A successful tool call in this step run: the evidence writes and verdicts are judged against. */
export interface Evidence {
  tool: string; callId: string; args: unknown; result: unknown;
  /** The tool reads untrusted content (quarantined): values taken from it are tainted. */
  tainted?: boolean;
}

export interface FinishArgs { outcome: string; writes: Record<string, unknown>; rationale?: string }

export interface StructuralResult {
  passed: boolean;
  checks: CheckResult[];
  /** The writes with provenance; complete only when `passed`. */
  writes: Record<string, CaseValue>;
}

const pass = (rule: string): CheckResult => ({ rule, kind: 'structural', passed: true });
const fail = (rule: string, reason: string): CheckResult => ({ rule, kind: 'structural', passed: false, reason });

// ---------------------------------------------------------------- finding values in tool results

/** Canonical JSON (sorted keys), so deep equality does not depend on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}
export const deepEqual = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** MCP tools often return JSON as text; look inside it too. */
function parsed(v: unknown): unknown {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

/** The value itself and every value nested in it, at any depth. */
function* walk(v: unknown): Generator<unknown> {
  yield v;
  const inner = parsed(v);
  if (inner !== undefined) yield* walk(inner);
  else if (Array.isArray(v)) for (const x of v) yield* walk(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* walk(x);
}

function atPath(v: unknown, path: string): unknown {
  let cur = parsed(v) ?? v;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    cur = parsed(cur) ?? cur;
  }
  return cur;
}

const isScalar = (v: unknown) => typeof v === 'boolean' || typeof v === 'number';

/**
 * The latest call of `tool` whose result holds `value`: at `field` when given, else anywhere in
 * the result. A boolean or number without `field` is too common to be evidence anywhere (any
 * `true` would match), so it must be the whole result or the result's top-level key named
 * `name` (the write's field name).
 */
export function findInResults(evidence: Evidence[], tool: string, value: unknown, field?: string, name?: string): Evidence | undefined {
  const holds = (result: unknown) => {
    if (field !== undefined) return deepEqual(atPath(result, field), value);
    if (!isScalar(value)) return [...walk(result)].some((x) => deepEqual(x, value));
    return deepEqual(parsed(result) ?? result, value) || (name !== undefined && deepEqual(atPath(result, name), value));
  };
  for (let i = evidence.length - 1; i >= 0; i--) {
    const e = evidence[i]!;
    if (e.tool === tool && holds(e.result)) return e;
  }
  return undefined;
}

/**
 * Where an extraction read a value (24 §11): a result with `fields: [{ name, value, document,
 * confidence, page, quote }]` (the quarantined reader's) says it for each field it read. Kept on
 * the write's provenance so a document review can show it and highlight the quote.
 */
export function readAt(result: unknown, field: string, value: unknown): { document?: string; confidence?: number; page?: number; quote?: string } {
  const fields = (parsed(result) as { fields?: unknown } | undefined)?.fields ?? (result as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) return {};
  const name = field.split('.').at(-1);
  const hit = fields.find((f) => f && typeof f === 'object' && (f as { name?: unknown }).name === name && deepEqual((f as { value?: unknown }).value, value)) as
    { document?: unknown; confidence?: unknown; page?: unknown; quote?: unknown } | undefined;
  if (!hit) return {};
  return {
    ...(typeof hit.document === 'string' ? { document: hit.document } : {}),
    ...(typeof hit.confidence === 'number' ? { confidence: hit.confidence } : {}),
    ...(typeof hit.page === 'number' ? { page: hit.page } : {}),
    ...(typeof hit.quote === 'string' ? { quote: hit.quote } : {}),
  };
}

// ---------------------------------------------------------------- structural checks

export function structuralChecks(
  input: StepRunInput, args: FinishArgs, evidence: Evidence[], required: string[], at: string,
): StructuralResult {
  const { step } = input;
  const checks: CheckResult[] = [];
  const writes: Record<string, CaseValue> = {};

  checks.push(step.outcomes.includes(args.outcome)
    ? pass('outcome is declared')
    : fail('outcome is declared', `"${args.outcome}" is not one of: ${step.outcomes.join(', ')}`));

  const called = new Set(evidence.map((e) => e.tool));
  const missing = required.filter((t) => !called.has(t));
  if (required.length) {
    checks.push(missing.length
      ? fail('required tools called', `not called successfully yet: ${missing.join(', ')}`)
      : pass('required tools called'));
  }

  const declared = new Map(agentWrites(step));
  // Judgement after reading untrusted content may carry it (07 §6): mark it like the content.
  const sessionTainted = input.tainted === true || evidence.some((e) => e.tainted);
  for (const field of Object.keys(args.writes).sort()) {
    if (!declared.has(field)) {
      const why = step.writes[field] ? 'is entered by a person, not by this step' : `is not one of the step's writes (${[...declared.keys()].join(', ') || 'none'})`;
      checks.push(fail(`writes.${field}: declared`, `${field} ${why}`));
    }
  }

  for (const [field, w] of declared) {
    if (!(field in args.writes)) {
      if (w.required) checks.push(fail(`writes.${field}: required`, `${field} is required`));
      continue;
    }
    const value = args.writes[field];
    const errors = validateValue(w.type, value, input.recordTypes);
    checks.push(errors.length ? fail(`writes.${field}: ${w.typeSource}`, errors.join('; ')) : pass(`writes.${field}: ${w.typeSource}`));

    if (w.from.kind === 'tool') {
      const rule = `writes.${field}: from tool ${w.from.tool}${w.from.field ? ` (${w.from.field})` : ''}`;
      const hit = findInResults(evidence, w.from.tool, value, w.from.field, field);
      if (!hit) {
        const where = w.from.field ? ` at ${w.from.field}`
          : isScalar(value) ? ` as its whole result or its \`${field}\` field (name the field with \`from: { tool, field }\`)` : '';
        checks.push(fail(rule, called.has(w.from.tool)
          ? `${JSON.stringify(value)} does not equal any value ${w.from.tool} returned${where}`
          : `${w.from.tool} was not called successfully, so ${field} has no tool result to come from`));
        continue;
      }
      checks.push(pass(rule));
      writes[field] = {
        value,
        provenance: { kind: 'tool', at, stepRunId: input.stepRunId, tool: hit.tool, callId: hit.callId, ...(hit.tainted ? { tainted: true } : {}), ...readAt(hit.result, w.from.field ?? field, value) },
      };
    } else {
      writes[field] = { value, provenance: { kind: 'judgement', at, stepRunId: input.stepRunId, rationale: args.rationale, ...(sessionTainted ? { tainted: true } : {}) } };
    }
  }

  return { passed: checks.every((c) => c.passed), checks, writes };
}

// ---------------------------------------------------------------- the verifier

export const VERDICT_TOOL = 'checkpoint.verdict';

const VERDICT_PARAMETERS = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule: { type: 'integer', description: 'The rule number, from 1.' },
          passed: { type: 'boolean' },
          reason: { type: 'string', description: 'One sentence, citing the evidence.' },
        },
        required: ['rule', 'passed'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

const VERIFIER_PROMPT = [
  "You check a workflow step's proposed result against rules written by the people who own the workflow.",
  'Judge each rule only from the proposed result and the evidence (the tool results the step saw). Do not assume facts that are not shown.',
  `Call ${VERDICT_TOOL} once, with one result for every rule.`,
].join('\n');

const MAX_EVIDENCE_CHARS = 4_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

/** A fresh, short conversation for the verifier role: rules, proposal and evidence. */
export function verifierRequest(rules: string[], args: FinishArgs, evidence: Evidence[], timestamp: number): ModelRequest {
  const text = [
    '## Rules', ...rules.map((r, i) => `${i + 1}. ${r}`),
    '', '## Proposed result',
    `outcome: ${args.outcome}`,
    `writes: ${JSON.stringify(args.writes)}`,
    `rationale: ${args.rationale ?? '(none)'}`,
    '', '## Evidence',
    ...(evidence.length
      ? evidence.map((e) => `- ${e.tool} ${JSON.stringify(e.args)} returned ${clip(JSON.stringify(e.result) ?? 'nothing', MAX_EVIDENCE_CHARS)}`)
      : ['(no tool results)']),
  ].join('\n');
  return {
    systemPrompt: VERIFIER_PROMPT,
    messages: [{ role: 'user', content: text, timestamp }],
    tools: [{ name: modelToolName(VERDICT_TOOL), description: 'Report whether each rule holds.', parameters: VERDICT_PARAMETERS }],
  };
}

/** One verifier CheckResult per rule; a reply without the verdict tool call fails every rule. */
export function parseVerdict(message: AssistantMessage, rules: string[]): CheckResult[] {
  const call = message.content.find((b) => b.type === 'toolCall' && toolNameFromModel(b.name) === VERDICT_TOOL);
  const raw = call?.type === 'toolCall' ? call.arguments.results : undefined;
  const results = Array.isArray(raw) ? raw : [];
  return rules.map((rule, i) => {
    const r = results.find((x) => x && typeof x === 'object' && Number((x as { rule?: unknown }).rule) === i + 1) as
      { passed?: unknown; reason?: unknown } | undefined;
    if (!call) return { rule, kind: 'verifier', passed: false, reason: 'the verifier gave no verdict' };
    if (!r) return { rule, kind: 'verifier', passed: false, reason: 'the verifier gave no verdict for this rule' };
    return { rule, kind: 'verifier', passed: r.passed === true, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) };
  });
}

/** Tool-result text that sends a failed checkpoint back to the agent (a repair round). */
export function repairMessage(failed: CheckResult[], roundsLeft: number): string {
  return [
    'Your result was not accepted. These checks failed:',
    ...failed.map((c) => `- ${c.rule}: ${c.reason ?? 'failed'}`),
    '',
    `Fix them and call step.finish again (${roundsLeft} ${roundsLeft === 1 ? 'try' : 'tries'} left before the step goes to a person).`,
  ].join('\n');
}
