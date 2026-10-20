// The sample tool set the intake project runs against (examples/intake), for tests, example
// cases and the CLI. Real connectors come as plugins in Phase 4.
//
// `email.send` is a real `outbound` effect into a sandbox outbox table: the row is keyed by the
// idempotency key, so a retried send never sends twice, and a retry is still visible (`attempts`).
import type { EffectPreview } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import pg from 'pg';
import type { Queryable } from './runs.ts';

/** Marks the sample tools, so the kernel knows to create the sandbox tables. */
export const SAMPLE_PLUGIN = 'memwise-sample';

export const SANDBOX_SQL = `
create schema if not exists mw_sandbox;
create table if not exists mw_sandbox.outbox (
  idempotency_key  text primary key,
  "to"             text not null,
  subject          text not null,
  body             text not null,
  sent_at          timestamptz not null default now(),
  attempts         int not null default 1
);
create table if not exists mw_sandbox.customers (
  id               text primary key,
  idempotency_key  text unique not null,
  name             text not null,
  email            text,
  gstin            text,
  pan              text,
  created_at       timestamptz not null default now()
);`;

export async function ensureSandbox(db: Queryable): Promise<void> {
  await db.query(SANDBOX_SQL);
}

/** GSTIN format: state code, PAN, entity number, `Z`, check character. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const GST_REGISTRY: Record<string, string> = {
  '29AAACA1234A1Z5': 'Acme Traders Private Limited',
  '27AAACM1234M1Z2': 'Menon Exports LLP',
};

/** What the (stand-in) extractor reads from each sample document. */
const EXTRACTED: Record<string, { name: string; value: string }[]> = {
  'pan-card.pdf': [{ name: 'pan', value: 'AAACM1234M' }],
  'gst-certificate.pdf': [{ name: 'gstin', value: '27AAACM1234M1Z2' }],
};

export interface SampleToolsOptions {
  /** Database holding `mw_sandbox` (the kernel's database). Needed by `email.send` and `crm.create_customer`. */
  databaseUrl?: string;
  pool?: Queryable;
  /** Overrides the built-in GST registry. */
  gstRegistry?: Record<string, string>;
  /** Overrides what the extractor returns per document name. */
  extracted?: Record<string, { name: string; value: string }[]>;
  /**
   * Include the stand-in `intake.extract_fields` (default true). With false, the kernel binds the
   * real one, which reads uploaded documents through the quarantined extractor role.
   */
  stubExtractor?: boolean;
}

export function sampleTools(opts: SampleToolsOptions = {}): ToolDefinition[] {
  let pool = opts.pool;
  const db = (): Queryable => {
    if (pool) return pool;
    if (!opts.databaseUrl) throw new Error('the sample sandbox needs a database (sampleTools({ databaseUrl }))');
    // Lazy, and lets the process exit when idle: nobody has to remember to close it.
    const p = new pg.Pool({ connectionString: opts.databaseUrl, max: 2, idleTimeoutMillis: 1000, allowExitOnIdle: true });
    p.on('error', () => {});
    return (pool = p);
  };
  const registry = opts.gstRegistry ?? GST_REGISTRY;
  const extracted = opts.extracted ?? EXTRACTED;
  const source = { plugin: SAMPLE_PLUGIN };

  const validateGstin: ToolDefinition<{ gstin: string }> = {
    name: 'gst.validate_gstin',
    description: 'Look up a GSTIN in the GST registry: whether it is valid and the legal name it is registered to.',
    inputSchema: { type: 'object', properties: { gstin: { type: 'string' } }, required: ['gstin'], additionalProperties: false },
    effect: 'read',
    source,
    async execute({ gstin }) {
      const valid = GSTIN_RE.test(gstin);
      return { gstin, valid, legal_name: valid ? (registry[gstin] ?? null) : null };
    },
  };

  const extractFields: ToolDefinition<{ documents: string[] }> = {
    name: 'intake.extract_fields',
    description: "Extract the fields printed on the client's uploaded documents (PAN card, GST certificate).",
    inputSchema: {
      type: 'object', properties: { documents: { type: 'array', items: { type: 'string' } } },
      required: ['documents'], additionalProperties: false,
    },
    effect: 'read',
    // Document text is untrusted: reading it taints the session (07 §6).
    quarantine: true,
    source,
    async execute({ documents }) {
      return { fields: documents.flatMap((d) => (extracted[d] ?? []).map((f) => ({ ...f, document: d }))) };
    },
  };

  type Email = { to: string; subject: string; body: string };
  const emailSend: ToolDefinition<Email> = {
    name: 'email.send',
    description: 'Send an email (sandbox outbox).',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body'], additionalProperties: false,
    },
    effect: 'outbound',
    idempotent: true,
    source,
    preview: ({ to, subject, body }): EffectPreview => ({ summary: `Email to ${to}: ${subject}`, detail: { to, subject, body } }),
    async execute({ to, subject, body }, ctx) {
      const { rows } = await db().query(
        `insert into mw_sandbox.outbox (idempotency_key, "to", subject, body) values ($1, $2, $3, $4)
         on conflict (idempotency_key) do update set attempts = mw_sandbox.outbox.attempts + 1
         returning attempts`,
        [ctx.idempotencyKey, to, subject, body]);
      return { message_id: `sandbox:${ctx.idempotencyKey}`, attempts: rows[0].attempts };
    },
  };

  type Customer = { name: string; email?: string; gstin?: string; pan?: string };
  const createCustomer: ToolDefinition<Customer> = {
    name: 'crm.create_customer',
    description: 'Create a customer in the CRM (sandbox).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' }, gstin: { type: 'string' }, pan: { type: 'string' } },
      required: ['name'], additionalProperties: false,
    },
    effect: 'write',
    idempotent: true,
    source,
    async execute(c, ctx) {
      const { rows } = await db().query(
        `insert into mw_sandbox.customers (id, idempotency_key, name, email, gstin, pan)
         values ('cust_' || md5($1), $1, $2, $3, $4, $5)
         on conflict (idempotency_key) do update set name = excluded.name returning id`,
        [ctx.idempotencyKey, c.name, c.email ?? null, c.gstin ?? null, c.pan ?? null]);
      return { id: rows[0].id };
    },
  };

  return opts.stubExtractor === false ? [validateGstin, emailSend, createCustomer] : [validateGstin, extractFields, emailSend, createCustomer];
}
