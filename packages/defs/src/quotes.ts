/**
 * Quotes (docs/memwise/25-literature-poc.md §4, D81, D82): whether some words appear in a
 * source, checked by code and never by a model. One normaliser for the step engine (quotes on
 * judgement writes, against the tool results the step saw) and the records (a `quote_of` field,
 * against the referenced record's text), so both agree on what "the same words" means.
 *
 * Both sides are normalised the same way: Unicode NFKC, the middle dot `·` read as `.` (The
 * Lancet writes 46·9%), every dash and minus sign read as `-`, curly quotes as straight ones,
 * runs of whitespace as one space, and case folded.
 */

/** Hyphens, dashes and minus signs (U+2010–U+2015, U+2212, small and full-width forms). */
const DASHES = /[‐-―−﹘﹣－]/g;
/** The middle dot and its look-alikes used as a decimal point. */
const DOTS = /[·‧∙⋅・]/g;
const SINGLE_QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;

/** Text as the quote checks compare it. */
export function normalizeQuoteText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DOTS, '.')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One code point as the normaliser has it (whitespace is collapsed by the caller). */
const normalizeChar = (ch: string): string => normalizeQuoteText(ch) || (/\s/.test(ch) ? ' ' : '');

/**
 * Where `quote` is in `text` (UTF-16 offsets into `text`, `end` exclusive), comparing as
 * `quoteIn` does, for a page that lights the quote up. Undefined when it isn't there.
 */
export function findQuote(quote: string, text: string): { start: number; end: number } | undefined {
  const q = normalizeQuoteText(quote);
  if (!q) return undefined;
  // The normalised text, with the offset in `text` each of its characters came from.
  let norm = '';
  const from: number[] = [];
  let i = 0;
  for (const ch of text) {
    const n = normalizeChar(ch);
    for (const c of n) {
      if (c === ' ' && (norm === '' || norm.endsWith(' '))) continue;
      norm += c;
      from.push(i);
    }
    i += ch.length;
  }
  const at = norm.indexOf(q);
  if (at < 0) return undefined;
  const last = from[at + q.length - 1]!;
  return { start: from[at]!, end: last + (text.codePointAt(last)! > 0xffff ? 2 : 1) };
}

/** Whether `quote` is in `text` once both are normalised. An empty quote is in nothing. */
export function quoteIn(quote: string, text: string): boolean {
  const q = normalizeQuoteText(quote);
  return q.length > 0 && normalizeQuoteText(text).includes(q);
}

/** MCP tools often return JSON as text; look inside it too. */
function parsedJson(v: string): unknown {
  if (!/^\s*[[{]/.test(v)) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

/**
 * The texts in a value (a tool result, a record's values): every string at any depth, numbers
 * as written, and the strings inside JSON text. A quote is looked for in each one, so it can't
 * straddle two fields of a result.
 */
export function textsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    const inner = parsedJson(value);
    if (inner !== undefined) textsOf(inner, out);
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const x of value) textsOf(x, out);
  } else if (value && typeof value === 'object') {
    for (const x of Object.values(value)) textsOf(x, out);
  }
  return out;
}

/** Whether `quote` is in any text of `value` (see `textsOf`). */
export function quoteInValue(quote: string, value: unknown): boolean {
  const q = normalizeQuoteText(quote);
  return q.length > 0 && textsOf(value).some((t) => normalizeQuoteText(t).includes(q));
}
