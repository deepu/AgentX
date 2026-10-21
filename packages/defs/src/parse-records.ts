/**
 * The Phase 6 parts of an entity file (24 §4, §6): relationships in object form, calculated
 * fields, links to other domains, the lifecycle statechart and the record page layout.
 * Structure is checked by `entityFormat`; these turn the raw YAML into the definition model and
 * report what only makes sense once read (an unknown page block, a duration that isn't one).
 */
import type {
  CalculatedFieldDef, ChartBlockDef, ChartKind, EntityLinkDef, LifecycleDef, LifecycleStateDef, LifecycleTransitionDef, PageArea, PageBlock,
  PageLayoutDef, PageLayoutShape, RelationshipDef, RollupKind, TransitionActor,
} from './domain-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, type PathKey, type Reporter } from './source.ts';
import type { EntityTypeDef } from './types.ts';
import { parseDuration } from './value-types.ts';

const ENTITY_NAME = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/;

/** `many Document`, `one Study`, or `{ many: ExpectedDocument, via: site }`. */
export function parseRelationships(raw: unknown, report: Reporter): Record<string, RelationshipDef> {
  const out: Record<string, RelationshipDef> = {};
  for (const [name, spec] of Object.entries(asRecord(raw))) {
    if (typeof spec === 'string') {
      const m = /^\s*(one|many)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*$/.exec(spec);
      if (m) out[name] = { cardinality: m[1] as 'one' | 'many', target: m[2]! };
      continue;
    }
    if (!isRecord(spec)) continue;
    const one = asString(spec.one);
    const many = asString(spec.many);
    if ((one === undefined) === (many === undefined)) {
      report.error('invalid-format', `relationship \`${name}\` names exactly one of \`one:\` or \`many:\``, ['relationships', name]);
      continue;
    }
    const target = (one ?? many)!.trim();
    if (!ENTITY_NAME.test(target)) {
      report.error('invalid-format', `\`${target}\` is not an entity name`, ['relationships', name]);
      continue;
    }
    if (one !== undefined && spec.via !== undefined) report.warn('via-on-one', `\`via\` names the inverse of a \`many\` relationship; \`${name}\` is \`one\``, ['relationships', name, 'via']);
    out[name] = compact({ cardinality: one !== undefined ? 'one' : 'many', target, via: many !== undefined ? asString(spec.via) : undefined });
  }
  return out;
}

const ROLLUPS: RollupKind[] = ['count', 'sum', 'min', 'max', 'percent'];

/** `{ percent: expected_documents, where: "status = 'filed'" }`, `{ sum: x, field: y }`, `{ formula: "…" }`. */
export function parseCalculated(raw: unknown): Record<string, CalculatedFieldDef> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, CalculatedFieldDef> = {};
  for (const [name, spec] of Object.entries(raw)) {
    if (!isRecord(spec)) continue;
    const description = asString(spec.description);
    if (typeof spec.formula === 'string') {
      out[name] = compact({ kind: 'formula', formula: spec.formula, description });
      continue;
    }
    const rollup = ROLLUPS.find((k) => typeof spec[k] === 'string');
    if (!rollup) continue; // the format check already said so
    out[name] = compact({
      kind: 'rollup', rollup, of: (spec[rollup] as string).trim(), field: asString(spec.field), where: asString(spec.where), description,
    });
  }
  return out;
}

/** `links: { edc.Site: { match: [site_number], follow: [name] } }`; `match` may rename: `{ site_number: number }`. */
export function parseLinks(raw: unknown): Record<string, EntityLinkDef> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, EntityLinkDef> = {};
  for (const [target, spec] of Object.entries(raw)) {
    if (!isRecord(spec)) continue;
    const match: Record<string, string> = {};
    if (Array.isArray(spec.match)) for (const f of asStrings(spec.match)) match[f] = f;
    else for (const [mine, theirs] of Object.entries(asRecord(spec.match))) if (typeof theirs === 'string') match[mine] = theirs;
    out[target] = { target, match, follow: asStrings(spec.follow) };
  }
  return out;
}

/** `step`, `system`, `role:<id>`, `source:<plugin | domain:<id>>`. */
function parseActor(src: string): TransitionActor | undefined {
  const s = src.trim();
  if (s === 'step') return { kind: 'step' };
  if (s === 'system') return { kind: 'system' };
  const m = /^(role|source):\s*(\S+)$/.exec(s);
  if (!m) return undefined;
  return m[1] === 'role' ? { kind: 'role', role: m[2]! } : { kind: 'source', source: m[2]! };
}

/** The transition name the list form gives a move into `state`. */
export const listTransition = (state: string): string => `to_${state}`;

/**
 * The lifecycle in both forms. The list form becomes a chart in which every state can move to
 * every other by `to_<state>` (`fromList`; any role in the domain may make them, 24 §4). A
 * transition used in `on:` but not declared gets an entry with no `by`; the loader fills in the
 * default (`[step, role:<domain owner>]`), as for a declared one that leaves `by` out.
 */
export function parseLifecycle(raw: unknown, report: Reporter): { states?: string[]; chart?: LifecycleDef } {
  if (Array.isArray(raw)) {
    const states = asStrings(raw);
    if (!states.length) return { states };
    const chart: LifecycleDef = { initial: states[0]!, states: {}, transitions: {}, fromList: true };
    for (const s of states) {
      chart.states[s] = { name: s, on: Object.fromEntries(states.filter((t) => t !== s).map((t) => [listTransition(t), t])) };
      chart.transitions[listTransition(s)] = { name: listTransition(s), by: [{ kind: 'step' }, { kind: 'system' }] };
    }
    return { states, chart };
  }
  if (!isRecord(raw)) return {};
  const states: Record<string, LifecycleStateDef> = {};
  const transitions: Record<string, LifecycleTransitionDef> = {};
  for (const [name, spec] of Object.entries(asRecord(raw.states))) {
    const s = asRecord(spec);
    const on = Object.fromEntries(Object.entries(asRecord(s.on)).filter(([, t]) => typeof t === 'string')) as Record<string, string>;
    const after: NonNullable<LifecycleStateDef['after']> = [];
    for (const [dur, action] of Object.entries(asRecord(s.after))) {
      const afterMs = parseDuration(dur);
      const path: PathKey[] = ['lifecycle', 'states', name, 'after', dur];
      if (afterMs === undefined) { report.error('invalid-format', `\`${dur}\` is not a duration: expected something like 30d, 2w or 12h`, path); continue; }
      const a = asRecord(action);
      const remind = asString(a.remind);
      const transition = asString(a.transition);
      if (!remind === !transition) { report.error('invalid-format', `a timer either reminds a role or makes a transition: \`{ remind: <role> }\` or \`{ transition: <name> }\``, path); continue; }
      after.push(compact({ afterMs, remind, transition }));
    }
    states[name] = compact({ name, on, after: after.length ? after : undefined });
    for (const t of Object.keys(on)) transitions[t] ??= { name: t, by: [] };
  }
  for (const [name, spec] of Object.entries(asRecord(raw.transitions))) {
    const t = asRecord(spec);
    const by: TransitionActor[] = [];
    const written = typeof t.by === 'string' ? [t.by] : asStrings(t.by);
    written.forEach((src, i) => {
      const actor = parseActor(src);
      if (actor) by.push(actor);
      else report.error('invalid-format', `\`${src}\` is not who may make a transition: expected step, system, role:<id> or source:<plugin or domain:<id>>`, ['lifecycle', 'transitions', name, 'by', ...(typeof t.by === 'string' ? [] : [i])]);
    });
    transitions[name] = compact({
      name, by, guard: asString(t.guard), signed: typeof t.signed === 'boolean' ? t.signed : undefined,
      label: asString(t.label), primary: t.primary === true ? true : undefined,
    });
  }
  const chart: LifecycleDef = { initial: asString(raw.initial) ?? '', states, transitions };
  return { states: Object.keys(states), chart };
}

// ---------------------------------------------------------------- record pages (24 §6)

/** Blocks written as a bare word. */
const WORD_BLOCKS = ['details', 'cases', 'lifecycle', 'checks', 'notes', 'mentions', 'start', 'history', 'chat'] as const;
export const PAGE_BLOCK_KINDS = [...WORD_BLOCKS, 'fields', 'viewer', 'related', 'chart', 'kpis'] as const;

const CHART_KINDS: ChartKind[] = ['bar', 'line', 'donut', 'interval'];
/** The keys of a record page chart, besides `kind` (24 §6, 25 §5). */
const CHART_KEYS = ['of', 'by', 'where', 'title', 'label', 'value', 'low', 'high', 'unit'] as const;

/** Which areas each layout has (`below` is in all of them). */
export const LAYOUT_AREAS: Record<PageLayoutShape, Exclude<PageArea, 'header'>[]> = {
  single: ['main', 'below'],
  split: ['left', 'right', 'below'],
  sidebar: ['main', 'side', 'below'],
};

function parseBlock(raw: unknown, report: Reporter, path: PathKey[]): PageBlock | undefined {
  const unknown = (what: string) => {
    report.error('unknown-page-block', `\`${what}\` is not a page block: expected ${PAGE_BLOCK_KINDS.join(', ')}`, path);
    return undefined;
  };
  if (typeof raw === 'string') {
    const word = raw.trim();
    return (WORD_BLOCKS as readonly string[]).includes(word) ? { kind: word } as PageBlock : unknown(word);
  }
  if (!isRecord(raw)) return unknown(String(raw));
  const keys = Object.keys(raw);
  if (keys.length !== 1) return unknown(keys.join(', ') || '{}');
  const kind = keys[0]!;
  const v = raw[kind];
  const bad = (expected: string) => {
    report.error('invalid-format', `\`${kind}\` block: expected ${expected}`, [...path, kind]);
    return undefined;
  };
  switch (kind) {
    case 'fields': return Array.isArray(v) ? { kind, fields: asStrings(v) } : bad('a list of fields');
    case 'kpis': return Array.isArray(v) ? { kind, fields: asStrings(v) } : bad('a list of calculated or Number fields');
    case 'related': return Array.isArray(v) ? { kind, relationships: asStrings(v) } : bad('a list of many relationships');
    case 'viewer': return typeof v === 'string' ? { kind, field: v } : bad('a Document, File or Text field');
    case 'chart': {
      const c = asRecord(v);
      const chart = asString(c.kind) as ChartKind | undefined;
      if (!isRecord(v) || !chart || !CHART_KINDS.includes(chart) || typeof c.of !== 'string') {
        return bad('{ kind: bar | line | donut, of: <relationship>, by: <field>, where, title } or { kind: interval, of: <relationship>, label, value, low, high, unit, where, title }');
      }
      for (const k of Object.keys(c)) {
        if (k !== 'kind' && !(CHART_KEYS as readonly string[]).includes(k)) report.warn('unknown-key', `unknown key \`${k}\` in a chart (it takes kind, ${CHART_KEYS.join(', ')})`, [...path, kind, k]);
      }
      if (chart === 'interval' && (typeof c.value !== 'string' || typeof c.low !== 'string' || typeof c.high !== 'string')) {
        return bad('an interval chart names its `value`, `low` and `high` fields (and a `label` template)');
      }
      const block: ChartBlockDef = { kind, chart, of: c.of };
      for (const k of CHART_KEYS) if (k !== 'of' && typeof c[k] === 'string') block[k] = c[k] as string;
      return block;
    }
    default:
      // `{ details: … }` and friends: a word block written as a map.
      if ((WORD_BLOCKS as readonly string[]).includes(kind) && (v === null || v === true)) return { kind } as PageBlock;
      return unknown(kind);
  }
}

/**
 * `page:` as written → the layout. `details` is always on the page: when left out it is added
 * at the end of the layout's first area (24 §6).
 */
export function parsePageLayout(raw: unknown, report: Reporter): PageLayoutDef | undefined {
  if (!isRecord(raw)) return undefined;
  const layout: PageLayoutShape = raw.layout === 'split' || raw.layout === 'sidebar' ? raw.layout : 'single';
  const areas: PageLayoutDef['areas'] = {};
  for (const area of ['main', 'left', 'right', 'side', 'below'] as const) {
    if (!Array.isArray(raw[area])) continue;
    if (!LAYOUT_AREAS[layout].includes(area)) {
      report.error('page-area-not-in-layout', `a ${layout} page has no \`${area}\` area (it has ${['header', ...LAYOUT_AREAS[layout]].join(', ')})`, ['page', area]);
      continue;
    }
    areas[area] = (raw[area] as unknown[]).map((b, i) => parseBlock(b, report, ['page', area, i])).filter((b): b is PageBlock => !!b);
  }
  const all = Object.values(areas).flat();
  if (!all.some((b) => b.kind === 'details')) (areas[LAYOUT_AREAS[layout][0]!] ??= []).push({ kind: 'details' });
  return { layout, header: asStrings(raw.header), areas };
}

/**
 * The layout of an entity without `page:` (24 §6): single, the title and status in the header,
 * then every field, the lifecycle (when there is one), its many relationships, cases, notes,
 * mentions and history.
 */
export function defaultPageLayout(def: Pick<EntityTypeDef, 'fields' | 'relationships' | 'lifecycle' | 'calculated'>): PageLayoutDef {
  const many = Object.entries(def.relationships).filter(([, r]) => r.cardinality === 'many').map(([n]) => n);
  const main: PageBlock[] = [
    { kind: 'fields', fields: [...Object.keys(def.fields), ...Object.keys(def.calculated ?? {})] },
    { kind: 'details' },
    ...(def.lifecycle?.length ? [{ kind: 'lifecycle' } as const] : []),
    ...(many.length ? [{ kind: 'related', relationships: many } as const] : []),
    { kind: 'cases' }, { kind: 'notes' }, { kind: 'mentions' }, { kind: 'history' },
  ];
  return { layout: 'single', header: ['title', 'status'], areas: { main }, isDefault: true };
}
