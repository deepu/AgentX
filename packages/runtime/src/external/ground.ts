// Grounding extracted values in the document's text (23 §5, D68): a value the reader can't point
// to in the text has its confidence capped, so a model that invents a value can't get it pre-filled.
import type { ValueType } from '@memwise/defs';

/** Confidence of a value not found in the text, at most. */
export const UNGROUNDED_CAP = 0.5;
/** Confidence of a reader result that gave none (older stubs, plain values). */
export const DEFAULT_CONFIDENCE = 0.5;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** Identifiers: case, spaces and punctuation ignored. */
const alnum = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** Digits with the separators people print between them (1,23,456.00 · 42 000 000) removed. */
const digitsOnly = (s: string) => s.replace(/(?<=\d)[,\s'’](?=\d)/g, '');

function numberFound(n: number, text: string): boolean {
  if (!Number.isFinite(n)) return false;
  const plain = digitsOnly(text);
  const forms = new Set([String(n), n.toFixed(2), Number.isInteger(n) ? `${n}.00` : String(n)]);
  return [...forms].some((f) => new RegExp(`(^|[^\\d.])${f.replace('.', '\\.')}($|[^\\d])`).test(plain));
}

function dateFound(v: string, text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return squash(text).includes(squash(v));
  const [, y, mo, d] = m;
  const day = String(Number(d));
  const month = String(Number(mo));
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const name = names[Number(mo) - 1]!;
  const t = squash(text);
  const candidates = [
    `${y}-${mo}-${d}`, `${d}/${mo}/${y}`, `${d}-${mo}-${y}`, `${d}.${mo}.${y}`, `${day}/${month}/${y}`,
    `${day} ${name} ${y}`, `${day} ${name.slice(0, 3)} ${y}`, `${name} ${day}, ${y}`,
  ];
  return candidates.some((c) => t.includes(c));
}

/** Whether `value` (for a write of type `type`) appears in `text`. */
export function foundInText(value: unknown, type: ValueType | undefined, text: string): boolean {
  if (!text.trim() || value === null || value === undefined) return false;
  if (type?.kind === 'identifier') return typeof value === 'string' && alnum(value).length > 0 && alnum(text).includes(alnum(value));
  if (typeof value === 'number') return numberFound(value, text);
  if (value && typeof value === 'object' && typeof (value as { amount?: unknown }).amount === 'number') {
    return numberFound((value as { amount: number }).amount, text);
  }
  if (typeof value !== 'string' || !value.trim()) return false;
  if (type?.kind === 'scalar' && type.name === 'Date') return dateFound(value, text);
  // Names and other text: the same words in the same order, ignoring case and spacing; or, for
  // text printed with other punctuation (A.C.M.E. Traders), the same letters and digits.
  return squash(text).includes(squash(value)) || (alnum(value).length >= 4 && alnum(text).includes(alnum(value)));
}

/** The confidence after grounding, and whether the value was found. */
export function ground(value: unknown, confidence: number | undefined, type: ValueType | undefined, text: string): { confidence: number; found: boolean } {
  const c = Math.min(1, Math.max(0, confidence ?? DEFAULT_CONFIDENCE));
  const found = foundInText(value, type, text);
  return { found, confidence: found ? c : Math.min(c, UNGROUNDED_CAP) };
}
