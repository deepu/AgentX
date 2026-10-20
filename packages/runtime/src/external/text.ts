// Plain words for people outside the business (23 §3-6): field labels from field names, first
// names, dates, and the business's display name.
import type { Queryable } from '@memwise/db';

/** Words kept in capitals in labels. */
const ACRONYMS = new Set(['pan', 'gstin', 'gst', 'id', 'iban', 'ifsc', 'vat', 'tin', 'ein', 'ssn', 'url', 'kyc', 'upi', 'cin']);

/** `client_name` → "Client name", `pan` → "PAN", `gstinOk` → "GSTIN ok". */
export function plainLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s.-]+/).filter(Boolean).map((w) => w.toLowerCase());
  return words.map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

export const firstName = (name: string | undefined | null) => (name ?? '').trim().split(/\s+/)[0] ?? '';

/** "27 October 2026". */
export const longDate = (at: Date | string | number) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Drops undefined values (and empty strings) so optional keys stay absent. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

/**
 * Who participants see as asking (23 §3): the kernel's `businessName` option, else
 * `MEMWISE_BUSINESS_NAME`, else the first person's name (on desktop, the owner).
 */
export async function businessName(db: Queryable, option?: string | (() => string | undefined)): Promise<string> {
  const given = typeof option === 'function' ? option() : option;
  if (given?.trim()) return given.trim();
  if (process.env.MEMWISE_BUSINESS_NAME?.trim()) return process.env.MEMWISE_BUSINESS_NAME.trim();
  const { rows } = await db.query(`select name from mw.people where not disabled order by created_at, id limit 1`);
  return rows[0]?.name ?? 'MemWise';
}

/** A participant as the case records them: their name, else how they were reached. */
export const participantLabel = (p: { name?: string; email?: string; phone?: string } | undefined) =>
  p?.name?.trim() || p?.email || p?.phone || 'the client';
