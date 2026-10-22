// A page's body (26 §4): markdown with fenced blocks. Written blocks (`chart`, `tiles`, `table`)
// are frozen when the page is written; live blocks (`records`, `subpages`) are recomputed each
// time the page opens. This module reads bodies without a database: fences, sections, the
// headline, the numbers, and how two bodies differ (the compare step of "Refresh a page").

/** A fenced block: its language, its text and where it sits in the body. */
export interface Fence { lang: string; body: string; start: number; end: number }

/** The fenced blocks the page renderer draws (the chart kit's and the pages' own). */
export const PAGE_BLOCKS = ['chart', 'tiles', 'table', 'records', 'subpages'] as const;
export type PageBlockKind = (typeof PAGE_BLOCKS)[number];
/** Blocks recomputed when the page opens. */
export const LIVE_BLOCKS: readonly PageBlockKind[] = ['records', 'subpages'];

const FENCE = /^(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/gm;

/** The body's fenced blocks, in order. */
export function fences(body: string): Fence[] {
  const out: Fence[] = [];
  for (const m of body.matchAll(FENCE)) out.push({ lang: m[2] ?? '', body: m[3] ?? '', start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** The body with some fences' text replaced: `fn` returns the new text, or undefined to keep it. */
export async function replaceFences(body: string, fn: (fence: Fence, index: number) => Promise<string | undefined> | string | undefined): Promise<string> {
  const list = fences(body);
  let out = '';
  let at = 0;
  for (const [i, f] of list.entries()) {
    const next = await fn(f, i);
    out += body.slice(at, f.start);
    out += next === undefined ? body.slice(f.start, f.end) : `\`\`\`${f.lang}\n${next}\n\`\`\``;
    at = f.end;
  }
  return out + body.slice(at);
}

/** A section of a body: the text before the first `##` heading (no heading), then one per `##`. */
export interface Section { heading?: string; markdown: string }

/** The body cut at its `##` headings (headings inside fences don't count). */
export function sections(body: string): Section[] {
  const ranges = fences(body).map((f) => [f.start, f.end] as const);
  const inFence = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const cuts: { at: number; heading: string; end: number }[] = [];
  for (const m of body.matchAll(/^##[ \t]+(.+?)[ \t#]*$/gm)) {
    if (!inFence(m.index!)) cuts.push({ at: m.index!, heading: m[1]!.trim(), end: m.index! + m[0].length });
  }
  const out: Section[] = [];
  const pre = body.slice(0, cuts[0]?.at ?? body.length).trim();
  if (pre) out.push({ markdown: pre });
  cuts.forEach((c, i) => out.push({ heading: c.heading, markdown: body.slice(c.end, cuts[i + 1]?.at ?? body.length).trim() }));
  return out;
}

/** Markdown as plain words: links as their text, no emphasis, no code, one space between words. */
export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The page's headline: its first paragraph of prose before any section (not a heading, a fence,
 * a table or a quote), in plain words.
 */
export function headline(body: string): string {
  const ranges = fences(body).map((f) => [f.start, f.end] as const);
  let pos = 0;
  for (const para of body.split(/\n\s*\n/)) {
    const start = body.indexOf(para, pos);
    pos = start + para.length;
    const t = para.trim();
    if (!t || ranges.some(([a, b]) => start >= a && start < b)) continue;
    if (/^##\s/.test(t)) break;
    if (/^(#|\||>|```|~~~|[-*]\s|\d+\.\s|<)/.test(t)) continue;
    return plainText(t);
  }
  return '';
}

/**
 * The numbers a text gives, as written (thousands separators dropped, any minus sign as `-`):
 * `9`, `13`, `-15.1%`, `3127`. A refresh that adds, drops or changes one changed the answer.
 */
export function numbersIn(text: string): string[] {
  const t = plainText(text).replace(/[−–](?=\d)/g, '-');
  const out: string[] = [];
  for (const m of t.matchAll(/(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?<![\w.])-?\d+(?:\.\d+)?%?/g)) out.push(m[0].replace(/,/g, ''));
  return out;
}

/** Each item's count, so a number given twice and then once is a change. */
function multiset(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function minus(a: string[], b: string[]): string[] {
  const left = multiset(b);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** How two bodies differ, as the compare step of "Refresh a page" sees it (26 §4). */
export interface BodyComparison {
  /** The answer changed: its headline's numbers, a section, or any number on the page. */
  material: boolean;
  /** The bodies are the same apart from spacing. */
  same: boolean;
  before: string;
  after: string;
  headlineChanged: boolean;
  added: Section[];
  removed: string[];
  changed: Section[];
  numbers: { added: string[]; removed: string[] };
}

export function compareBodies(before: string, after: string): BodyComparison {
  const a = sections(before);
  const b = sections(after);
  const key = (s: Section) => (s.heading ?? '').toLowerCase();
  const byKey = new Map(a.map((s) => [key(s), s]));
  const afterKeys = new Set(b.map(key));
  const added = b.filter((s) => s.heading && !byKey.has(key(s)));
  const removed = a.filter((s) => s.heading && !afterKeys.has(key(s))).map((s) => s.heading!);
  const changed = b.filter((s) => byKey.has(key(s)) && norm(byKey.get(key(s))!.markdown) !== norm(s.markdown));
  const numbers = { added: minus(numbersIn(after), numbersIn(before)), removed: minus(numbersIn(before), numbersIn(after)) };
  const h0 = headline(before);
  const h1 = headline(after);
  const headlineChanged = norm(h0) !== norm(h1);
  const headlineNumbers = minus(numbersIn(h1), numbersIn(h0)).length + minus(numbersIn(h0), numbersIn(h1)).length > 0;
  const same = norm(before) === norm(after);
  const material = !same && (headlineNumbers || added.length > 0 || removed.length > 0 || numbers.added.length + numbers.removed.length > 0);
  return { material, same, before: h0, after: h1, headlineChanged, added, removed, changed, numbers };
}

/**
 * The sections a version changed against the one before (`''` for the text before the first
 * heading): what the page marks "Changed from chat · Undo".
 */
export function changedSections(before: string, after: string): string[] {
  const a = new Map(sections(before).map((s) => [s.heading ?? '', norm(s.markdown)]));
  return sections(after).filter((s) => a.get(s.heading ?? '') !== norm(s.markdown)).map((s) => s.heading ?? '');
}

/** A fence's JSON body, or undefined when it isn't JSON. */
export function blockJson(f: Fence): unknown {
  try { return JSON.parse(f.body); } catch { return undefined; }
}
