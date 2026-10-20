#!/usr/bin/env node
// The sample CRM's MCP server (docs/memwise/22-phase-4-interfaces.md §7): a few company contacts
// you can list, read and create, over stdio. Dependency-free on purpose: newline-delimited
// JSON-RPC 2.0, MCP protocol version 2025-06-18. Only protocol messages go to stdout; logs go to
// stderr.
//
// Environment:
//   SAMPLE_CRM_SEED   a JSON file holding an array of contacts to start from (default: three built-in ones)
//   SAMPLE_CRM_DATA   a JSON file the contacts are persisted to: read at start when it exists, written on create
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'sample-crm', title: 'Sample CRM', version: '1.0.0' };

const log = (...args) => process.stderr.write(`[sample-crm] ${args.join(' ')}\n`);

// ---------------------------------------------------------------- contacts

/** The built-in contacts. Acme's GST number is lower case on purpose (a mapping upper-cases it). */
const DEFAULT_CONTACTS = [
  { id: 'c-101', company_name: 'Acme Traders Pvt Ltd', email: 'accounts@acme-traders.example', gst_number: '29aaaca1234a1z5', phone: '+91 80 4000 1010' },
  { id: 'c-102', company_name: 'Menon Exports', email: 'ravi@menon-exports.example', phone: '+91 22 4000 2020' },
  { id: 'c-103', company_name: 'Zenith Logistics', email: 'ops@zenith-logistics.example', gst_number: '33AABCZ5678K1Z9', phone: '+91 44 4000 3030' },
];

const dataFile = process.env.SAMPLE_CRM_DATA || undefined;
const seedFile = process.env.SAMPLE_CRM_SEED || undefined;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function load() {
  if (dataFile && existsSync(dataFile)) {
    try {
      const data = readJson(dataFile);
      if (Array.isArray(data)) return { contacts: data, keys: {} };
      if (data && Array.isArray(data.contacts)) return { contacts: data.contacts, keys: data.idempotency ?? {} };
      log(`ignoring ${dataFile}: expected { contacts: [...] }`);
    } catch (e) {
      log(`could not read ${dataFile}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (seedFile) {
    try {
      const seed = readJson(seedFile);
      if (Array.isArray(seed)) return { contacts: seed, keys: {} };
      log(`ignoring ${seedFile}: expected a JSON array of contacts`);
    } catch (e) {
      log(`could not read ${seedFile}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { contacts: DEFAULT_CONTACTS.map((c) => ({ ...c })), keys: {} };
}

const state = load();

function persist() {
  if (!dataFile) return;
  try {
    mkdirSync(dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ contacts: state.contacts, idempotency: state.keys }, null, 2));
    renameSync(tmp, dataFile);
  } catch (e) {
    log(`could not write ${dataFile}: ${e instanceof Error ? e.message : e}`);
  }
}

function nextId() {
  let max = 100;
  for (const c of state.contacts) {
    const m = /^c-(\d+)$/.exec(String(c.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c-${max + 1}`;
}

// ---------------------------------------------------------------- tools

const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    company_name: { type: 'string' },
    email: { type: 'string', format: 'email' },
    gst_number: { type: 'string' },
    phone: { type: 'string' },
  },
  required: ['id', 'company_name'],
};

const TOOLS = [
  {
    name: 'list_contacts',
    title: 'List contacts',
    description: 'List the company contacts in the CRM: id, company name, email, GST number and phone.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { contacts: { type: 'array', items: CONTACT_SCHEMA } }, required: ['contacts'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_contact',
    title: 'Get a contact',
    description: 'Read one contact by its CRM id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The contact id, such as c-101.' } }, required: ['id'] },
    outputSchema: { type: 'object', properties: { contact: CONTACT_SCHEMA }, required: ['contact'] },
    annotations: { readOnlyHint: true },
  },
  {
    // No annotations at all: it comes into MemWise unclassified, for the binding to classify.
    name: 'create_contact',
    title: 'Create a contact',
    description: 'Create a company contact in the CRM. Passing the same idempotency_key again returns the contact created the first time instead of a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        email: { type: 'string' },
        gst_number: { type: 'string' },
        phone: { type: 'string' },
        idempotency_key: { type: 'string', description: 'Makes retries safe: the same key never creates a second contact.' },
      },
      required: ['company_name'],
    },
    outputSchema: { type: 'object', properties: { contact: CONTACT_SCHEMA, created: { type: 'boolean' } }, required: ['contact', 'created'] },
  },
];

class ToolError extends Error {}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

const HANDLERS = {
  list_contacts() {
    return { contacts: state.contacts.map((c) => ({ ...c })) };
  },
  get_contact(args) {
    const id = str(args.id);
    if (!id) throw new ToolError('get_contact needs an id.');
    const contact = state.contacts.find((c) => c.id === id);
    if (!contact) throw new ToolError(`There is no contact ${id}.`);
    return { contact: { ...contact } };
  },
  create_contact(args) {
    const companyName = str(args.company_name);
    if (!companyName) throw new ToolError('create_contact needs a company_name.');
    const key = str(args.idempotency_key);
    if (key && state.keys[key]) {
      const existing = state.contacts.find((c) => c.id === state.keys[key]);
      if (existing) return { contact: { ...existing }, created: false };
    }
    const contact = { id: nextId(), company_name: companyName };
    for (const f of ['email', 'gst_number', 'phone']) {
      const v = str(args[f]);
      if (v) contact[f] = v;
    }
    state.contacts.push(contact);
    if (key) state.keys[key] = contact.id;
    persist();
    log(`created ${contact.id} (${companyName})`);
    return { contact: { ...contact }, created: true };
  },
};

function callTool(params) {
  const name = params?.name;
  const handler = typeof name === 'string' && Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  try {
    const structured = handler(args);
    return { result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: false } };
  } catch (e) {
    if (!(e instanceof ToolError)) log(`${name} failed: ${e instanceof Error ? e.stack : e}`);
    return { result: { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true } };
  }
}

// ---------------------------------------------------------------- JSON-RPC over stdio

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // A response to us (we never send requests), or garbage: answer garbage that carries an id.
    if (message && typeof message === 'object' && 'id' in message && !('result' in message) && !('error' in message)) {
      send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Invalid request' } });
    }
    return;
  }
  const isRequest = 'id' in message && message.id !== null && message.id !== undefined;
  const { id, method, params } = message;
  if (!isRequest) {
    // Notifications: initialized, cancelled, progress... nothing to do for any of them.
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => send({ jsonrpc: '2.0', id, error: { code, message: msg } });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A sample CRM of company contacts. list_contacts and get_contact only read; create_contact adds a contact.',
      });
      return;
    }
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const out = callTool(params);
      if (out.error) fail(out.error.code, out.error.message);
      else reply(out.result);
      return;
    }
    default:
      fail(-32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    handle(message);
  } catch (e) {
    log(`unexpected: ${e instanceof Error ? e.stack : e}`);
    if (message && typeof message === 'object' && 'id' in message) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } });
    }
  }
});
// When stdin closes, nothing else keeps the process alive: it exits once stdout is flushed.
process.stdout.on('error', () => process.exit(0));
log(`ready with ${state.contacts.length} contact(s)${dataFile ? `, persisting to ${dataFile}` : ''}`);
