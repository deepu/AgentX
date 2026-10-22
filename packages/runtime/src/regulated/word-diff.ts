// Readable diffs for a change request (26 §8: "what changes, with strikeouts"): words of a step's
// title, and whole items of a list (its checkpoint rules), each kept, added or removed.
import type { DiffSegment } from './types.ts';

/** The longest common subsequence of two token lists, as a list of kept/added/removed tokens. */
function lcsDiff(a: string[], b: string[]): { kind: DiffSegment['kind']; text: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const out: { kind: DiffSegment['kind']; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'removed', text: a[i++]! });
    else out.push({ kind: 'added', text: b[j++]! });
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! });
  while (j < m) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

/**
 * Words of `before` → `after`, runs of the same kind merged. A change that keeps fewer than a
 * third of the words reads better as the old text struck out and the new one after it.
 */
export function wordDiff(before: string | undefined, after: string | undefined): DiffSegment[] {
  if (before === undefined) return after ? [{ kind: 'added', text: after }] : [];
  if (after === undefined) return before ? [{ kind: 'removed', text: before }] : [];
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t !== '');
  const raw = lcsDiff(tokens(before), tokens(after));
  const kept = raw.filter((t) => t.kind === 'same' && t.text.trim()).length;
  const words = Math.max(tokens(before).filter((t) => t.trim()).length, tokens(after).filter((t) => t.trim()).length);
  if (kept * 3 < words) return [{ kind: 'removed', text: before }, { kind: 'added', text: after }];
  const out: DiffSegment[] = [];
  for (const t of raw) {
    // Whitespace between two changed words belongs to the change, so the strikeout reads as one run.
    const last = out.at(-1);
    if (last && last.kind === t.kind) last.text += t.text;
    else out.push({ ...t });
  }
  // A space kept between a removed and an added run reads better inside the added one.
  for (let k = 1; k < out.length - 1; k++) {
    const seg = out[k]!;
    if (seg.kind === 'same' && !seg.text.trim() && out[k - 1]!.kind !== 'same' && out[k + 1]!.kind !== 'same') seg.kind = out[k + 1]!.kind;
  }
  return out.reduce<DiffSegment[]>((acc, s) => {
    const last = acc.at(-1);
    if (last && last.kind === s.kind) last.text += s.text;
    else acc.push({ ...s });
    return acc;
  }, []);
}

/** Items of a list (rules), each kept, added or removed, in the new order with removed ones where they were. */
export function listDiff(before: string[], after: string[]): DiffSegment[] {
  return lcsDiff(before, after);
}
