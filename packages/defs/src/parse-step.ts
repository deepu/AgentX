/** `steps/<state>.md`: YAML front matter, then the instructions in Markdown. */
import { basename } from 'node:path';
import { stepFormat } from './formats.ts';
import { toPolicyDoc } from './parse-policy.ts';
import { typeAt } from './parse-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, sha256, type ParseResult } from './source.ts';
import type { ReviewDef } from './domain-types.ts';
import type { ArgSource, ExtractDef, Performer, StepDef, StepEngine, Strictness, WriteDef, WriteSource } from './types.ts';
import { parseCount, parseDuration } from './value-types.ts';

const PERFORMERS: Performer[] = ['agent', 'person', 'external', 'system'];
const STRICTNESS: Strictness[] = ['strict', 'guided', 'open'];
const ENGINES: StepEngine[] = ['step', 'open'];

/** Splits `---\n<yaml>\n---\n<body>`. Returns undefined when the file has no front matter. */
export function splitFrontMatter(text: string): { yaml: string; body: string } | undefined {
  const m = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return m ? { yaml: m[1] ?? '', body: m[2]! } : undefined;
}

/** `judgement`, `person`, `tool gst.validate_gstin`, or `{ tool, field }`. */
function writeSource(raw: unknown, performer: Performer): WriteSource {
  if (isRecord(raw) && typeof raw.tool === 'string') return compact({ kind: 'tool', tool: raw.tool, field: asString(raw.field) });
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === 'judgement' || s === 'person') return { kind: s };
    const m = /^tool\s+(\S+)$/.exec(s);
    if (m) return { kind: 'tool', tool: m[1]! };
  }
  // Agents judge; people (and outside participants) type the value in.
  return performer === 'person' || performer === 'external' ? { kind: 'person' } : { kind: 'judgement' };
}

/**
 * `case.client_name` reads the case; `item.<path>` (or `item`) the item of an `each:` call;
 * `{ today: 7 }` a date and `{ now: true }` the time (25 §3); `{ value: x }` or anything else
 * is a literal.
 */
export function argSource(raw: unknown): ArgSource {
  if (typeof raw === 'string' && /^case\.[A-Za-z_][\w.]*$/.test(raw.trim())) return { case: raw.trim().slice(5) };
  if (typeof raw === 'string' && /^item(\.[A-Za-z_][\w.]*)?$/.test(raw.trim())) return { item: raw.trim().slice(5) };
  if (isRecord(raw) && Object.keys(raw).length === 1) {
    if ('value' in raw) return { value: raw.value };
    if (typeof raw.today === 'number' && Number.isInteger(raw.today)) return { today: raw.today };
    if (raw.now === true) return { now: true };
  }
  return { value: raw };
}

/** `each: case.<List field>` in a tool's `map` (25 §3). */
const EACH_PATTERN = /^case\.([A-Za-z_][\w.]*)$/;

/** Default `extract.min_confidence` (23 §5). */
export const DEFAULT_MIN_CONFIDENCE = 0.8;

/**
 * `fields` of `extract:` as result name -> write: a list of names (`[pan, gstin]`), whose items
 * may map a result name to another write (`{ legal_name: client_name }` or `{ legal_name: { as: client_name } }`),
 * or the same as one map.
 */
function extractFields(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: string, target: unknown) => {
    const to = typeof target === 'string' ? target : isRecord(target) && typeof target.as === 'string' ? target.as : undefined;
    if (to) out[name] = to;
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') out[item] = item;
      else if (isRecord(item)) for (const [name, target] of Object.entries(item)) add(name, target);
    }
  } else if (isRecord(raw)) {
    for (const [name, target] of Object.entries(raw)) add(name, target === null ? name : target);
  }
  return out;
}

/** `extract: { tool, documents, fields, min_confidence }` on an external or person step (23 §5). */
function parseExtract(raw: Record<string, unknown>): ExtractDef | undefined {
  const tool = asString(raw.tool);
  const documents = asString(raw.documents);
  if (!tool || !documents) return undefined;
  const min = typeof raw.min_confidence === 'number' ? raw.min_confidence : DEFAULT_MIN_CONFIDENCE;
  return { tool, documents, fields: extractFields(raw.fields), minConfidence: min };
}

const REVIEW_KINDS = ['document', 'table', 'diff', 'form'] as const;

/**
 * `review:` (24 §11): `{ kind: document, record: case.document }`, `{ kind: table, items: case.x }`,
 * or a bare kind. A bare `document` (or one without `record`) leaves `record` empty: the checks
 * and the kernel infer it from the step's one `Ref<Document>` read.
 */
function parseReview(raw: unknown): ReviewDef | undefined {
  const obj = isRecord(raw) ? raw : undefined;
  const kind = (obj ? obj.kind : raw) as ReviewDef['kind'];
  if (!REVIEW_KINDS.includes(kind)) return undefined;
  const field = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^case\./, '') : '');
  switch (kind) {
    case 'document': return { kind, record: field(obj?.record) };
    case 'table': return { kind, items: field(obj?.items) };
    default: return { kind };
  }
}

/** `file` is relative to the project root; the step id is the file name without `.md`. */
export function parseStepFile(text: string, file: string): ParseResult<StepDef> {
  const parts = splitFrontMatter(text);
  if (!parts) {
    return { diagnostics: [{ severity: 'error', code: 'missing-front-matter', message: 'a step file starts with front matter between --- lines (title, performer, outcomes ...)', file, line: 1 }] };
  }
  const src = readYaml(parts.yaml, file, 1);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  const data = isRecord(src.data) ? src.data : {};
  if (src.data !== null && src.data !== undefined && !isRecord(src.data)) report.error('invalid-format', 'the front matter must be a map of keys');
  report.validate(stepFormat, data);

  const performer = PERFORMERS.includes(data.performer as Performer) ? data.performer as Performer : 'agent';
  const writes: Record<string, WriteDef> = {};
  for (const [field, spec] of Object.entries(asRecord(data.writes))) {
    const obj = isRecord(spec) ? spec : undefined;
    const typeSource = obj ? obj.type : spec;
    const type = typeAt(typeSource, report, obj ? ['writes', field, 'type'] : ['writes', field]);
    if (!type) continue;
    writes[field] = compact({
      field,
      type,
      typeSource: (typeSource as string).trim(),
      from: writeSource(obj?.from, performer),
      required: typeof obj?.required === 'boolean' ? obj.required : undefined,
    });
  }

  const tools = asRecord(data.tools);
  let budget: StepDef['budget'];
  if (isRecord(data.budget)) {
    const b = data.budget;
    const count = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? parseCount(v) : undefined);
    budget = compact({
      tokens: count(b.tokens),
      timeMs: typeof b.time === 'string' || typeof b.time === 'number' ? parseDuration(b.time) : undefined,
      modelCalls: count(b.modelCalls),
    });
  }

  let map: StepDef['map'];
  let each: StepDef['each'];
  if (isRecord(data.map)) {
    map = {};
    for (const [tool, args] of Object.entries(data.map)) {
      const { each: over, ...rest } = asRecord(args);
      if (over !== undefined) {
        const m = typeof over === 'string' ? EACH_PATTERN.exec(over.trim()) : null;
        if (m) (each ??= {})[tool] = m[1]!;
        else report.error('invalid-format', `\`each\` names a List case field to call ${tool} once per item, e.g. \`each: case.screening\``, ['map', tool, 'each']);
      }
      map[tool] = Object.fromEntries(Object.entries(rest).map(([arg, src]) => [arg, argSource(src)]));
    }
  }

  const value: StepDef = compact({
    id: basename(file).replace(/\.md$/, ''),
    title: asString(data.title) ?? '',
    performer,
    strictness: STRICTNESS.includes(data.strictness as Strictness) ? data.strictness as Strictness : 'guided',
    reads: asStrings(data.reads),
    writes,
    tools: { allowed: asStrings(tools.allowed), required: asStrings(tools.required) },
    model: asString(data.model),
    budget,
    checkpoint: asStrings(data.checkpoint),
    outcomes: asStrings(data.outcomes),
    policy: isRecord(data.policy) ? toPolicyDoc(data.policy, file) : undefined,
    assignee: asString(data.assignee),
    map,
    engine: ENGINES.includes(data.engine as StepEngine) ? data.engine as StepEngine : undefined,
    outcomeFrom: isRecord(data.outcomeFrom) && typeof data.outcomeFrom.tool === 'string' && typeof data.outcomeFrom.field === 'string'
      ? { tool: data.outcomeFrom.tool, field: data.outcomeFrom.field }
      : undefined,
    extract: isRecord(data.extract) ? parseExtract(data.extract) : undefined,
    sign: asString(data.sign),
    review: parseReview(data.review),
    each,
    quotes: data.quotes === 'required' ? 'required' as const : undefined,
    instructions: parts.body.trim(),
    file,
    hash: sha256(text),
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}
