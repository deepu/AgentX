// kernel.channels (23 §6-7, D69): which channel tools are bound, the deliveries sent through
// them, people's notification settings and the notifier that uses them, and webhooks.
import crypto from 'node:crypto';
import type { ChannelName, InboundEvent, NotifySettings, WebhookSummary } from '@memwise/defs';
import { ulid, withTransaction, type PgPeopleStore } from '@memwise/db';
import type { ToolGateway } from '@memwise/gateway';
import type pg from 'pg';
import type { Actor, ChannelService, InboxItem, KernelChange, PersonActor } from '../types.ts';
import { CHANNEL_TOOLS, deliver, deliveryOf } from './deliver.ts';
import { kernelKey } from './links.ts';
import { notificationMessage } from './messages.ts';
import type { ExternalKernelService } from './service.ts';
import { compact } from './text.ts';

/** Kinds of inbox item a person is told about by email or WhatsApp (23 §6). */
const NOTIFIED_KINDS = new Set<InboxItem['kind']>(['input', 'decision', 'approval', 'attention']);
/** How long the notifier waits for changes to settle before it looks. */
const NOTIFY_DEBOUNCE_MS = 300;
/** Inbound bodies kept, at most. */
const MAX_BODY_BYTES = 1024 * 1024;
const E164 = /^\+[1-9]\d{6,14}$/;
/** WhatsApp statuses, in the order they happen: a late "sent" never replaces "read". */
const STATUS_ORDER = ['pending', 'sent', 'delivered', 'read'];

export interface ChannelDeps {
  pool: pg.Pool;
  tools: () => ToolGateway;
  people: PgPeopleStore;
  external: ExternalKernelService;
  inbox: (actor: Actor) => Promise<InboxItem[]>;
  subscribe: (listener: (c: KernelChange) => void) => () => void;
}

export interface ChannelKernelService extends ChannelService {
  /** Sends what is waiting for people who turned notifications on; returns how many were sent. */
  notifyNow(): Promise<number>;
  /** Starts following the change feed; returns the stop function. */
  startNotifier(): () => void;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** Headers worth keeping with an inbound event: no cookies or credentials. */
function keptHeaders(h: Record<string, string>): Record<string, string> {
  const drop = /^(authorization|cookie|proxy-authorization|x-api-key)$/;
  return Object.fromEntries(Object.entries(lower(h)).filter(([k]) => !drop.test(k)).map(([k, v]) => [k, String(v).slice(0, 2000)]));
}

/** `sha256=<hex>` against the HMAC of `body`, compared in constant time. */
function signatureOk(header: string | undefined, secret: string, body: Uint8Array): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  if (!m) return false;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(m[1]!, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function seal(key: Buffer, secret: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

function unseal(key: Buffer, sealed: string): string | undefined {
  const [v, iv, tag, enc] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !enc) return undefined;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

function parseBody(body: Uint8Array): unknown {
  const text = Buffer.from(body.subarray(0, MAX_BODY_BYTES)).toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

/** WhatsApp Cloud API delivery statuses in a webhook body: `entry[].changes[].value.statuses[]`. */
function whatsappStatuses(body: unknown): { id: string; status: string; error?: string }[] {
  const out: { id: string; status: string; error?: string }[] = [];
  const entries = (body as { entry?: unknown })?.entry;
  for (const e of Array.isArray(entries) ? entries : []) {
    for (const ch of Array.isArray(e?.changes) ? e.changes : []) {
      for (const s of Array.isArray(ch?.value?.statuses) ? ch.value.statuses : []) {
        if (typeof s?.id !== 'string' || typeof s?.status !== 'string') continue;
        const err = Array.isArray(s.errors) ? s.errors.map((x: { title?: string; message?: string }) => x?.message ?? x?.title).filter(Boolean).join('; ') : '';
        out.push({ id: s.id, status: s.status, ...(err ? { error: err } : {}) });
      }
    }
  }
  return out;
}

function webhookOf(r: any, base: string | undefined): WebhookSummary {
  return compact({
    id: r.id, purpose: r.purpose, plugin: r.plugin ?? undefined, scheme: r.scheme, url: base ? `${base}/h/${r.id}` : undefined,
    createdAt: iso(r.created_at), lastReceivedAt: r.last_received_at ? iso(r.last_received_at) : undefined,
  }) as WebhookSummary;
}

function inboundOf(r: any): InboundEvent {
  return { id: r.id, hookId: r.hook_id, receivedAt: iso(r.received_at), verified: r.verified, headers: r.headers ?? {}, body: r.body };
}

export function createChannelService(deps: ChannelDeps): ChannelKernelService {
  const { pool } = deps;
  const listeners = new Set<(e: InboundEvent) => void>();
  const hooksKey = () => kernelKey(pool, 'webhooks');

  async function settingsOf(personId: string): Promise<NotifySettings & { since?: string }> {
    const { rows } = await pool.query(`select notify from mw.people where id = $1`, [personId]);
    return rows[0]?.notify ?? {};
  }

  // ---------------------------------------------------------------- the notifier (23 §6)

  let sweeping: Promise<number> | undefined;
  let again = false;

  /** One pass: every opted-in person, each new item of theirs, each channel they chose, once. */
  async function sweep(): Promise<number> {
    if (!deps.external.publicBase()) return 0; // an inbox link needs a public address
    const { rows } = await pool.query(
      `select id, name, email, notify from mw.people where not disabled and notify <> '{}'::jsonb order by id`);
    let sent = 0;
    for (const p of rows) {
      const n = p.notify as NotifySettings & { since?: string };
      const via: { channel: ChannelName; to: string }[] = [];
      if (n.email && p.email && deps.tools().get(CHANNEL_TOOLS.email)) via.push({ channel: 'email', to: p.email });
      if (n.whatsapp && deps.tools().get(CHANNEL_TOOLS.whatsapp)) via.push({ channel: 'whatsapp', to: n.whatsapp });
      if (!via.length) continue;
      const actor: PersonActor = await deps.people.actorFor(p.id);
      const since = n.since ? Date.parse(n.since) : 0;
      const items = (await deps.inbox(actor)).filter((i) => NOTIFIED_KINDS.has(i.kind) && Date.parse(i.since) >= since);
      for (const item of items) {
        for (const { channel, to } of via) {
          const idemKey = `notify:${p.id}:${item.id}:${channel}`;
          const done = await pool.query(`select status from mw.deliveries where idem_key = $1`, [idemKey]);
          if (done.rows[0] && done.rows[0].status !== 'pending') continue;
          try {
            const link = await deps.external.issueInboxLink({ personId: p.id, item, via: channel, idemKey: `inbox:${idemKey}` });
            if (!link) continue;
            const message = notificationMessage(channel, to, { name: p.name, title: link.title, url: link.url, expiresAt: link.link.expiresAt });
            const token = {
              runId: 'runId' in item ? item.runId : '', caseId: 'caseId' in item ? item.caseId : '', stepId: 'stepId' in item ? item.stepId : '',
              stepRunId: `notify:${p.id}`, workflowId: 'workflowId' in item ? item.workflowId : '', workflowVersion: 0,
              agentRole: 'memwise.notify', onBehalfOf: p.id, issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            };
            await deliver(pool, deps.tools(), {
              message, idemKey, purpose: 'notification', token, linkId: link.link.id,
              ...('caseId' in item ? { caseId: item.caseId } : {}), personId: p.id, itemId: item.id,
            });
            sent++;
          } catch {
            // Best effort: the row says it failed, and the item is still in their inbox.
          }
        }
      }
    }
    return sent;
  }

  async function notifyNow(): Promise<number> {
    if (sweeping) { again = true; return sweeping; }
    sweeping = (async () => {
      let total = 0;
      do { again = false; total += await sweep().catch(() => 0); } while (again);
      return total;
    })().finally(() => { sweeping = undefined; });
    return sweeping;
  }

  // ---------------------------------------------------------------- the service

  return {
    notifyNow,

    startNotifier() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const unsubscribe = deps.subscribe((c) => {
        if (stopped || (c.kind !== 'inbox' && c.kind !== 'run')) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; if (!stopped) void notifyNow(); }, NOTIFY_DEBOUNCE_MS);
      });
      return () => { stopped = true; if (timer) clearTimeout(timer); unsubscribe(); };
    },

    async available() {
      const out: Record<ChannelName, { tool: string; plugin?: string } | undefined> = { email: undefined, whatsapp: undefined };
      for (const [channel, tool] of Object.entries(CHANNEL_TOOLS) as [ChannelName, string][]) {
        const def = deps.tools().get(tool);
        if (def) out[channel] = compact({ tool, plugin: def.source?.plugin }) as { tool: string; plugin?: string };
      }
      return out;
    },

    async deliveries(filter) {
      const { rows } = await pool.query(
        `select * from mw.deliveries
          where ($1::text is null or case_id = $1) and ($2::text is null or link_id = $2) and ($3::text is null or person_id = $3)
          order by at desc, id desc limit $4`,
        [filter.caseId ?? null, filter.linkId ?? null, filter.personId ?? null, Math.min(Math.max(filter.limit ?? 100, 1), 500)]);
      return rows.map(deliveryOf);
    },

    async notifySettings(personId) {
      const { since: _since, ...settings } = await settingsOf(personId);
      return settings;
    },

    async setNotifySettings(personId, settings, by) {
      const person = await deps.people.get(personId);
      if (!person) throw new Error(`no person ${personId}`);
      if (by.personId !== personId) throw Object.assign(new Error('only the person themselves can change how they are told about their inbox'), { code: 'forbidden' });
      const whatsapp = settings.whatsapp?.replace(/[\s()-]/g, '') || undefined;
      if (whatsapp && !E164.test(whatsapp)) throw new Error('the WhatsApp number must be in international form, e.g. +919876543210');
      const next: NotifySettings = compact({ email: settings.email ? true : undefined, whatsapp });
      const before = await settingsOf(personId);
      const wasOn = !!(before.email || before.whatsapp);
      const on = !!(next.email || next.whatsapp);
      // Turned on now: only items from now on, never the backlog.
      const since = on ? (wasOn && before.since ? before.since : new Date().toISOString()) : undefined;
      await pool.query(`update mw.people set notify = $2, phone = coalesce($3, phone) where id = $1`,
        [personId, JSON.stringify(on ? { ...next, since } : {}), whatsapp ?? null]);
      return next;
    },

    async createWebhook(input, by) {
      const scheme = input.scheme;
      if (scheme !== 'hmac-sha256' && scheme !== 'meta') throw new Error(`unknown webhook scheme ${String(scheme)}`);
      const secret = input.secret ?? (scheme === 'meta' ? process.env.WHATSAPP_APP_SECRET : undefined) ?? crypto.randomBytes(32).toString('hex');
      if (!secret) throw new Error('a meta webhook needs the app secret from Meta (WHATSAPP_APP_SECRET)');
      const id = `hk_${crypto.randomBytes(12).toString('base64url')}`;
      const verifyToken = scheme === 'meta' ? input.verifyToken ?? crypto.randomBytes(16).toString('hex') : input.verifyToken ?? null;
      const createdBy = by.kind === 'person' ? by.personId : by.kind;
      const { rows } = await pool.query(
        `insert into mw.webhooks (id, purpose, plugin, scheme, secret_hash, secret_enc, verify_token, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [id, input.purpose, input.plugin ?? null, scheme, crypto.createHash('sha256').update(secret).digest('hex'),
          await seal(await hooksKey(), secret), verifyToken, createdBy]);
      return { hook: webhookOf(rows[0], deps.external.publicBase()), secret };
    },

    async webhooks() {
      const { rows } = await pool.query(
        `select w.*, (select max(received_at) from mw.inbound_events e where e.hook_id = w.id) as last_received_at
           from mw.webhooks w order by created_at, id`);
      return rows.map((r) => webhookOf(r, deps.external.publicBase()));
    },

    async receiveWebhook(hookId, req) {
      const { rows } = await pool.query(`select * from mw.webhooks where id = $1`, [hookId]);
      const hook = rows[0];
      if (!hook) return { status: 404, body: 'not found', contentType: 'text/plain' };
      const headers = lower(req.headers ?? {});
      const method = (req.method ?? 'POST').toUpperCase();
      if (method === 'GET') {
        // Meta's subscription handshake: echo hub.challenge when the verify token matches.
        const q = req.query ?? {};
        if (hook.scheme === 'meta' && q['hub.mode'] === 'subscribe' && hook.verify_token && typeof q['hub.challenge'] === 'string') {
          const given = Buffer.from(String(q['hub.verify_token'] ?? ''));
          const want = Buffer.from(hook.verify_token as string);
          if (given.length === want.length && crypto.timingSafeEqual(given, want)) {
            return { status: 200, body: q['hub.challenge'], contentType: 'text/plain' };
          }
        }
        return { status: 403, body: 'forbidden', contentType: 'text/plain' };
      }
      if (method !== 'POST') return { status: 405, body: 'method not allowed', contentType: 'text/plain' };
      const body = req.body ?? new Uint8Array();
      const secret = hook.secret_enc ? unseal(await hooksKey(), hook.secret_enc) : undefined;
      const header = hook.scheme === 'meta' ? headers['x-hub-signature-256'] : headers['x-memwise-signature'];
      const verified = !!secret && signatureOk(header, secret, body);
      const event = inboundOf((await pool.query(
        `insert into mw.inbound_events (id, hook_id, verified, headers, body) values ($1, $2, $3, $4, $5) returning *`,
        [`inb_${ulid()}`, hookId, verified, JSON.stringify(keptHeaders(headers)), JSON.stringify(parseBody(body))])).rows[0]);
      if (!verified) return { status: 401, body: 'bad signature', contentType: 'text/plain' };
      if (hook.scheme === 'meta') {
        for (const s of whatsappStatuses(event.body)) {
          const status = s.status === 'failed' ? 'failed' : STATUS_ORDER.includes(s.status) ? s.status : undefined;
          if (!status) continue;
          await withTransaction(pool, async (db) => {
            const cur = await db.query(`select id, status from mw.deliveries where provider_id = $1 for update`, [s.id]);
            for (const d of cur.rows) {
              if (status !== 'failed' && STATUS_ORDER.indexOf(d.status) >= STATUS_ORDER.indexOf(status)) continue;
              await db.query(`update mw.deliveries set status = $2, error = coalesce($3, error), updated_at = now() where id = $1`,
                [d.id, status, s.error ?? null]);
            }
          });
        }
      }
      for (const l of listeners) {
        try { l(event); } catch { /* a listener's failure is its own */ }
      }
      return { status: 200, body: 'ok', contentType: 'text/plain' };
    },

    async inbound(filter) {
      const { rows } = await pool.query(
        `select * from mw.inbound_events where ($1::text is null or hook_id = $1) order by received_at desc, id desc limit $2`,
        [filter.hookId ?? null, Math.min(Math.max(filter.limit ?? 100, 1), 500)]);
      return rows.map(inboundOf);
    },

    onInbound(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
