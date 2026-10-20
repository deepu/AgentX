/** `policy.yaml` (domain and workflow layers) and the `policy:` block of a step. */
import { policyFormat } from './formats.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, Reporter, type ParseResult } from './source.ts';
import { EFFECT_CLASSES, TREATMENTS, type EffectClass, type Money, type PolicyDoc, type Treatment } from './types.ts';
import { parseCount, parseDuration, parseRate } from './value-types.ts';

const isTreatment = (v: unknown): v is Treatment => (TREATMENTS as readonly unknown[]).includes(v);
const list = (v: unknown) => (Array.isArray(v) ? asStrings(v) : undefined);
const num = (v: unknown, parse: (s: string | number) => number | undefined) =>
  typeof v === 'string' || typeof v === 'number' ? parse(v) : undefined;

/**
 * Turns an already format-checked policy object into a PolicyDoc. Values the format check
 * rejected are left out rather than reported twice.
 */
export function toPolicyDoc(raw: unknown, file?: string): PolicyDoc {
  const data = asRecord(raw);

  let effects: PolicyDoc['effects'];
  if (isRecord(data.effects)) {
    effects = {};
    for (const c of EFFECT_CLASSES) {
      const t = data.effects[c];
      if (isTreatment(t)) effects[c as EffectClass] = t;
    }
  }

  let tools: PolicyDoc['tools'];
  if (isRecord(data.tools)) {
    let rules: NonNullable<PolicyDoc['tools']>['rules'];
    if (isRecord(data.tools.rules)) {
      rules = {};
      for (const [tool, rule] of Object.entries(data.tools.rules)) {
        const r = asRecord(rule);
        rules[tool] = compact({
          treatment: isTreatment(r.treatment) ? r.treatment : undefined,
          rateLimit: typeof r.rateLimit === 'string' ? parseRate(r.rateLimit) : undefined,
        });
      }
    }
    tools = compact({ allow: list(data.tools.allow), deny: list(data.tools.deny), require: list(data.tools.require), rules });
  }

  let budgets: PolicyDoc['budgets'];
  if (isRecord(data.budgets)) {
    const b = data.budgets;
    const money = isRecord(b.money) && typeof b.money.amount === 'number' && typeof b.money.currency === 'string'
      ? { amount: b.money.amount, currency: b.money.currency } satisfies Money
      : undefined;
    budgets = compact({ tokens: num(b.tokens, parseCount), timeMs: num(b.time, parseDuration), modelCalls: num(b.modelCalls, parseCount), money });
  }

  const taint = isRecord(data.taint)
    ? compact({
        enabled: typeof data.taint.enabled === 'boolean' ? data.taint.enabled : undefined,
        outboundWhenTainted: isTreatment(data.taint.outboundWhenTainted) ? data.taint.outboundWhenTainted : undefined,
      })
    : undefined;

  const approvals = isRecord(data.approvals) ? compact({ by: list(data.approvals.by) }) : undefined;

  return compact({ name: asString(data.policy), effects, tools, budgets, modelRoles: list(data.modelRoles), taint, approvals, file });
}

export function parsePolicyFile(text: string, file: string): ParseResult<PolicyDoc> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  // An empty policy file is fine: it inherits everything.
  if (src.data === null || src.data === undefined) {
    return { value: src.diagnostics.length ? undefined : { file }, diagnostics: report.diagnostics };
  }
  if (!isRecord(src.data)) {
    report.error('invalid-format', 'expected a policy: effects, tools, budgets, modelRoles, taint');
    return { diagnostics: report.diagnostics };
  }
  report.validate(policyFormat, src.data);
  return { value: toPolicyDoc(src.data, file), diagnostics: report.diagnostics };
}

/** Milliseconds in the largest unit that divides them: 86400000 → `1d`, 90000 → `90s`. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [['w', 604_800_000], ['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/**
 * A PolicyDoc back as the YAML it is written in (`rateLimit: 30/min`, `time: 10m`), for files
 * MemWise writes itself (plugin manifests, bindings). `toPolicyDoc(policyToRaw(p))` gives `p`
 * back, apart from `file`.
 */
export function policyToRaw(doc: PolicyDoc): Record<string, unknown> {
  const rules = doc.tools?.rules
    ? Object.fromEntries(Object.entries(doc.tools.rules).map(([tool, r]) => [tool, compact({
        treatment: r.treatment,
        rateLimit: r.rateLimit ? `${r.rateLimit.count}/${r.rateLimit.perMs === 60_000 ? 'min' : formatDuration(r.rateLimit.perMs)}` : undefined,
      })]))
    : undefined;
  const tools = doc.tools ? compact({ allow: doc.tools.allow, deny: doc.tools.deny, require: doc.tools.require, rules }) : undefined;
  const b = doc.budgets;
  const budgets = b ? compact({ tokens: b.tokens, time: b.timeMs !== undefined ? formatDuration(b.timeMs) : undefined, modelCalls: b.modelCalls, money: b.money }) : undefined;
  return compact({
    policy: doc.name, effects: doc.effects, tools, budgets, modelRoles: doc.modelRoles, taint: doc.taint, approvals: doc.approvals,
  }) as Record<string, unknown>;
}
