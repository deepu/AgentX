/**
 * Finding extraction quotes in a PDF's text layer (24 §11): the viewer highlights the boxes of
 * the text items a quote spans, and lists the quotes it could not find.
 *
 * pdf.js splits text into items at arbitrary points ("14 Mar", " 2026"), so matching ignores
 * whitespace and case, and maps each matched character back to its item and offset.
 */

export interface QuoteQuery { quote: string; page?: number }

export interface ItemRange { item: number; start: number; end: number }

export interface QuoteMatch { quote: number; page: number; ranges: ItemRange[] }

interface Char { item: number; off: number }

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKC')
}

/** Every non-space character of a page, lower-cased, with where it came from. */
function pageChars(items: string[]): { text: string; chars: Char[] } {
  let text = ''
  const chars: Char[] = []
  items.forEach((raw, item) => {
    // Offsets stay in the raw item (lower-casing can change a character's length).
    for (let off = 0; off < raw.length; off++) {
      for (const ch of normalize(raw[off]!)) {
        if (/\s/.test(ch)) continue
        text += ch
        chars.push({ item, off })
      }
    }
  })
  return { text, chars }
}

function toRanges(chars: Char[]): ItemRange[] {
  const ranges: ItemRange[] = []
  for (const c of chars) {
    const last = ranges[ranges.length - 1]
    if (last && last.item === c.item) last.end = Math.max(last.end, c.off + 1)
    else ranges.push({ item: c.item, start: c.off, end: c.off + 1 })
  }
  return ranges
}

/**
 * Find each quote, on its stated page first and then on the others.
 * `pages[n]` holds the text items of page n + 1.
 */
export function findQuotes(pages: string[][], queries: QuoteQuery[]): { matches: QuoteMatch[]; missing: number[] } {
  const indexed = pages.map(pageChars)
  const matches: QuoteMatch[] = []
  const missing: number[] = []
  queries.forEach((q, quote) => {
    const needle = normalize(q.quote).replace(/\s+/g, '')
    if (!needle) { missing.push(quote); return }
    const order = pages.map((_, i) => i)
    if (q.page && q.page >= 1 && q.page <= pages.length) {
      order.splice(q.page - 1, 1)
      order.unshift(q.page - 1)
    }
    for (const p of order) {
      const at = indexed[p]!.text.indexOf(needle)
      if (at >= 0) {
        matches.push({ quote, page: p + 1, ranges: toRanges(indexed[p]!.chars.slice(at, at + needle.length)) })
        return
      }
    }
    missing.push(quote)
  })
  return { matches, missing }
}

/** The ranges per text item on one page: `pageNumber` → item index → ranges with their quote. */
export function rangesByItem(matches: QuoteMatch[], pageNumber: number): Map<number, (ItemRange & { quote: number })[]> {
  const out = new Map<number, (ItemRange & { quote: number })[]>()
  for (const m of matches) {
    if (m.page !== pageNumber) continue
    for (const r of m.ranges) {
      const list = out.get(r.item) ?? []
      list.push({ ...r, quote: m.quote })
      out.set(r.item, list)
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start)
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The HTML a text item renders as (react-pdf's customTextRenderer): the item's text with the
 * matched parts wrapped in `<mark data-quote="n">`; `active` marks the quote picked in the form.
 */
export function highlightItemHtml(str: string, ranges: (ItemRange & { quote: number })[] | undefined, active?: number | null): string {
  if (!ranges?.length) return escapeHtml(str)
  let out = ''
  let pos = 0
  for (const r of ranges) {
    const start = Math.max(r.start, pos)
    if (start >= r.end) continue
    out += escapeHtml(str.slice(pos, start))
    const cls = r.quote === active ? 'mw-quote mw-quote-active' : 'mw-quote'
    out += `<mark class="${cls}" data-quote="${r.quote}">${escapeHtml(str.slice(start, r.end))}</mark>`
    pos = r.end
  }
  return out + escapeHtml(str.slice(pos))
}

// ---------------------------------------------------------------- plain text (25 §4)

/**
 * A Text field's quotes (25 §4): matched the way the kernel checks them, after Unicode NFKC,
 * case folding, `·` read as `.`, dashes as `-`, curly quotes as straight ones, and whitespace
 * collapsed to one space. Each match maps back to offsets in the original text, so the viewer
 * can wrap exactly those characters. The kernel sends each quote's offsets; this finds the ones
 * it doesn't.
 */
export interface TextQuoteRange { quote: number; start: number; end: number }

/** A quote a Text viewer lights up. */
export interface TextQuote {
  quote: string
  /** The field it was quoted for, in words ("Sample size", "Evidence · Effect"). */
  label: string
  /** The field's name, for `data-quote-field` and picking. */
  field?: string
  /** Where the kernel found it (UTF-16 offsets, `end` exclusive); absent: the viewer looks. */
  start?: number
  end?: number
  /** false: the kernel did not find it in the text. */
  found?: boolean
  /** Shown on hover after the field ("Sample size: 1204"). */
  valueText?: string
}

// The kernel's sets (packages/defs/src/quotes.ts), so the page and the check agree.
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g
const DOTS = /[\u00b7\u2027\u2219\u22c5\u30fb]/g
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/g
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g

function foldChar(ch: string): string {
  return ch.normalize('NFKC').replace(DOTS, '.').replace(DASHES, '-').replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').toLowerCase()
}

/** A quote as the matcher compares it. */
export function normalizeQuote(text: string): string {
  return foldChar(text).replace(/\s+/g, ' ').trim()
}

/** The folded text with, for each of its characters, where it starts and ends in the original. */
function foldText(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let i = 0
  for (const cp of text) {
    const end = i + cp.length
    for (const ch of foldChar(cp)) {
      if (/\s/.test(ch)) {
        // Collapse runs of whitespace into one space (it ends where the run ends).
        if (folded.endsWith(' ')) { ends[ends.length - 1] = end; continue }
        if (!folded) continue
        folded += ' '
      } else {
        folded += ch
      }
      starts.push(i)
      ends.push(end)
    }
    i = end
  }
  return { folded, starts, ends }
}

/** Where each quote is in `text` (its first occurrence), and the ones that aren't there. */
export function findTextQuotes(text: string, quotes: string[]): { ranges: TextQuoteRange[]; missing: number[] } {
  const { folded, starts, ends } = foldText(text)
  const ranges: TextQuoteRange[] = []
  const missing: number[] = []
  quotes.forEach((q, quote) => {
    const needle = normalizeQuote(q)
    const at = needle ? folded.indexOf(needle) : -1
    if (at < 0) { missing.push(quote); return }
    ranges.push({ quote, start: starts[at]!, end: ends[at + needle.length - 1]! })
  })
  return { ranges, missing }
}

/** The text cut at every quote boundary: each piece with the quotes covering it (none: plain text). */
export function textSegments(text: string, ranges: TextQuoteRange[]): { start: number; end: number; quotes: number[] }[] {
  const cuts = [...new Set([0, text.length, ...ranges.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b)
  const out: { start: number; end: number; quotes: number[] }[] = []
  for (let k = 0; k < cuts.length - 1; k++) {
    const start = cuts[k]!
    const end = cuts[k + 1]!
    if (end <= start) continue
    out.push({ start, end, quotes: ranges.filter(r => r.start <= start && r.end >= end).map(r => r.quote) })
  }
  return out
}
