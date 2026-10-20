/**
 * The small, safe part of Markdown a step's instructions use: paragraphs, **bold**, *italic*,
 * `- ` and `1. ` lists, headings shown as bold lines, and links shown as their words (with the
 * address after them as plain text). It produces plain data that React renders as text, so no
 * HTML from the instructions ever reaches the page.
 */

export interface Inline { text: string; bold?: boolean; italic?: boolean }

export type Block =
  | { kind: 'p'; inlines: Inline[] }
  | { kind: 'h'; inlines: Inline[] }
  | { kind: 'ul' | 'ol'; items: Inline[][] }

const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^\s*#{1,6}\s+(.*)$/

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', inlines: parseInline(para.join(' ')) })
    para = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: list.kind, items: list.items.map(parseInline) })
    list = null
  }

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) { flushPara(); flushList(); continue }
    const h = HEADING.exec(line)
    if (h) { flushPara(); flushList(); blocks.push({ kind: 'h', inlines: parseInline(h[1]!) }); continue }
    const b = BULLET.exec(line)
    const n = b ? null : NUMBERED.exec(line)
    if (b || n) {
      flushPara()
      const kind = b ? 'ul' : 'ol'
      if (list && list.kind !== kind) flushList()
      list ??= { kind, items: [] }
      list.items.push((b ?? n)![1]!)
      continue
    }
    // A line under a list item, indented: more of that item.
    if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}

/** Inline marks: links to their words, `code` to text, **bold**, *italic* / _italic_. */
export function parseInline(text: string): Inline[] {
  // Escaped marks (`\*`) are set aside first, so nothing below reads them as marks.
  const plain = text
    .replace(/\\([\\`*_[\]()#+\-.!<>])/g, (_m, c: string) => String.fromCharCode(PRIVATE + c.charCodeAt(0)))
    // ![alt](src): images are not shown; their description is.
    .replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    // [words](address) → "words (address)" for web and mail addresses; any other link, its words.
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, (_m, words: string, href: string) => {
      if (!/^(https?:|mailto:)/i.test(href)) return words
      const address = href.replace(/^mailto:/i, '')
      return words.trim() === address ? address : `${words} (${address})`
    })
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, (_m, href: string) => href.replace(/^mailto:/i, ''))
    .replace(/`([^`]+)`/g, '$1')

  const out: Inline[] = []
  // No look-behind: older iPhones can't parse it, and the page must open everywhere.
  const re = /(\*\*|__)(.+?)\1|(\*|_)(\S(?:.*?\S)?)\3/g
  let last = 0
  for (let m = re.exec(plain); m; m = re.exec(plain)) {
    // `_` inside a word (snake_case) is not emphasis.
    if (m[3] === '_' && /\w/.test(plain[m.index - 1] ?? '')) continue
    if (m.index > last) out.push({ text: plain.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ text: m[2], bold: true })
    else out.push({ text: m[4]!, italic: true })
    last = m.index + m[0].length
  }
  if (last < plain.length) out.push({ text: plain.slice(last) })
  return merge(out).map(x => ({ ...x, text: x.text.replace(/[-]/g, c => String.fromCharCode(c.charCodeAt(0) - PRIVATE)) }))
}

/** Escaped characters wait in Unicode's private use area while the marks are read. */
const PRIVATE = 0xe000

function merge(list: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const x of list) {
    if (!x.text) continue
    const prev = out[out.length - 1]
    if (prev && !!prev.bold === !!x.bold && !!prev.italic === !!x.italic) prev.text += x.text
    else out.push({ ...x })
  }
  return out
}
