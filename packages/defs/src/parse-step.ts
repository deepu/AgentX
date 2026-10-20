/** `steps/<state>.md`: YAML front matter, then the instructions in Markdown. */
import { basename } from 'node:path';
import { stepFormat } from './formats.ts';
import { toPolicyDoc } from './parse-policy.ts';
import { typeAt } from './parse-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, sha256, type ParseResult } from './source.ts';
import type { ArgSource, Performer, StepDef, Strictness, WriteDef, WriteSource } from './types.ts';
import { parseCount, parseDuration } from './value-types.ts';

const PERFORMERS: Performer[] = ['agent', 'person', 'external', 'system'];
const STRICTNESS: Strictness[] = ['strict', 'guided', 'open'];

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

/** `case.client_name` reads the case; `{ value: x }` or anything else is a literal. */
export function argSource(raw: unknown): ArgSource {
  if (typeof raw === 'string' && /^case\.[A-Za-z_][\w.]*$/.test(raw.trim())) return { case: raw.trim().slice(5) };
  if (isRecord(raw) && Object.keys(raw).length === 1 && 'value' in raw) return { value: raw.value };
  return { value: raw };
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
  if (isRecord(data.map)) {
    map = {};
    for (const [tool, args] of Object.entries(data.map)) {
      map[tool] = Object.fromEntries(Object.entries(asRecord(args)).map(([arg, src]) => [arg, argSource(src)]));
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
    instructions: parts.body.trim(),
    file,
    hash: sha256(text),
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}
