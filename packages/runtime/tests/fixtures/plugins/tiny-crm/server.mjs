#!/usr/bin/env node
// A tiny stdio MCP server for the kernel's tests (no dependencies): newline-delimited JSON-RPC
// with initialize, tools/list and tools/call. Contacts live in memory; create_contact adds one
// (keyed by the idempotency key in _meta, so a retried call adds nothing).
import { createInterface } from 'node:readline';

const contacts = [
  { id: 'c1', company_name: 'Acme Traders Private Limited', email: 'ACCOUNTS@acme-traders.example ', gst_number: '29aaaca1234a1z5', city: 'Bengaluru' },
  { id: 'c2', company_name: 'Menon Exports', email: 'hello@menon.example', gst_number: '', city: 'Kochi' },
  { id: 'c3', company_name: 'Zenith Bakers', email: 'zenith@bakers.example', gst_number: '', city: 'Pune' },
];
const byKey = new Map();
const contactSchema = { type: 'object', properties: { id: { type: 'string' }, company_name: { type: 'string' }, email: { type: 'string' }, gst_number: { type: 'string' }, city: { type: 'string' } } };

const tools = [
  { name: 'list_contacts', description: 'List the contacts in the CRM.', inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { contacts: { type: 'array', items: contactSchema } }, required: ['contacts'] },
    annotations: { readOnlyHint: true } },
  { name: 'get_contact', description: 'Read one contact by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true } },
  { name: 'create_contact', description: 'Add a contact to the CRM.',
    inputSchema: { type: 'object', properties: { company_name: { type: 'string' }, email: { type: 'string' } }, required: ['company_name'] } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function call(name, args, meta) {
  switch (name) {
    case 'list_contacts': return { structuredContent: { contacts }, content: [{ type: 'text', text: JSON.stringify({ contacts }) }] };
    case 'get_contact': {
      const c = contacts.find((x) => x.id === args.id);
      return c ? text({ contact: c }) : { isError: true, content: [{ type: 'text', text: `no contact ${args.id}` }] };
    }
    case 'create_contact': {
      const key = meta?.idempotencyKey;
      if (key && byKey.has(key)) return text({ id: byKey.get(key), repeated: true, idempotencyKey: key });
      const id = `c${contacts.length + 1}`;
      contacts.push({ id, company_name: args.company_name, email: args.email ?? '', gst_number: '', city: '' });
      if (key) byKey.set(key, id);
      return text({ id, repeated: false, idempotencyKey: key ?? null });
    }
    case 'fail': return { isError: true, content: [{ type: 'text', text: 'the CRM is down' }] };
    default: return null;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tiny-crm', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const r = call(msg.params?.name, msg.params?.arguments ?? {}, msg.params?._meta);
    if (r) send({ jsonrpc: '2.0', id: msg.id, result: r });
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${msg.params?.name}` } });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
});
