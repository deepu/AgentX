/**
 * Editing a step file (`steps/<state>.md`: YAML front matter, then the instructions in Markdown)
 * by text replacement, so everything the editor does not touch (writes, tools, budget, comments,
 * key order) stays exactly as written. Pure.
 */

/** The parts of a step the editor changes; anything absent stays as it is. */
export interface StepFileEdit {
  title?: string
  performer?: 'agent' | 'person' | 'external' | 'system'
  /** `null` removes the key. */
  assignee?: string | null
  strictness?: 'strict' | 'guided' | 'open'
  checkpoint?: string[]
  instructions?: string
}

/** Splits `---\n<yaml>\n---\n<body>` like the loader does; undefined when there is no front matter. */
export function splitStepFile(text: string): { front: string; body: string; newline: string } | undefined {
  const m = /^﻿?---[ \t]*(\r?\n)(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!m) return undefined
  return { newline: m[1]!, front: m[2] ?? '', body: m[3]! }
}

/** A YAML scalar: plain when that reads back as the same string, else double-quoted (JSON is valid YAML). */
export function yamlScalar(value: string): string {
  const plain = value.trim() === value
    && value.length > 0
    && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
    && !/[:#]\s|\s#|:$/.test(value)
    && !/^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?)$/i.test(value)
    && !/[\n\r\t]/.test(value)
  return plain ? value : JSON.stringify(value)
}

/** Lines of the top-level key `key` (the key line and its indented or list continuation lines). */
function keyBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const start = lines.findIndex(l => re.test(l))
  if (start === -1) return undefined
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]!
    if (line.trim() === '' || /^\s/.test(line) || /^-(\s|$)/.test(line)) end++
    else break
  }
  // Trailing blank lines belong to the gap, not the block
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--
  return { start, end }
}

/** Replaces (or adds, after `after` keys when present, else at the end) or removes a top-level key. */
function setKey(lines: string[], key: string, replacement: string[] | null, after: string[] = []): string[] {
  const block = keyBlock(lines, key)
  if (block) {
    return [...lines.slice(0, block.start), ...(replacement ?? []), ...lines.slice(block.end)]
  }
  if (!replacement) return lines
  for (const a of after) {
    const anchor = keyBlock(lines, a)
    if (anchor) return [...lines.slice(0, anchor.end), ...replacement, ...lines.slice(anchor.end)]
  }
  // Before trailing blank lines
  let at = lines.length
  while (at > 0 && lines[at - 1]!.trim() === '') at--
  return [...lines.slice(0, at), ...replacement, ...lines.slice(at)]
}

/**
 * Applies the editor's changes to a step file's text. Front matter keys are replaced in place;
 * the instructions replace the body. Throws when the text has no front matter (not a step file).
 */
export function applyStepEdit(text: string, edit: StepFileEdit): string {
  const parts = splitStepFile(text)
  if (!parts) throw new Error('not a step file: it has no front matter')
  const nl = parts.newline
  let lines = parts.front === '' ? [] : parts.front.split(/\r?\n/)

  if (edit.title !== undefined) lines = setKey(lines, 'title', [`title: ${yamlScalar(edit.title)}`])
  if (edit.performer !== undefined) lines = setKey(lines, 'performer', [`performer: ${edit.performer}`], ['title'])
  if (edit.assignee !== undefined) {
    lines = setKey(lines, 'assignee', edit.assignee ? [`assignee: ${yamlScalar(edit.assignee)}`] : null, ['performer', 'title'])
  }
  if (edit.strictness !== undefined) lines = setKey(lines, 'strictness', [`strictness: ${edit.strictness}`], ['assignee', 'performer', 'title'])
  if (edit.checkpoint !== undefined) {
    const rules = edit.checkpoint.map(r => r.trim()).filter(Boolean)
    lines = setKey(lines, 'checkpoint', rules.length ? ['checkpoint:', ...rules.map(r => `  - ${yamlScalar(r)}`)] : null, ['budget', 'model', 'tools', 'writes', 'reads'])
  }

  let body = parts.body
  if (edit.instructions !== undefined) {
    const instructions = edit.instructions.replace(/\r\n/g, '\n').trim()
    body = instructions ? `${instructions}${nl}` : ''
    if (nl !== '\n') body = body.replace(/\n/g, nl)
  }
  return `---${nl}${lines.join(nl)}${lines.length ? nl : ''}---${nl}${body}`
}

/** Reads the editor's starting values back out of a step file's text (title, checkpoint, instructions). */
export function readStepFile(text: string): { instructions: string } | undefined {
  const parts = splitStepFile(text)
  return parts ? { instructions: parts.body.trim() } : undefined
}
