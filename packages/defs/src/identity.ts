/**
 * Identity resolution (Phase 4, 22 §6, D65): is this connector record one of the domain's? Keys
 * first (same GSTIN, same email), then name similarity. Pure and deterministic; no model.
 */
import type { IdentityMatch, IdentityRules } from './plugin-types.ts';

/** A key as compared: text trimmed, lower case, spaces removed; numbers as text; anything else empty. */
export function normaliseKey(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/\s+/g, '');
}

/** Words a company name may carry or drop without being another company. */
const LEGAL_SUFFIXES = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation']);

/** Lower-case words, punctuation dropped, legal suffixes removed (unless nothing else is left), sorted. */
function nameTokens(v: string): string {
  const words = v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !LEGAL_SUFFIXES.has(w));
  return (kept.length ? kept : words).sort().join(' ');
}

/** Jaro–Winkler similarity of two strings, 0..1 (prefix scale 0.1, up to 4 characters). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * How alike two names are, 0..1: Jaro–Winkler over the sorted, normalised words with legal
 * suffixes removed, so "Acme Ltd" and "ACME Limited" are 1.0 and word order doesn't matter.
 */
export function nameSimilarity(a: unknown, b: unknown): number {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x || !y) return 0;
  return x === y ? 1 : jaroWinkler(x, y);
}

const ACRONYMS: Record<string, string> = { gstin: 'GSTIN', pan: 'PAN', cin: 'CIN', tan: 'TAN', vat: 'VAT', ein: 'EIN', ssn: 'SSN', iban: 'IBAN' };
/** A field name as people read it: `gstin` → `GSTIN`, `tax_id` → `tax id`. */
const label = (field: string) => ACRONYMS[field.toLowerCase()] ?? field.replace(/_/g, ' ');
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Matches one mapped record against the entity's rows (22 §6):
 * 1. Keys, in order: an equal non-empty normalised value is a `key` match, score 1. The first key
 *    that matches names the record; another key (or the same one) matching a different record is
 *    a conflict, sent to a person (`review`).
 * 2. Otherwise, name similarity on `fuzzy.field`: at or above `auto` links, at or above `review`
 *    asks a person, else `none`. A key present on both sides with different values caps the score
 *    below `auto`, so such a pair is never linked automatically.
 * Candidates are compared in the order given; ties keep the first.
 */
export function matchRecord(
  mapped: Record<string, unknown>,
  candidates: { id: string; values: Record<string, unknown> }[],
  rules: IdentityRules,
): IdentityMatch {
  // ---- keys
  let first: { id: string; key: string } | undefined;
  const reasons: string[] = [];
  const others = new Set<string>();
  for (const key of rules.keys) {
    const v = normaliseKey(mapped[key]);
    if (!v) continue;
    const hits = candidates.filter((c) => normaliseKey(c.values[key]) === v);
    if (!hits.length) continue;
    if (!first) {
      first = { id: hits[0]!.id, key };
      reasons.push(`same ${label(key)}`);
    }
    for (const h of hits) if (h.id !== first.id) others.add(h.id);
    if (first.key !== key && hits.some((h) => h.id === first!.id)) reasons.push(`same ${label(key)}`);
  }
  if (first) {
    if (others.size) {
      return {
        recordId: first.id, score: 1, method: 'key', verdict: 'review',
        reasons: [...reasons, `but ${[...others].join(', ')} ${others.size === 1 ? 'matches' : 'match'} too`],
      };
    }
    return { recordId: first.id, score: 1, method: 'key', verdict: 'link', reasons };
  }

  // ---- fuzzy
  const fuzzy = rules.fuzzy;
  if (!fuzzy) return { score: 0, verdict: 'none', reasons: [`no record with the same ${rules.keys.map(label).join(' or ') || 'key'}`] };
  let best: { id: string; score: number; reasons: string[] } | undefined;
  for (const c of candidates) {
    const similarity = nameSimilarity(mapped[fuzzy.field], c.values[fuzzy.field]);
    if (!similarity) continue;
    const why = [similarity === 1 ? `same ${label(fuzzy.field)}` : `${label(fuzzy.field)} ${round(similarity).toFixed(2)} similar`];
    let score = similarity;
    for (const key of rules.keys) {
      const a = normaliseKey(mapped[key]);
      const b = normaliseKey(c.values[key]);
      if (a && b && a !== b) {
        why.push(`different ${label(key)}`);
        score = Math.min(score, Math.max(0, fuzzy.auto - 0.01));
      }
    }
    if (!best || score > best.score) best = { id: c.id, score, reasons: why };
  }
  if (!best) return { score: 0, verdict: 'none', reasons: [`no record with a similar ${label(fuzzy.field)}`] };
  const verdict = best.score >= fuzzy.auto ? 'link' : best.score >= fuzzy.review ? 'review' : 'none';
  return {
    ...(verdict === 'none' ? {} : { recordId: best.id }),
    score: Math.round(best.score * 1e4) / 1e4,
    ...(verdict === 'none' ? {} : { method: 'fuzzy' as const }),
    verdict,
    reasons: verdict === 'none' ? [`closest: ${best.reasons.join(', ')}`] : best.reasons,
  };
}
