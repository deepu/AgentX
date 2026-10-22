/**
 * Filling an entity's `title:` template (24 §4), shared by every place a record's title is made.
 *
 * A field left empty leaves no dangling separator ("US-012 ·"). A field whose value the next
 * field's value already starts with is left out with the text between them, so a study whose
 * name begins with its code reads "MW-301: meriglutide …", not "MW-301 · MW-301: meriglutide …"
 * (Rave's study names carry the protocol code).
 */
const FIELD = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EDGE = /^[\s·:|,–—-]+|[\s·:|,–—-]+$/g;

/** Does `next` begin with `value` as a whole word ("MW-301" in "MW-301: …", not "MW-3" in "MW-301")? */
function repeats(value: string, next: string): boolean {
  if (!value || !next.startsWith(value)) return false;
  return next.length === value.length || !/[\p{L}\p{N}]/u.test(next[value.length]!);
}

/**
 * The template filled from `valueOf` (undefined, null or '' is empty). `filled` counts the fields
 * that had a value; `title` is '' when nothing is left.
 */
export function fillTitle(template: string, valueOf: (field: string) => unknown): { title: string; fields: number; filled: number } {
  const parts: ({ text: string } | { value: string })[] = [];
  let at = 0;
  let fields = 0;
  for (const m of template.matchAll(FIELD)) {
    parts.push({ text: template.slice(at, m.index) });
    const v = valueOf(m[1]!);
    parts.push({ value: v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) });
    at = m.index! + m[0].length;
    fields++;
  }
  parts.push({ text: template.slice(at) });
  const filled = parts.filter((p) => 'value' in p && p.value !== '').length;
  // Drop a field the next field repeats, with the separator between them.
  for (let i = 1; i + 2 < parts.length; i += 2) {
    const cur = parts[i] as { value: string };
    const next = parts[i + 2] as { value: string };
    if (repeats(cur.value.trim(), next.value.trim())) { cur.value = ''; (parts[i + 1] as { text: string }).text = ''; }
  }
  const title = parts.map((p) => ('text' in p ? p.text : p.value)).join('').replace(EDGE, '').trim();
  return { title, fields, filled };
}
