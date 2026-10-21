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
