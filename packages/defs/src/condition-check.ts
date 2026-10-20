/**
 * Checking a condition (24 §5) against the names it may read: unknown names, and type clashes
 * that are plainly wrong (a number compared with text, a yes/no value added to a number). Types
 * are checked loosely: anything we can't see into passes, and Postgres has the last word.
 */
import { parseCondition } from './condition.ts';
import type { ConditionNode, ParsedCondition } from './domain-types.ts';
import { resolveEntity } from './domains.ts';
import type { EntityTypeDef, ValueType } from './types.ts';

/** What a name holds, as far as conditions care. */
export type ConditionKind = 'number' | 'text' | 'boolean' | 'date' | 'datetime' | 'duration' | 'any';

/** A name a condition may read: its kind, and for enums and `status` the values it can hold. */
export interface ConditionName { kind: ConditionKind; values?: string[] }

/** The names in scope, each a value type (a field) or a kind. */
export type ConditionScope = Record<string, ValueType | ConditionKind | ConditionName>;

export interface ConditionCheckOptions {
  /** `boolean` (default): a guard, filter or wait; `any`: a row formula. */
  expect?: 'boolean' | 'any';
  /** Dashboard parameters, read as `params.<name>`. */
  params?: ConditionScope;
}

export interface ConditionProblem {
  severity: 'error' | 'warning';
  /** `invalid-condition` (can't be read, or a type clash), `unknown-field`, `unknown-value` (a warning). */
  code: 'invalid-condition' | 'unknown-field' | 'unknown-value';
  message: string;
  /** 0-based character position in the condition. */
  pos: number;
}

/** The kind of a value type. */
export function kindOfType(t: ValueType): ConditionName {
  switch (t.kind) {
    case 'enum': return { kind: 'text', values: t.values };
    case 'identifier': case 'ref': return { kind: 'text' };
    case 'scalar':
      switch (t.name) {
        case 'Text': case 'PersonName': case 'Email': case 'Phone': return { kind: 'text' };
        case 'Number': case 'Percentage': return { kind: 'number' };
        case 'Boolean': return { kind: 'boolean' };
        case 'Date': return { kind: 'date' };
        case 'DateTime': return { kind: 'datetime' };
        case 'Duration': return { kind: 'duration' };
        default: return { kind: 'any' };
      }
    default: return { kind: 'any' };
  }
}

const KINDS = new Set(['number', 'text', 'boolean', 'date', 'datetime', 'duration', 'any']);
/** Value type kinds (scalar, enum, ref, …) and condition kinds never share a word. */
const toName = (v: ValueType | ConditionKind | ConditionName): ConditionName =>
  typeof v === 'string' ? { kind: v } : KINDS.has(v.kind) ? v as ConditionName : kindOfType(v as ValueType);

const WORD: Record<ConditionKind | 'null', string> = {
  number: 'a number', text: 'text', boolean: 'yes/no', date: 'a date', datetime: 'a date and time', duration: 'a duration', any: 'a value', null: 'null',
};

type Inferred = { kind: ConditionKind | 'null'; values?: string[]; literal?: string };

/** The first character position inside a tree, for messages about it. */
function posOf(n: ConditionNode): number {
  switch (n.op) {
    case 'name': return n.pos;
    case 'fn': return n.args[0] ? posOf(n.args[0]) : 0;
    case 'not': case 'neg': case 'is_set': case 'is_not_set': case 'in': return posOf(n.arg);
    case 'and': case 'or': case 'implies': case '=': case '!=': case '<': case '<=': case '>': case '>=':
    case '+': case '-': case '*': case '/':
      return posOf(n.left);
    default: return 0;
  }
}

const dateLike = (k: string) => k === 'date' || k === 'datetime';

/** Parses and checks a condition against `scope`. */
export function checkCondition(src: string, scope: ConditionScope, opts: ConditionCheckOptions = {}): { parsed: ParsedCondition; problems: ConditionProblem[] } {
  const parsed = parseCondition(src);
  const problems: ConditionProblem[] = parsed.errors.map((e) => ({ severity: 'error', code: 'invalid-condition', message: e.message, pos: e.pos }));
  if (!parsed.ast) return { parsed, problems };
  const err = (message: string, pos: number) => problems.push({ severity: 'error', code: 'invalid-condition', message, pos });

  const lookup = (name: string, pos: number): Inferred => {
    const [head, ...rest] = name.split('.');
    if (head === 'params' && rest.length === 1 && opts.params) {
      const p = opts.params[rest[0]!];
      if (p) return toName(p);
      problems.push({ severity: 'error', code: 'unknown-field', message: `\`${name}\`: the page has no parameter \`${rest[0]}\` (it has ${Object.keys(opts.params).join(', ') || 'none'})`, pos });
      return { kind: 'any' };
    }
    const n = scope[name];
    if (n) return toName(n);
    const known = Object.keys(scope);
    problems.push({ severity: 'error', code: 'unknown-field', message: `\`${name}\` is not a field here (${known.length > 12 ? `${known.slice(0, 12).join(', ')}, …` : known.join(', ') || 'none'})`, pos });
    return { kind: 'any' };
  };

  const clash = (a: Inferred, b: Inferred): boolean => {
    if (a.kind === 'any' || b.kind === 'any' || a.kind === 'null' || b.kind === 'null') return false;
    if (dateLike(a.kind) && dateLike(b.kind)) return false;
    return a.kind !== b.kind;
  };

  /** `status = 'fild'`: a literal the name can never hold. */
  const valueCheck = (a: Inferred, b: Inferred, pos: number) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      if (x.values && y.literal !== undefined && !x.values.includes(y.literal)) {
        problems.push({ severity: 'warning', code: 'unknown-value', message: `'${y.literal}' is never a value here (it is one of ${x.values.join(', ')})`, pos });
      }
    }
  };

  const asCondition = (n: ConditionNode, t: Inferred) => {
    if (t.kind !== 'boolean' && t.kind !== 'any' && t.kind !== 'null') err(`this is ${WORD[t.kind]}, not a yes/no condition`, posOf(n));
  };

  const infer = (n: ConditionNode): Inferred => {
    switch (n.op) {
      case 'num': return { kind: 'number' };
      case 'str': return { kind: 'text', literal: n.value };
      case 'bool': return { kind: 'boolean' };
      case 'null': return { kind: 'null' };
      case 'today': return { kind: 'date' };
      case 'now': return { kind: 'datetime' };
      case 'duration': return { kind: 'duration' };
      case 'name': return lookup(n.name, n.pos);
      case 'fn': {
        const args = n.args.map(infer);
        switch (n.name) {
          case 'days_since': case 'days_until':
            if (args[0] && !dateLike(args[0].kind) && args[0].kind !== 'any' && args[0].kind !== 'null') err(`${n.name} takes a date; this is ${WORD[args[0].kind]}`, posOf(n.args[0]!));
            return { kind: 'number' };
          case 'lower':
            if (args[0] && args[0].kind !== 'text' && args[0].kind !== 'any') err(`lower takes text; this is ${WORD[args[0].kind]}`, posOf(n.args[0]!));
            return { kind: 'text' };
          case 'length':
            if (args[0] && args[0].kind !== 'text' && args[0].kind !== 'any') err(`length takes text; this is ${WORD[args[0].kind]}`, posOf(n.args[0]!));
            return { kind: 'number' };
          case 'coalesce': {
            const first = args.find((a) => a.kind !== 'null') ?? { kind: 'null' as const };
            for (let i = 1; i < args.length; i++) if (clash(first, args[i]!)) err(`coalesce mixes ${WORD[first.kind]} and ${WORD[args[i]!.kind]}`, posOf(n.args[i]!));
            return { kind: first.kind, values: first.values };
          }
        }
        return { kind: 'any' };
      }
      case 'not': asCondition(n.arg, infer(n.arg)); return { kind: 'boolean' };
      case 'and': case 'or': case 'implies':
        asCondition(n.left, infer(n.left));
        asCondition(n.right, infer(n.right));
        return { kind: 'boolean' };
      case 'is_set': case 'is_not_set': infer(n.arg); return { kind: 'boolean' };
      case 'in': {
        const a = infer(n.arg);
        for (const v of n.values) {
          const b = infer(v);
          if (clash(a, b)) err(`compares ${WORD[a.kind]} with ${WORD[b.kind]}`, posOf(v) || posOf(n.arg));
          else valueCheck(a, b, posOf(n.arg));
        }
        return { kind: 'boolean' };
      }
      case '=': case '!=': case '<': case '<=': case '>': case '>=': {
        const a = infer(n.left);
        const b = infer(n.right);
        if (clash(a, b)) err(`compares ${WORD[a.kind]} with ${WORD[b.kind]}`, posOf(n.left));
        else if (n.op === '=' || n.op === '!=') valueCheck(a, b, posOf(n.left));
        else if (a.kind === 'boolean' || b.kind === 'boolean') err('yes/no values have no order: use = or !=', posOf(n.left));
        return { kind: 'boolean' };
      }
      case 'neg': {
        const a = infer(n.arg);
        if (!['number', 'duration', 'any'].includes(a.kind)) err(`can't negate ${WORD[a.kind]}`, posOf(n.arg));
        return { kind: a.kind === 'duration' ? 'duration' : a.kind === 'any' ? 'any' : 'number' };
      }
      case '+': case '-': {
        const a = infer(n.left);
        const b = infer(n.right);
        if (a.kind === 'any' || b.kind === 'any') return { kind: 'any' };
        if (a.kind === 'number' && b.kind === 'number') return { kind: 'number' };
        if (a.kind === 'duration' && b.kind === 'duration') return { kind: 'duration' };
        if (dateLike(a.kind) && b.kind === 'duration') return { kind: a.kind };
        if (n.op === '+' && a.kind === 'duration' && dateLike(b.kind)) return { kind: b.kind };
        if (n.op === '-' && dateLike(a.kind) && dateLike(b.kind)) return { kind: 'number' }; // days between
        err(`can't ${n.op === '+' ? 'add' : 'subtract'} ${WORD[b.kind]} ${n.op === '+' ? 'to' : 'from'} ${WORD[a.kind]}`, posOf(n.left));
        return { kind: 'any' };
      }
      case '*': case '/': {
        const a = infer(n.left);
        const b = infer(n.right);
        if (a.kind === 'any' || b.kind === 'any') return { kind: 'any' };
        if (a.kind === 'number' && b.kind === 'number') return { kind: 'number' };
        if (a.kind === 'duration' && b.kind === 'number') return { kind: 'duration' };
        err(`can't ${n.op === '*' ? 'multiply' : 'divide'} ${WORD[a.kind]} by ${WORD[b.kind]}`, posOf(n.left));
        return { kind: 'any' };
      }
    }
  };

  const top = infer(parsed.ast);
  if ((opts.expect ?? 'boolean') === 'boolean') asCondition(parsed.ast, top);
  return { parsed, problems };
}

/**
 * The names a condition on records of `def` may read (24 §5): its fields, `one` relationships
 * (the related record's id), calculated fields, followed link fields, `status` (its lifecycle
 * states), `id`, `created_at` and `updated_at`.
 */
export function entityConditionScope(def: EntityTypeDef, entities: Record<string, EntityTypeDef>): ConditionScope {
  const scope: ConditionScope = {
    id: 'text',
    status: { kind: 'text', ...(def.lifecycle?.length ? { values: def.lifecycle } : {}) },
    created_at: 'datetime',
    updated_at: 'datetime',
  };
  for (const [name, rel] of Object.entries(def.relationships)) if (rel.cardinality === 'one') scope[name] = 'text';
  for (const [name, f] of Object.entries(def.fields)) scope[name] = f.type;
  for (const link of Object.values(def.links ?? {})) {
    const other = entities[link.target];
    for (const f of link.follow) scope[f] = other?.fields[f]?.type ?? 'any';
  }
  for (const [name, c] of Object.entries(def.calculated ?? {})) {
    if (c.kind === 'formula') {
      // A formula's kind is what it computes over the fields (without other calculated fields).
      scope[name] = formulaKind(c.formula, { ...scope });
      continue;
    }
    if (c.rollup === 'count' || c.rollup === 'percent') { scope[name] = 'number'; continue; }
    const rel = def.relationships[c.of];
    const target = rel ? resolveEntity(entities, def.domain ?? 'domain', rel.target) : undefined;
    const field = c.field ? target?.fields[c.field] : undefined;
    scope[name] = field ? kindOfType(field.type) : 'any';
  }
  return scope;
}

/** The kind a row formula computes, or `any`. */
function formulaKind(src: string, scope: ConditionScope): ConditionKind {
  const parsed = parseCondition(src);
  if (!parsed.ast) return 'any';
  const n = parsed.ast;
  if (['and', 'or', 'implies', 'not', '=', '!=', '<', '<=', '>', '>=', 'is_set', 'is_not_set', 'in'].includes(n.op)) return 'boolean';
  if (n.op === 'fn') return n.name === 'lower' ? 'text' : n.name === 'coalesce' ? 'any' : 'number';
  if (n.op === 'num' || n.op === 'neg' || n.op === '*' || n.op === '/') return 'number';
  if (n.op === 'name') { const v = scope[n.name]; return v ? toName(v).kind : 'any'; }
  return 'any';
}
