// Incoming messages (24 §10): stored once per domain and Message-ID, attachments saved as files,
// and the `message` value `message:` triggers map into a case. Email arrives through a Phase 5
// webhook whose purpose is `email-inbound:<domain>`.
import { ulid } from '@memwise/db';
import type { InboundEvent, InboundMessageBody } from '@memwise/defs';
import type { DocumentValue } from '../types.ts';
import type { FlowDeps } from './context.ts';

/** The purpose of a domain's inbound email hook. */
export const EMAIL_PURPOSE = 'email-inbound:';
export const emailPurpose = (domain: string) => `${EMAIL_PURPOSE}${domain}`;

/** What `message.<x>` names in a trigger's `with:`. */
export interface MessageValue {
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
  attachments: DocumentValue[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const addresses = (to: string | string[]) => (Array.isArray(to) ? to.join(', ') : to);

/** Plain text of an HTML body, for `message.text` when the sender sent no text part. */
export function htmlText(html: string): string {
  return html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').trim();
}

export function messageValue(row: any): MessageValue {
  return {
    id: row.id, from: row.from_addr, to: row.to_addr, subject: row.subject ?? '', text: row.body?.text ?? '',
    receivedAt: iso(row.received_at), attachments: row.files ?? [],
  };
}

/** Problems with an inbound body, in plain words (empty when it is usable). */
export function messageProblems(body: unknown): string[] {
  const b = body as Partial<InboundMessageBody> | null;
  if (!b || typeof b !== 'object') return ['the message is not a JSON object'];
  const out: string[] = [];
  if (typeof b.messageId !== 'string' || !b.messageId) out.push('the message has no messageId');
  if (typeof b.from !== 'string' || !b.from) out.push('the message has no sender (from)');
  if (!(typeof b.to === 'string' || Array.isArray(b.to))) out.push('the message has no recipient (to)');
  for (const a of b.attachments ?? []) {
    if (!a || typeof a.filename !== 'string' || typeof a.contentBase64 !== 'string') out.push('an attachment has no filename or content');
  }
  return out;
}

/** Store the message once; a second delivery of the same Message-ID returns the first. */
export async function storeMessage(deps: FlowDeps, domain: string, body: InboundMessageBody) {
  const problems = messageProblems(body);
  if (problems.length) throw new Error(`This message can't be taken in: ${problems.join('; ')}.`);
  const find = async () => (await deps.pool.query(
    `select * from mw.inbound_messages where domain = $1 and message_id = $2`, [domain, body.messageId])).rows[0];
  const before = await find();
  if (before) return { row: before, message: messageValue(before), duplicate: true };

  const files: DocumentValue[] = [];
  for (const a of body.attachments ?? []) {
    files.push(await deps.saveFile(
      { name: a.filename, mime: a.contentType || 'application/octet-stream', data: new Uint8Array(Buffer.from(a.contentBase64, 'base64')) },
      { kind: 'system' }));
  }
  const text = body.text ?? (body.html ? htmlText(body.html) : '');
  const received = body.receivedAt && !Number.isNaN(Date.parse(body.receivedAt)) ? new Date(body.receivedAt) : new Date();
  const ins = await deps.pool.query(
    `insert into mw.inbound_messages (id, domain, message_id, from_addr, to_addr, subject, received_at, body, files)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (domain, message_id) do nothing returning *`,
    [`msg_${ulid()}`, domain, body.messageId, body.from, addresses(body.to), body.subject ?? null, received,
      JSON.stringify({ text, ...(body.html ? { html: body.html } : {}) }), JSON.stringify(files)]);
  // Another delivery stored it in between: that one is the message.
  const row = ins.rows[0] ?? (await find());
  return { row, message: messageValue(row), duplicate: !ins.rows[0] };
}

/**
 * Verified events of `email-inbound:<domain>` hooks, handed to receiveMessage once each
 * (mw.event_deliveries, consumer `email-inbound`). Called for each event as it arrives and by
 * the sweep, which picks up any a crash left behind.
 */
export function emailInbound(deps: Pick<FlowDeps, 'pool' | 'log'>, receive: (domain: string, body: InboundMessageBody) => Promise<unknown>) {
  const CONSUMER = 'email-inbound';
  async function handle(eventId: string, purpose: string, body: unknown): Promise<void> {
    const domain = purpose.slice(EMAIL_PURPOSE.length);
    let error: string | undefined;
    const problems = messageProblems(body);
    if (problems.length) error = problems.join('; ');
    else await receive(domain, body as InboundMessageBody); // throws: retried by the sweep
    await deps.pool.query(`insert into mw.event_deliveries (event_id, consumer, error) values ($1, $2, $3) on conflict do nothing`,
      [eventId, CONSUMER, error ?? null]);
  }
  return {
    /** For kernel.channels.onInbound. */
    async onInbound(event: InboundEvent) {
      if (!event.verified) return;
      const { rows } = await deps.pool.query(`select purpose from mw.webhooks where id = $1`, [event.hookId]);
      const purpose = rows[0]?.purpose as string | undefined;
      if (!purpose?.startsWith(EMAIL_PURPOSE)) return;
      await handle(event.id, purpose, event.body);
    },
    /** Events not handled yet (a crash, a failure); true when it handled one. */
    async sweep(): Promise<boolean> {
      const { rows } = await deps.pool.query(
        `select e.id, e.body, w.purpose from mw.inbound_events e join mw.webhooks w on w.id = e.hook_id
          where e.verified and w.purpose like $1
            and not exists (select 1 from mw.event_deliveries d where d.event_id = e.id and d.consumer = $2)
          order by e.received_at, e.id limit 50`, [`${EMAIL_PURPOSE}%`, CONSUMER]);
      let handled = 0;
      for (const r of rows) {
        try { await handle(r.id, r.purpose, r.body); handled++; } catch (e) { deps.log?.(`inbound email ${r.id}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return handled > 0;
    },
  };
}
