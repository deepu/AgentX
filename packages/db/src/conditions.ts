/**
 * The condition language compiled to SQL (24 §5). `parseCondition` (defs) makes the tree; this
 * turns it into one SQL expression. Names go through `ctx.column` and values through
 * `ctx.param`, so nothing a definition or a person wrote is ever interpolated as SQL text.
 *
 * Types are checked loosely: comparing a number with text is an error, `today + 30d` works on
 * dates, `is set` on text also means "not empty". `params.<x>` names (dashboards) are bound
 * through `ctx.paramValue`.
 */
import { parseCondition, type ConditionNode, type EntityTypeDef } from '@memwise/defs';
import { evaluateOn } from './domain/entities.ts';
import type { Queryable } from './pool.ts';

export type ConditionType = 'number' | 'text' | 'boolean' | 'date' | 'timestamp' | 'interval' | 'json' | 'unknown';

export interface ConditionContext {
  /** The SQL for a name (a field, calculated or followed field, `status`, `id`…), or undefined when unknown. */
  column(name: string): string | undefined;
  /** Binds a value and returns its placeholder (`$3`), or a safe literal where no parameters exist (views). */
  param(v: unknown): string;
  /** The type of a name, for the loose checks and `is set` on text. */
  type?(name: string): ConditionType | undefined;
  /** `params.<x>`: the value bound for a dashboard parameter (undefined: unknown parameter). */
  paramValue?(name: string): unknown;
}

export class ConditionCompileError extends Error {
  readonly code = 'condition';
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

const MS_DAY = 86_400_000;

/** One SQL boolean or value expression for a condition tree. Throws `ConditionCompileError`. */
export function compileCondition(ast: ConditionNode, ctx: ConditionContext): string {
  return compile(ast, ctx).sql;
}

/** Parses and compiles; parse problems become a `ConditionCompileError` with their position. */
export function compileConditionSource(source: string, ctx: ConditionContext): string {
  const parsed = parseCondition(source);
  if (!parsed.ast) {
    const e = parsed.errors[0] ?? { message: 'the condition is empty', pos: 0 };
    throw new ConditionCompileError(e.message, e.pos);
  }
  return compileCondition(parsed.ast, ctx);
}

/** The type a condition tree evaluates to (row formulas: the column's type). */
export function conditionType(ast: ConditionNode, ctx: ConditionContext): ConditionType {
  return compile(ast, ctx).type;
}

interface Compiled { sql: string; type: ConditionType }

const isNumeric = (t: ConditionType) => t === 'number';
const isDateLike = (t: ConditionType) => t === 'date' || t === 'timestamp';

function compile(n: ConditionNode, ctx: ConditionContext): Compiled {
  switch (n.op) {
    case 'num': return { sql: `${ctx.param(n.value)}::numeric`, type: 'number' };
    case 'str': return { sql: ctx.param(n.value), type: 'text' };
    case 'bool': return { sql: n.value ? 'true' : 'false', type: 'boolean' };
    case 'null': return { sql: 'null', type: 'unknown' };
    case 'today': return { sql: 'current_date', type: 'date' };
    case 'now': return { sql: 'now()', type: 'timestamp' };
    case 'duration': return { sql: interval(n.ms), type: 'interval' };
    case 'name': return name(n.name, n.pos, ctx);
    case 'fn': {
      const args = n.args.map((a) => compile(a, ctx));
      const a0 = args[0]!;
      switch (n.name) {
        case 'days_since': dateArg(n, a0); return { sql: `(current_date - (${a0.sql})::date)`, type: 'number' };
        case 'days_until': dateArg(n, a0); return { sql: `((${a0.sql})::date - current_date)`, type: 'number' };
        case 'lower': return { sql: `lower((${a0.sql})::text)`, type: 'text' };
        case 'length': return { sql: `char_length((${a0.sql})::text)`, type: 'number' };
        case 'coalesce': {
          const known = args.find((a) => a.type !== 'unknown')?.type ?? 'unknown';
          return { sql: `coalesce(${args.map((a) => a.sql).join(', ')})`, type: known };
        }
      }
      throw new ConditionCompileError(`unknown function ${(n as { name: string }).name}`, 0);
    }
    case 'not': return { sql: `(not ${bool(compile(n.arg, ctx))})`, type: 'boolean' };
    case 'neg': {
      const a = compile(n.arg, ctx);
      return { sql: `(- ${a.sql})`, type: a.type === 'interval' ? 'interval' : 'number' };
    }
    case 'and': case 'or':
      return { sql: `(${bool(compile(n.left, ctx))} ${n.op} ${bool(compile(n.right, ctx))})`, type: 'boolean' };
    case 'implies':
      return { sql: `((not ${bool(compile(n.left, ctx))}) or ${bool(compile(n.right, ctx))})`, type: 'boolean' };
    case 'is_set': case 'is_not_set': {
      const a = compile(n.arg, ctx);
      const set = a.type === 'text' ? `(${a.sql} is not null and (${a.sql})::text <> '')` : `(${a.sql} is not null)`;
      return { sql: n.op === 'is_set' ? set : `(not ${set})`, type: 'boolean' };
    }
    case 'in': {
      const a = compile(n.arg, ctx);
      const values = n.values.map((v) => compile(v, ctx));
      for (const v of values) mismatch(a, v, n);
      return { sql: `(${a.sql} in (${values.map((v) => v.sql).join(', ')}))`, type: 'boolean' };
    }
    case '=': case '!=': case '<': case '<=': case '>': case '>=': {
      // `x = null` means "x is not set".
      if (n.right.op === 'null' || n.left.op === 'null') {
        const other = compile(n.right.op === 'null' ? n.left : n.right, ctx);
        if (n.op === '=') return { sql: `(${other.sql} is null)`, type: 'boolean' };
        if (n.op === '!=') return { sql: `(${other.sql} is not null)`, type: 'boolean' };
        throw new ConditionCompileError('only = and != can compare with null', 0);
      }
      const l = compile(n.left, ctx);
      const r = compile(n.right, ctx);
      mismatch(l, r, n);
      const op = n.op === '!=' ? '<>' : n.op;
      // != keeps the everyday meaning when one side is empty: different.
      if (n.op === '!=') return { sql: `(${l.sql} is distinct from ${r.sql})`, type: 'boolean' };
      return { sql: `(${l.sql} ${op} ${r.sql})`, type: 'boolean' };
    }
    case '+': case '-': case '*': case '/': {
      const l = compile(n.left, ctx);
      const r = compile(n.right, ctx);
      if ((l.type === 'text' && r.type !== 'unknown') || (r.type === 'text' && l.type !== 'unknown')) {
        throw new ConditionCompileError(`can't do arithmetic (${n.op}) with text`, posOf(n));
      }
      let type: ConditionType = 'number';
      if (n.op === '+' || n.op === '-') {
        if (isDateLike(l.type) && r.type === 'interval') type = l.type === 'date' ? 'timestamp' : 'timestamp';
        else if (l.type === 'interval' && isDateLike(r.type) && n.op === '+') type = 'timestamp';
        else if (l.type === 'date' && r.type === 'date' && n.op === '-') type = 'number';
        else if (isDateLike(l.type) && isDateLike(r.type) && n.op === '-') type = 'interval';
        else if (l.type === 'interval' && r.type === 'interval') type = 'interval';
        else if (isDateLike(l.type) && isNumeric(r.type)) {
          // `activated_on + 30` means days.
          return { sql: `((${l.sql})::date ${n.op} (${r.sql})::int)`, type: 'date' };
        }
      }
      if (n.op === '/') {
        // Division by zero is "not known", not an error that breaks a page.
        return { sql: `(${l.sql} / nullif(${r.sql}, 0))`, type };
      }
      return { sql: `(${l.sql} ${n.op} ${r.sql})`, type };
    }
  }
}

function name(raw: string, pos: number, ctx: ConditionContext): Compiled {
  if (raw.startsWith('params.')) {
    const key = raw.slice('params.'.length);
    const v = ctx.paramValue?.(key);
    if (v === undefined) throw new ConditionCompileError(`there is no parameter "${key}" here`, pos);
    return typeof v === 'number' ? { sql: `${ctx.param(v)}::numeric`, type: 'number' }
      : typeof v === 'boolean' ? { sql: `${ctx.param(v)}::boolean`, type: 'boolean' }
      : { sql: ctx.param(v), type: 'unknown' };
  }
  const sql = ctx.column(raw);
  if (sql === undefined) throw new ConditionCompileError(`there is no field "${raw}" here`, pos);
  return { sql, type: ctx.type?.(raw) ?? 'unknown' };
}

function interval(ms: number): string {
  if (!Number.isFinite(ms)) throw new ConditionCompileError('a duration must be a number', 0);
  const n = Math.round(ms);
  return n % MS_DAY === 0 ? `interval '${n / MS_DAY} days'` : `interval '${n} milliseconds'`;
}

/** A value used as a condition: a boolean as it is; "unknown" (null) counts as false. */
function bool(c: Compiled): string {
  if (c.type === 'boolean' || c.type === 'unknown') return `coalesce(${c.sql}, false)`;
  throw new ConditionCompileError(`a ${c.type} is not a yes/no condition`, 0);
}

function dateArg(n: ConditionNode & { op: 'fn' }, a: Compiled) {
  if (a.type !== 'unknown' && !isDateLike(a.type) && a.type !== 'text') {
    throw new ConditionCompileError(`${n.name} takes a date`, posOf(n));
  }
}

function mismatch(l: Compiled, r: Compiled, n: ConditionNode) {
  const pair = [l.type, r.type];
  if (pair.includes('number') && pair.includes('text')) {
    throw new ConditionCompileError('a number is compared with text', posOf(n));
  }
}

/** The position of the first name in a tree, for messages. */
function posOf(n: ConditionNode): number {
  if (n.op === 'name') return n.pos;
  for (const v of Object.values(n)) {
    if (v && typeof v === 'object' && 'op' in (v as object)) {
      const p = posOf(v as ConditionNode);
      if (p) return p;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- binding helpers

/** A context's `param` that collects `$n` parameters into `params` (queries). */
export function bindTo(params: unknown[]): (v: unknown) => string {
  return (v) => {
    params.push(v);
    return `$${params.length}`;
  };
}

/** A context's `param` that writes a safe SQL literal (view definitions can't take parameters). */
export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ConditionCompileError('a number must be finite', 0);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------- one record

/**
 * Evaluates a condition on one record: `select (<sql>) as holds, <names> from domain_read.<table>
 * where id = $1`, under `db`'s actor (so row rules and field access apply). `values` holds the
 * names the condition read, by name. A record that isn't there (or isn't visible) doesn't hold.
 */
export async function evaluateCondition(
  db: Queryable, def: EntityTypeDef, entities: Record<string, EntityTypeDef>, recordId: string, condition: string,
  opts: { params?: Record<string, unknown> } = {},
): Promise<{ holds: boolean; values: Record<string, unknown> }> {
  return evaluateOn(db, def, entities, recordId, condition, opts);
}
