/** Small conversions between Postgres rows and the contract types. */

/** timestamptz comes back as a Date; the contracts use ISO strings. */
export function iso(d: Date | string): string;
export function iso(d: Date | string | null | undefined): string | undefined;
export function iso(d: Date | string | null | undefined): string | undefined {
  if (d == null) return undefined;
  return typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
}

/**
 * A jsonb parameter. pg would send a JS array as a Postgres array, not JSON, so every jsonb
 * value is serialised here. `undefined` becomes SQL null.
 */
export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Drop keys whose value is null or undefined, so optional contract fields are absent, not null. */
export function compact<T extends object>(obj: T): { [K in keyof T]?: NonNullable<T[K]> } {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] == null) delete obj[key];
  return obj as { [K in keyof T]?: NonNullable<T[K]> };
}
