/**
 * What starts a workflow (`starts_on:`, 24 §7) and the block states that hand work to another
 * workflow (`start`, `call`, `for_each`, `wait_until`, 24 §8), from `workflow.yaml`.
 */
import type { BlockDef, HandoffArg, TriggerDef } from './domain-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, type PathKey, type Reporter } from './source.ts';
import { parseDuration } from './value-types.ts';

const TRIGGER_KINDS = ['entered', 'created', 'changed', 'before', 'after', 'every', 'message'] as const;

/** `with:` of a trigger: case field → `record`, `message.<field>`, or a literal (kept as text). */
function triggerWith(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, v] of Object.entries(asRecord(raw))) {
    if (v === null || v === undefined) continue;
    out[field] = typeof v === 'string' ? v.trim() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** `starts_on:` → triggers. Each entry names exactly one kind. */
export function parseTriggers(raw: unknown, report: Reporter): TriggerDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TriggerDef[] = [];
  raw.forEach((spec, i) => {
    const path: PathKey[] = ['starts_on', i];
    if (!isRecord(spec)) return; // the format check already said so
    const kinds = TRIGGER_KINDS.filter((k) => spec[k] !== undefined);
    if (kinds.length !== 1) {
      report.error('invalid-trigger', kinds.length
        ? `a trigger names one thing that starts the workflow; this one names ${kinds.join(' and ')}`
        : `say what starts the workflow: one of ${TRIGGER_KINDS.join(', ')}`, path);
      return;
    }
    const kind = kinds[0]!;
    const common = compact({ with: triggerWith(spec.with), as: asString(spec.as) });
    const v = spec[kind];
    switch (kind) {
      case 'entered': {
        const m = typeof v === 'string' ? /^\s*(.+)\.([A-Za-z_]\w*)\s*$/.exec(v) : null;
        if (!m) return;
        out.push({ kind, entity: m[1]!, state: m[2]!, ...common });
        return;
      }
      case 'created':
        if (typeof v === 'string') out.push({ kind, entity: v.trim(), ...common });
        return;
      case 'changed':
        if (typeof v === 'string') out.push({ kind, entity: v.trim(), ...common });
        else if (isRecord(v) && typeof v.entity === 'string') {
          out.push(compact({ kind, entity: v.entity.trim(), fields: Array.isArray(v.fields) ? asStrings(v.fields) : undefined, ...common }));
        }
        return;
      case 'before':
      case 'after': {
        const d = asRecord(v);
        const m = typeof d.field === 'string' ? /^\s*(.+)\.([A-Za-z_]\w*)\s*$/.exec(d.field) : null;
        const offsetMs = typeof d.by === 'string' || typeof d.by === 'number' ? parseDuration(d.by) : undefined;
        if (!m) return;
        if (offsetMs === undefined) { report.error('invalid-format', 'expected a duration like 30d', [...path, kind, 'by']); return; }
        out.push({ kind: 'date', entity: m[1]!, field: m[2]!, direction: kind, offsetMs, ...common });
        return;
      }
      case 'every': {
        const everyMs = typeof v === 'string' || typeof v === 'number' ? parseDuration(v) : undefined;
        if (!everyMs) { report.error('invalid-format', 'expected a schedule like 2w, 1d or 12h', [...path, 'every']); return; }
        out.push(compact({ kind, everyMs, at: asString(spec.at), on: spec.on === undefined ? undefined : String(spec.on), ...common }));
        return;
      }
      case 'message': {
        const address = asString(asRecord(v).address);
        if (address) out.push({ kind, address: address.trim(), ...common });
        return;
      }
    }
  });
  return out;
}

/** A `with:` value of a block: `case.<path>`, `item`, `item.<path>`, `record`, or a literal. */
export function handoffArg(raw: unknown): HandoffArg {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^case\.[A-Za-z_][\w.]*$/.test(s)) return { case: s.slice('case.'.length) };
    if (s === 'item') return { item: '' };
    if (/^item\.[A-Za-z_][\w.]*$/.test(s)) return { item: s.slice('item.'.length) };
    if (s === 'record') return { record: true };
  }
  if (isRecord(raw) && Object.keys(raw).length === 1 && 'value' in raw) return { value: raw.value };
  return { value: raw };
}

const handoffWith = (raw: unknown): Record<string, HandoffArg> =>
  Object.fromEntries(Object.entries(asRecord(raw)).map(([k, v]) => [k, handoffArg(v)]));

const returnsOf = (raw: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(raw)).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, (v as string).replace(/^case\./, '')]));

const BLOCK_KEYS = ['start', 'call', 'for_each', 'wait_until'] as const;

/** A state's block, if it has one (a state has at most one). */
export function parseBlock(name: string, s: Record<string, unknown>, report: Reporter): BlockDef | undefined {
  const keys = BLOCK_KEYS.filter((k) => s[k] !== undefined);
  if (!keys.length) return undefined;
  const path: PathKey[] = ['steps', name];
  if (keys.length > 1) {
    report.error('several-blocks', `\`${name}\` has ${keys.join(' and ')}; a state hands work over in one way`, path);
    return undefined;
  }
  const kind = keys[0]!;
  const b = asRecord(s[kind]);
  switch (kind) {
    case 'start':
    case 'call': {
      const workflow = asString(b.workflow);
      if (!workflow) return undefined;
      if (kind === 'start') {
        if (b.returns !== undefined) report.warn('returns-on-start', '`start` moves on at once, so nothing comes back: use `call` to wait for `returns`', [...path, kind, 'returns']);
        return { kind, workflow, with: handoffWith(b.with) };
      }
      return { kind, workflow, with: handoffWith(b.with), returns: returnsOf(b.returns) };
    }
    case 'for_each': {
      const items = asString(b.items)?.replace(/^case\./, '');
      const target = isRecord(b.call) ? b.call : isRecord(b.start) ? b.start : undefined;
      if (isRecord(b.call) && isRecord(b.start)) {
        report.error('several-blocks', '`for_each` either starts or calls the other workflow, not both', [...path, kind]);
        return undefined;
      }
      if (!target) {
        report.error('invalid-format', '`for_each` needs `start: { workflow, with }` or `call: { workflow, with }`', [...path, kind]);
        return undefined;
      }
      const workflow = asString(target.workflow);
      if (!items || !workflow) return undefined;
      const join = b.join === 'any' || (typeof b.join === 'number' && b.join > 0) ? b.join as 'any' | number : 'all';
      return compact({ kind, items, as: asString(b.as), mode: isRecord(b.call) ? 'call' : 'start', workflow, with: handoffWith(target.with), join }) as BlockDef;
    }
    case 'wait_until': {
      const record = asString(b.record)?.replace(/^case\./, '');
      const condition = asString(b.condition);
      if (!record || !condition) return undefined;
      return { kind, record, condition };
    }
  }
}
