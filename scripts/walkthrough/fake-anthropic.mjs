#!/usr/bin/env node
// A scripted stand-in for the Anthropic Messages API, for walkthrough screenshots where no API key
// is available. It answers POST /v1/messages (streaming or not) with a reply picked by matching the
// last user message against a script; scripted tool calls only (see below). Not for tests of model behaviour.
//
//   node scripts/walkthrough/fake-anthropic.mjs [port] [script.json]
//
// script.json: [{ "match": "regex", "reply": "markdown" }, ...]; the first match wins. Requests
// whose system prompt asks for a title get a short title from the user's words.
//
// An entry may also name tools to call first: { "match", "tools": [{ "name": "playbook_write",
// "input": {...} }, ...], "reply" }. The turn then calls them one after another, as a model would
// (the name matches the request's tool whose name ends with it, e.g. mcp__session__playbook_write),
// and gives the reply once their results are back. The calls are written in advance too.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 8787)
const script = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : []
const FALLBACK = "I can't answer that in this walkthrough: it runs on scripted replies, not a real model."

function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

const isToolResult = (m) => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')

/** The index of the person's last message: tool results are not the person's words. */
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || isToolResult(m)) continue
    if (textOf(m.content).trim()) return i
  }
  return -1
}

function lastUserText(messages) {
  const i = lastUserIndex(messages)
  return i >= 0 ? textOf(messages[i].content).trim() : ''
}

/** How many tools the model has called since the person last wrote. */
function callsSinceUser(messages) {
  let n = 0
  for (let j = lastUserIndex(messages) + 1; j < messages.length; j++) {
    const m = messages[j]
    if (m.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter(b => b.type === 'tool_use').length
  }
  return n
}

function systemText(system) {
  return typeof system === 'string' ? system : (system ?? []).map(b => b.text ?? '').join('\n')
}

/** The reply: { text } or { tool: { name, input } } for the next scripted tool call. */
function replyFor(body) {
  const messages = body.messages ?? []
  const user = lastUserText(messages)
  const sys = systemText(body.system)
  // A title request has no tools; a chat whose tools mention titles (page_create) is not one.
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  if (!hasTools && /\btitle\b/i.test(sys) && /(generate|create|write).{0,40}title/i.test(sys + user)) {
    // The question itself, cut short: the app names chats this way.
    const words = user.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
    return { text: words.replace(/[?.!]+$/, '') || 'Chat' }
  }
  // The person's own words come last in the turn; system reminders may be wrapped around them.
  const plain = user.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  // Context the app puts before the person's words (a page, a record) may hold any text, so their
  // last paragraph is matched first, then the whole turn.
  const last = plain.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').trim().split(/\n\s*\n/).filter(Boolean).pop() ?? plain
  for (const text of [last, plain]) {
    for (const s of script) {
      if (!new RegExp(s.match, 'i').test(text)) continue
      const next = (s.tools ?? [])[callsSinceUser(messages)]
      if (next) {
        const tool = (body.tools ?? []).find(t => t.name === next.name || t.name.endsWith(`__${next.name}`))
        if (tool) return { tool: { name: tool.name, input: next.input ?? {} } }
        console.log(`[fake-anthropic] no tool ${next.name} offered; answering instead`)
      }
      return { text: s.reply }
    }
  }
  return { text: FALLBACK }
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
    const answer = replyFor(body)
    const text = answer.text ?? ''
    const model = body.model ?? 'claude-sonnet-5-5'
    const id = `msg_fake_${Date.now().toString(36)}`
    const toolId = `toolu_fake_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    console.log(`[fake-anthropic] ${body.stream ? 'stream' : 'json'} ${model}: ${JSON.stringify(lastUserText(body.messages ?? []).slice(-80))} -> ${answer.tool ? `tool ${answer.tool.name}` : JSON.stringify(text.slice(0, 60))}`)
    if (!body.stream) {
      const content = answer.tool ? [{ type: 'tool_use', id: toolId, name: answer.tool.name, input: answer.tool.input }] : [{ type: 'text', text }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content, stop_reason: answer.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: usage(text || JSON.stringify(answer.tool?.input ?? '')) }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage(''), output_tokens: 1 } } })
    if (answer.tool) {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: answer.tool.name, input: {} } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.tool.input) } })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } })
      send('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
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
