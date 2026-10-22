// Tool replies for fake-anthropic.mjs in the regulated walkthrough (regulated-etmf.mjs): the eTMF
// example's classifier and verifier, as in packages/runtime/tests/fixtures/regulated-fakes.ts.
//
// The classifier reads the Document record, then finishes `classified` with the index the
// walkthrough registered for the file's name (in the JSON file $WALKTHROUGH_INDEX), quoting the
// artifact; an unsigned CV says so in its rationale. The verifier fails a rule about a signature
// when the proposal says the document isn't signed, and passes every other rule.
import { readFileSync } from 'node:fs'

const UNSIGNED = /not signed|unsigned|no signature|signature line is empty/i

const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''))
const requestText = (body) => [typeof body.system === 'string' ? body.system : (body.system ?? []).map(b => b.text ?? '').join('\n'), ...(body.messages ?? []).map(m => textOf(m.content))].join('\n')

/** The rules a verifier request lists, in order. */
function rulesOf(text) {
  const block = text.split('## Rules')[1]?.split('## Proposed result')[0] ?? ''
  return block.split(/\\n|\n/).map(l => /^\d+\.\s+(.*)$/.exec(l.trim())?.[1]).filter(Boolean)
}

function index() {
  try { return JSON.parse(readFileSync(process.env.WALKTHROUGH_INDEX ?? '', 'utf8')) } catch { return {} }
}

export function toolReply(body) {
  const offered = new Set((body.tools ?? []).map(t => t.name))
  const text = requestText(body)
  const toolTurns = (body.messages ?? []).filter(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use')).length

  if (offered.has('checkpoint__verdict')) {
    const [, proposal = ''] = text.split('## Proposed result')
    return { toolCalls: [{ name: 'checkpoint__verdict', input: { results: rulesOf(text).map((rule, i) => {
      const fails = /\bsign/i.test(rule) && UNSIGNED.test(proposal)
      return { rule: i + 1, passed: !fails, reason: fails ? 'The document is not signed, as the result itself says.' : 'Holds on the evidence.' }
    }) } }] }
  }

  if (offered.has('step__finish') && offered.has('etmf__document__get')) {
    const doc = /\bdocu_[A-Za-z0-9]+/.exec(text)?.[0]
    const files = index()
    const name = Object.keys(files).sort((a, b) => b.length - a.length).find(n => text.includes(n))
    if (!doc || !name) return null
    if (toolTurns === 0) return { toolCalls: [{ name: 'etmf__document__get', input: { id: doc } }] }
    const { signed, ...writes } = files[name]
    return { toolCalls: [{ name: 'step__finish', input: {
      outcome: 'classified', writes,
      quotes: { artifact: writes.artifact },
      rationale: signed
        ? `${writes.artifact}, signed and dated on the last page; the expected document of its site.`
        : `${writes.artifact}: the CV is not signed, the signature line is empty.`,
    } }] }
  }
  return null
}
