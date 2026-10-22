#!/usr/bin/env node
// A scripted stand-in for the Anthropic Messages API, for walkthrough screenshots where no API key
// is available. It answers POST /v1/messages (streaming or not) with a reply picked by matching the
// last user message against a script. Not for tests of model behaviour.
//
//   node scripts/walkthrough/fake-anthropic.mjs [port] [script.json] [tools.mjs]
//
// script.json: [{ "match": "regex", "reply": "markdown" }, ...]; the first match wins. Requests
// whose system prompt asks for a title get a short title from the user's words.
// tools.mjs (optional) exports `toolReply(body)`: for a request it recognises (a playbook step's
// agent, by the tools it is offered), it returns `{ toolCalls: [{ name, input }] }` with the wire
// tool names (`step__finish`), and the server answers with those tool calls; `null` falls through
// to the script.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 8787)
const script = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : []
const tools = process.argv[4] ? await import(new URL(process.argv[4], `file://${process.cwd()}/`).href) : null
const FALLBACK = "I can't answer that in this walkthrough: it runs on scripted replies, not a real model."

function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const t = textOf(m.content).trim()
    if (t) return t
  }
  return ''
}

function systemText(system) {
  return typeof system === 'string' ? system : (system ?? []).map(b => b.text ?? '').join('\n')
}

function replyFor(body) {
  const user = lastUserText(body.messages ?? [])
  const sys = systemText(body.system)
  // A title request has no tools; a chat whose tools mention titles (page_create) is not one.
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  if (!hasTools && /\btitle\b/i.test(sys) && /(generate|create|write).{0,40}title/i.test(sys + user)) {
    // The question itself, cut short: the app names chats this way.
    const words = user.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
    return words.replace(/[?.!]+$/, '') || 'Chat'
  }
  // The person's own words come last in the turn; system reminders may be wrapped around them.
  const plain = user.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  // Context the app puts before the person's words (a page, a record) may hold any text, so their
  // last paragraph is matched first, then the whole turn.
  const last = plain.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').trim().split(/\n\s*\n/).filter(Boolean).pop() ?? plain
  for (const text of [last, plain]) {
    for (const s of script) {
      if (new RegExp(s.match, 'i').test(text)) return s.reply
    }
  }
  return FALLBACK
}

function usage(text) {
  return { input_tokens: 1200, output_tokens: Math.max(1, Math.round(text.length / 4)), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 1200 }))
      return
    }
    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', type: 'model', display_name: 'Sonnet 5.5' }], has_more: false }))
      return
    }
    if (req.method !== 'POST' || !url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: url } }))
      return
    }
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* empty */ }
    const model = body.model ?? 'claude-sonnet-5-5'
    const id = `msg_fake_${Date.now().toString(36)}`
    let calls = null
    try { calls = tools?.toolReply(body)?.toolCalls ?? null } catch (e) { console.error('[fake-anthropic] tools.mjs failed', e) }
    if (calls?.length) {
      const blocks = calls.map((c, i) => ({ type: 'tool_use', id: `toolu_fake_${Date.now().toString(36)}_${i}`, name: c.name, input: c.input ?? {} }))
      console.log(`[fake-anthropic] tools ${model}: ${blocks.map(b => b.name).join(', ')}`)
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: 'tool_use', stop_sequence: null, usage: usage('x'.repeat(200)) }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage(''), output_tokens: 1 } } })
      blocks.forEach((b, index) => {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
        send('content_block_stop', { type: 'content_block_stop', index })
      })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 50 } })
      send('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    const text = replyFor(body)
    console.log(`[fake-anthropic] ${body.stream ? 'stream' : 'json'} ${model}: ${JSON.stringify(lastUserText(body.messages ?? []).slice(-80))} -> ${JSON.stringify(text.slice(0, 60))}`)
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: usage(text) }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage(''), output_tokens: 1 } } })
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    const chunks = text.match(/[\s\S]{1,24}/g) ?? ['']
    let i = 0
    const tick = () => {
      if (i < chunks.length) {
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i++] } })
        setTimeout(tick, 15)
        return
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage(text).output_tokens } })
      send('message_stop', { type: 'message_stop' })
      res.end()
    }
    tick()
  })
})

server.listen(port, '127.0.0.1', () => console.log(`[fake-anthropic] listening on http://127.0.0.1:${port}`))
