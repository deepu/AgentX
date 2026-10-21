#!/usr/bin/env node
// A scripted stand-in for the Anthropic Messages API, for walkthrough screenshots where no API key
// is available. It answers POST /v1/messages (streaming or not) with a reply picked by matching the
// last user message against a script. Not for tests of model behaviour.
//
//   node scripts/walkthrough/fake-anthropic.mjs [port] [script.json]
//
// script.json: [{ "match": "regex", "reply": "markdown" }, ...]; the first match wins. Requests
// whose system prompt asks for a title get a short title from the user's words. An entry may call
// one tool instead: { "match": "regex", "tool": { "name": "project_draft", "input": {...} } } (the
// offered tool whose name ends with `name`); the turn after its result is answered by the entry
// { "afterTool": "project_draft", "reply": "markdown" }.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 8787)
const script = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : []
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

/** The tool whose result the last message carries, if it does. */
function answeredTool(messages) {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user' || typeof last.content === 'string') return undefined
  const result = last.content.find(b => b.type === 'tool_result')
  if (!result) return undefined
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    const use = m.content.find(b => b.type === 'tool_use' && b.id === result.tool_use_id)
    if (use) return use.name
  }
  return undefined
}

/** `{ text }`, or `{ tool: { name, input } }` with the offered tool's full name. */
function turnFor(body) {
  const answered = answeredTool(body.messages ?? [])
  if (answered) {
    const s = script.find(x => x.afterTool && answered.endsWith(x.afterTool))
    return { text: s?.reply ?? 'Done.' }
  }
  const plain = lastUserText(body.messages ?? []).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  for (const s of script) {
    if (!s.tool || !s.match || !new RegExp(s.match, 'i').test(plain)) continue
    const offered = (body.tools ?? []).find(t => t.name === s.tool.name || t.name.endsWith(`__${s.tool.name}`) || t.name.endsWith(s.tool.name))
    if (offered) return { tool: { name: offered.name, input: s.tool.input ?? {} }, text: s.reply ?? '' }
  }
  return { text: replyFor(body) }
}

function replyFor(body) {
  const user = lastUserText(body.messages ?? [])
  const sys = systemText(body.system)
  if (/\btitle\b/i.test(sys) && /(generate|create|write).{0,40}title/i.test(sys + user)) {
    // The question itself, cut short: the app names chats this way.
    const words = user.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
    return words.replace(/[?.!]+$/, '') || 'Chat'
  }
  // The person's own words come last in the turn; system reminders may be wrapped around them.
  const plain = user.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  for (const s of script) {
    if (!s.tool && s.match && new RegExp(s.match, 'i').test(plain)) return s.reply
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
    const turn = turnFor(body)
    const text = turn.text
    const model = body.model ?? 'claude-sonnet-5-5'
    const id = `msg_fake_${Date.now().toString(36)}`
    console.log(`[fake-anthropic] ${body.stream ? 'stream' : 'json'} ${model}: ${JSON.stringify(lastUserText(body.messages ?? []).slice(-80))} -> ${turn.tool ? `tool ${turn.tool.name}` : JSON.stringify(text.slice(0, 60))}`)
    const toolUse = turn.tool ? { type: 'tool_use', id: `toolu_fake_${Date.now().toString(36)}`, name: turn.tool.name, input: turn.tool.input } : null
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const content = [...(text ? [{ type: 'text', text }] : []), ...(toolUse ? [toolUse] : [])]
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content, stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null, usage: usage(text) }))
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
      if (toolUse) {
        send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } })
        send('content_block_stop', { type: 'content_block_stop', index: 1 })
      }
      send('message_delta', { type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage(text).output_tokens } })
      send('message_stop', { type: 'message_stop' })
      res.end()
    }
    tick()
  })
})

server.listen(port, '127.0.0.1', () => console.log(`[fake-anthropic] listening on http://127.0.0.1:${port}`))
