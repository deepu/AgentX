/**
 * Secret redaction: a tool may echo a key back (an error message quoting the request, a debug
 * field), and whatever it returns reaches the model and the journal. Every occurrence of an
 * injected secret value becomes `[secret]`, at any depth.
 */

export const REDACTED = '[secret]';

export function redactSecrets<T>(value: T, secrets: string[]): T {
  const values = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  if (values.length === 0) return value;
  const redactString = (s: string) => values.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      // Class instances could hide a secret in a field; results are journaled as JSON anyway.
      const plain = Object.getPrototypeOf(v) === Object.prototype ? v : JSON.parse(JSON.stringify(v) ?? 'null');
      if (!plain || typeof plain !== 'object') return walk(plain);
      if (Array.isArray(plain)) return plain.map(walk);
      return Object.fromEntries(Object.entries(plain).map(([k, x]) => [redactString(k), walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
