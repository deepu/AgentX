/**
 * The condition language (24 §5): guards, invariants, rollup filters, row formulas, view filters
 * and `wait_until`. A small recursive-descent parser into `ConditionNode`; `@memwise/db`
 * compiles the tree to SQL. Not a general formula language: no assignment, no user functions.
 */
import type { ConditionNode, ParsedCondition } from './domain-types.ts';

type Tok =
  | { t: 'num'; v: number; pct: boolean; pos: number }
  | { t: 'dur'; ms: number; src: string; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'end'; pos: number };

const KEYWORDS = new Set(['and', 'or', 'not', 'implies', 'is', 'set', 'in', 'true', 'false', 'null', 'today', 'now']);
export const CONDITION_FUNCTIONS = ['days_since', 'days_until', 'coalesce', 'lower', 'length'] as const;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };

class ConditionError extends Error { constructor(message: string, readonly pos: number) { super(message); } }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    if (/[0-9]/.test(c)) {
      const m = /^(\d+(?:\.\d+)?)(ms|[smhdwy](?![A-Za-z0-9_]))?(%)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (m[2]) out.push({ t: 'dur', ms: Math.round(Number(m[1]) * UNIT_MS[m[2]]!), src: m[0], pos: start });
      else out.push({ t: 'num', v: Number(m[1]), pct: !!m[3], pos: start });
      if (/[A-Za-z_]/.test(src[i] ?? '')) throw new ConditionError(`\`${src.slice(start, i + 1)}…\` is not a number or a duration (like 30d)`, start);
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        v += src[j++];
      }
      if (j >= src.length) throw new ConditionError('this text has no closing quote', start);
      out.push({ t: 'str', v, pos: start });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>', '=='].includes(two)) {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two === '==' ? '=' : two, pos: start });
      i += 2;
      continue;
    }
    if ('=<>+-*/(),'.includes(c)) { out.push({ t: 'op', v: c, pos: start }); i++; continue; }
    throw new ConditionError(`unexpected \`${c}\``, start);
  }
  out.push({ t: 'end', pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  readonly names: string[] = [];
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.i]!; }
  private next(): Tok { return this.toks[this.i++]!; }
  private isWord(w: string, tok = this.peek()) { return tok.t === 'name' && tok.v.toLowerCase() === w; }
  private isOp(o: string, tok = this.peek()) { return tok.t === 'op' && tok.v === o; }
  private expectOp(o: string) {
    const tok = this.next();
    if (!this.isOp(o, tok)) throw new ConditionError(`expected \`${o}\``, tok.pos);
  }

  parse(): ConditionNode {
    const node = this.or();
    const tok = this.peek();
    if (tok.t !== 'end') throw new ConditionError(`unexpected ${describe(tok)}`, tok.pos);
    return node;
  }

  private or(): ConditionNode {
    let left = this.and();
    while (this.isWord('or')) { this.next(); left = { op: 'or', left, right: this.and() }; }
    return left;
  }

  private and(): ConditionNode {
    let left = this.not();
    while (this.isWord('and')) { this.next(); left = { op: 'and', left, right: this.not() }; }
    return left;
  }

  private not(): ConditionNode {
    if (this.isWord('not')) { this.next(); return { op: 'not', arg: this.not() }; }
    return this.implies();
  }

  private implies(): ConditionNode {
    const left = this.cmp();
    if (this.isWord('implies')) { this.next(); return { op: 'implies', left, right: this.cmp() }; }
    return left;
  }

  private cmp(): ConditionNode {
    const left = this.sum();
    const tok = this.peek();
    if (tok.t === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(tok.v)) {
      this.next();
      return { op: tok.v as '=', left, right: this.sum() };
    }
    if (this.isWord('is')) {
      this.next();
      const negated = this.isWord('not') ? (this.next(), true) : false;
      const word = this.next();
      if (this.isWord('set', word)) return { op: negated ? 'is_not_set' : 'is_set', arg: left };
      if (this.isWord('null', word)) return { op: negated ? 'is_set' : 'is_not_set', arg: left };
      throw new ConditionError('expected `is set` or `is not set`', word.pos);
    }
    if (this.isWord('in')) {
      this.next();
      this.expectOp('(');
      const values: ConditionNode[] = [this.sum()];
      while (this.isOp(',')) { this.next(); values.push(this.sum()); }
      this.expectOp(')');
      return { op: 'in', arg: left, values };
    }
    return left;
  }

  private sum(): ConditionNode {
    let left = this.term();
    for (;;) {
      const tok = this.peek();
      if (!this.isOp('+') && !this.isOp('-')) return left;
      this.next();
      left = { op: (tok as { v: string }).v as '+', left, right: this.term() };
    }
  }

  private term(): ConditionNode {
    let left = this.unary();
    for (;;) {
      const tok = this.peek();
      if (!this.isOp('*') && !this.isOp('/')) return left;
      this.next();
      left = { op: (tok as { v: string }).v as '*', left, right: this.unary() };
    }
  }

  private unary(): ConditionNode {
    if (this.isOp('-')) { this.next(); return { op: 'neg', arg: this.unary() }; }
    return this.atom();
  }

  private atom(): ConditionNode {
    const tok = this.next();
    switch (tok.t) {
      case 'num': return { op: 'num', value: tok.v };
      case 'dur': return { op: 'duration', ms: tok.ms, source: tok.src };
      case 'str': return { op: 'str', value: tok.v };
      case 'end': throw new ConditionError('the condition ends too early', tok.pos);
      case 'op':
        if (tok.v === '(') {
          const inner = this.or();
          this.expectOp(')');
          return inner;
        }
        throw new ConditionError(`unexpected \`${tok.v}\``, tok.pos);
      case 'name': {
        const lower = tok.v.toLowerCase();
        if (lower === 'true' || lower === 'false') return { op: 'bool', value: lower === 'true' };
        if (lower === 'null') return { op: 'null' };
        if (lower === 'today') return { op: 'today' };
        if (lower === 'now') return { op: 'now' };
        if (this.isOp('(')) {
          if (!(CONDITION_FUNCTIONS as readonly string[]).includes(lower)) {
            throw new ConditionError(`\`${tok.v}\` is not a function here (${CONDITION_FUNCTIONS.join(', ')})`, tok.pos);
          }
          this.next();
          const args: ConditionNode[] = [];
          if (!this.isOp(')')) {
            args.push(this.or());
            while (this.isOp(',')) { this.next(); args.push(this.or()); }
          }
          this.expectOp(')');
          const want = lower === 'coalesce' ? undefined : 1;
          if (want !== undefined && args.length !== want) throw new ConditionError(`${lower} takes one value`, tok.pos);
          if (lower === 'coalesce' && args.length < 2) throw new ConditionError('coalesce takes two or more values', tok.pos);
          return { op: 'fn', name: lower as 'days_since', args };
        }
        if (KEYWORDS.has(lower)) throw new ConditionError(`unexpected \`${tok.v}\``, tok.pos);
        const name = tok.v.startsWith('record.') ? tok.v.slice('record.'.length) : tok.v;
        if (!this.names.includes(name)) this.names.push(name);
        return { op: 'name', name, pos: tok.pos };
      }
    }
  }
}

function describe(tok: Tok): string {
  switch (tok.t) {
    case 'end': return 'end';
    case 'num': return `number ${tok.v}`;
    case 'dur': return `duration ${tok.src}`;
    case 'str': return `text '${tok.v}'`;
    default: return `\`${tok.v}\``;
  }
}

/** Parses a condition. Never throws: problems come back in `errors` (with a 0-based position). */
export function parseCondition(source: string): ParsedCondition {
  if (typeof source !== 'string' || !source.trim()) {
    return { source: String(source ?? ''), names: [], errors: [{ message: 'the condition is empty', pos: 0 }] };
  }
  try {
    const parser = new Parser(tokenize(source));
    const ast = parser.parse();
    return { source, ast, names: parser.names, errors: [] };
  } catch (e) {
    if (e instanceof ConditionError) return { source, names: [], errors: [{ message: e.message, pos: e.pos }] };
    throw e;
  }
}

/** Every name a tree reads, in order of first use. */
export function conditionNames(node: ConditionNode): string[] {
  const out: string[] = [];
  const walk = (n: ConditionNode) => {
    switch (n.op) {
      case 'name': if (!out.includes(n.name)) out.push(n.name); return;
      case 'fn': n.args.forEach(walk); return;
      case 'not': case 'neg': case 'is_set': case 'is_not_set': walk(n.arg); return;
      case 'in': walk(n.arg); n.values.forEach(walk); return;
      case 'and': case 'or': case 'implies': case '=': case '!=': case '<': case '<=': case '>': case '>=':
      case '+': case '-': case '*': case '/':
        walk(n.left); walk(n.right); return;
      default: return;
    }
  };
  walk(node);
  return out;
}
