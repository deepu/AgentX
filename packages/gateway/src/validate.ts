/**
 * Minimal argument check against a tool's JSON Schema: required keys and top-level types.
 * Not a full validator; it catches the mistakes a model makes most (a missing key, a number
 * sent as a string) and says so in words the model can act on.
 */

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const matches = (v: unknown, type: string): boolean =>
  type === 'integer' ? Number.isInteger(v) : typeOf(v) === type;

/** Problems with `args`, empty when they pass. */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string[] {
  const properties = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (schema.type !== 'object' && !schema.properties && required.length === 0) return [];

  if (typeOf(args) !== 'object') return [`arguments must be an object (got ${typeOf(args)})`];
  const obj = args as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of required) {
    if (obj[key] === undefined) problems.push(`missing required "${key}"`);
  }
  for (const [key, value] of Object.entries(obj)) {
    const type = properties[key]?.type;
    if (value === undefined || type === undefined) continue;
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matches(value, t))) problems.push(`"${key}" must be ${types.join(' or ')} (got ${typeOf(value)})`);
  }
  return problems;
}
