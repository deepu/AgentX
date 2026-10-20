// External links (23 §3, D67): tokens, the mw.external_links rows, and why a link can't be used.
//
// A token is `mwl_` and 32 bytes, base64url. Only its sha256 is stored. The bytes are an HMAC of
// the link's key (random for a copied link, the call's idempotency key for `external.invite`)
// under a kernel key that never leaves the core, so a retried invite and "Send again" deliver
// the very same link instead of a second one.
import crypto from 'node:crypto';
import type { ExternalLinkStatus, ExternalLinkSummary, ExternalParticipant, LinkRefusal } from '@memwise/defs';
import { ulid, type Queryable } from '@memwise/db';
import { compact } from './text.ts';

export const TOKEN_PREFIX = 'mwl_';
const TOKEN_RE = /^mwl_[A-Za-z0-9_-]{43}$/;

const DAY_MS = 24 * 3600_000;
/** Without `expires_in` or a timeout on the step's state (23 §3). */
export const DEFAULT_EXPIRY_MS = 7 * DAY_MS;
export const MAX_EXPIRY_MS = 30 * DAY_MS;
/** Inbox links (23 §6). */
export const INBOX_LINK_MS = 3 * DAY_MS;

export const newLinkId = () => `lnk_${ulid()}`;
export const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const isToken = (token: string) => TOKEN_RE.test(token);

/** A named kernel key (mw.kernel_keys), made on first use; the same for every kernel on the database. */
export async function kernelKey(db: Queryable, name: string): Promise<Buffer> {
  await db.query(`insert into mw.kernel_keys (name, key) values ($1, $2) on conflict (name) do nothing`, [name, crypto.randomBytes(32)]);
  const { rows } = await db.query(`select key from mw.kernel_keys where name = $1`, [name]);
  return rows[0].key as Buffer;
}

/** The token of the link whose key is `idemKey`. */
export function tokenFor(key: Buffer, idemKey: string): string {
  return TOKEN_PREFIX + crypto.createHmac('sha256', key).update(`memwise-link:${idemKey}`).digest('base64url');
}

/** A fresh key for a link nothing retries (copied by staff, an inbox link). */
export const randomLinkKey = (prefix: string) => `${prefix}:${crypto.randomBytes(16).toString('base64url')}`;

export interface LinkRow {
  id: string;
  kind: 'step' | 'inbox';
  run_id: string;
  case_id: string;
  step_id: string | null;
  step_run_id: string | null;
  person_id: string | null;
  item_id: string | null;
  participant: ExternalParticipant;
  via: string | null;
  note: string | null;
  draft: Record<string, unknown> | null;
  draft_saved_at: Date | null;
  suggestions: StoredSuggestion[];
  files: string[];
  created_by: string | null;
  created_at: Date;
  expires_at: Date;
  sent_at: Date | null;
  first_opened_at: Date | null;
  last_opened_at: Date | null;
  used_at: Date | null;
  closed_at: Date | null;
  closed_reason: string | null;
  idem_key: string | null;
}

/** A suggestion as stored: what the form sees, plus the call it came from (for provenance on submit). */
export interface StoredSuggestion {
  id: string; field: string; value: unknown; confidence: number; document: string; documentId: string;
  quote?: string; found: boolean; prefill: boolean;
  tool: string; callId: string; stepRunId: string;
}

export function linkStatus(r: Pick<LinkRow, 'closed_reason' | 'used_at' | 'closed_at' | 'expires_at'>, now = Date.now()): ExternalLinkStatus {
  if (r.closed_reason === 'revoked') return 'revoked';
  if (r.used_at) return 'used';
  if (r.closed_at) return 'closed';
  if (new Date(r.expires_at).getTime() <= now) return 'expired';
  return 'open';
}

const iso = (v: Date | string | null | undefined) => (v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : undefined);

export function linkSummary(r: LinkRow): ExternalLinkSummary {
  return compact({
    id: r.id, kind: r.kind, status: linkStatus(r), runId: r.run_id, caseId: r.case_id,
    stepId: r.step_id ?? undefined, stepRunId: r.step_run_id ?? undefined, participant: r.participant ?? {},
    via: (r.via ?? undefined) as ExternalLinkSummary['via'], note: r.note ?? undefined,
    createdAt: iso(r.created_at)!, createdBy: r.created_by ?? undefined, expiresAt: iso(r.expires_at)!,
    sentAt: iso(r.sent_at), firstOpenedAt: iso(r.first_opened_at), lastOpenedAt: iso(r.last_opened_at),
    draftSavedAt: iso(r.draft_saved_at), usedAt: iso(r.used_at), closedAt: iso(r.closed_at),
    closedReason: r.closed_reason ?? undefined, personId: r.person_id ?? undefined, itemId: r.item_id ?? undefined,
  }) as ExternalLinkSummary;
}

export async function linkByToken(db: Queryable, token: string): Promise<LinkRow | undefined> {
  if (typeof token !== 'string' || !isToken(token)) return undefined;
  const { rows } = await db.query(`select * from mw.external_links where token_hash = $1`, [tokenHash(token)]);
  return rows[0];
}

export async function linkById(db: Queryable, id: string, lock = false): Promise<LinkRow | undefined> {
  const { rows } = await db.query(`select * from mw.external_links where id = $1${lock ? ' for update' : ''}`, [id]);
  return rows[0];
}

export interface NewLink {
  kind: 'step' | 'inbox';
  idemKey: string;
  runId: string;
  caseId: string;
  stepId?: string;
  stepRunId?: string;
  personId?: string;
  itemId?: string;
  participant: ExternalParticipant;
  via?: string;
  note?: string;
  createdBy?: string;
  expiresInMs: number;
}

/** Issues a link, once per `idemKey`: a repeat returns the same link and token. */
export async function insertLink(db: Queryable, key: Buffer, l: NewLink): Promise<{ row: LinkRow; token: string }> {
  const token = tokenFor(key, l.idemKey);
  await db.query(
    `insert into mw.external_links (id, kind, token_hash, run_id, case_id, step_id, step_run_id, person_id, item_id,
                                    participant, via, note, created_by, expires_at, idem_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(secs => $14::float8 / 1000), $15)
     on conflict (idem_key) do nothing`,
    [newLinkId(), l.kind, tokenHash(token), l.runId, l.caseId, l.stepId ?? null, l.stepRunId ?? null, l.personId ?? null, l.itemId ?? null,
      JSON.stringify(compact(l.participant)), l.via ?? null, l.note?.trim() || null, l.createdBy ?? null, l.expiresInMs, l.idemKey]);
  const { rows } = await db.query(`select * from mw.external_links where idem_key = $1`, [l.idemKey]);
  return { row: rows[0], token };
}

/** The token of an existing link, from its key. */
export const tokenOf = (key: Buffer, row: Pick<LinkRow, 'idem_key'>): string | undefined => (row.idem_key ? tokenFor(key, row.idem_key) : undefined);

/** `expires_in`, else the state's timeout, else 7 days; at most 30 days. */
export function expiryMs(requested: number | undefined, stateTimeoutMs: number | undefined): number {
  const ms = requested ?? stateTimeoutMs ?? DEFAULT_EXPIRY_MS;
  return Math.max(60_000, Math.min(MAX_EXPIRY_MS, ms));
}

/** Why a link can't be used, in words the participant reads (23 §3). */
export function refusal(status: LinkRefusal['status'], business: string): LinkRefusal {
  const who = business || 'the business';
  const message: Record<LinkRefusal['status'], string> = {
    unknown: `This link doesn't work. Check that you opened the whole link, or ask ${who} to send you a new one.`,
    expired: `This link has expired. Ask ${who} to send you a new one.`,
    used: `This link was already used: the form was sent. If something needs changing, ${who} will send you a new link.`,
    closed: `This form is closed: ${who} doesn't need it from this link any more.`,
    revoked: `This link was cancelled by ${who}. Ask them for a new one if you still need it.`,
    not_yet: "This form isn't ready yet. Please try again in a few minutes.",
    rate_limited: 'Too many tries in a short time. Please wait a little and try again.',
  };
  return { status, message: message[status] };
}
