// What a signature covers (24 §9): a record's own field values (not its status, calculated or
// followed fields, which change without the record changing) and the sha256 of its file. The
// same function hashes the record when it is signed and when the signature is checked, so a
// record whose content is unchanged always matches.
import { contentHash } from '@memwise/db';
import { keyOf, type EntityTypeDef } from '@memwise/defs';

const isFileType = (def: EntityTypeDef, field: string) => {
  const t = def.fields[field]?.type;
  return t?.kind === 'scalar' && (t.name === 'Document' || t.name === 'File' || t.name === 'Image');
};

/** The record's own fields, with nothing in them left out (so a cleared and a never-set field hash alike). */
export function signableValues(def: EntityTypeDef, values: Record<string, unknown>): Record<string, unknown> {
  const own = new Set([...Object.keys(def.fields), ...Object.entries(def.relationships).filter(([, r]) => r.cardinality === 'one').map(([n]) => n)]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (own.has(k) && v !== null && v !== undefined && v !== '') out[k] = v;
  return out;
}

/** The sha256 of the record's first Document or File field, when it has one. */
export function fileSha256(def: EntityTypeDef, values: Record<string, unknown>): string | undefined {
  for (const field of Object.keys(def.fields)) {
    if (!isFileType(def, field)) continue;
    const v = values[field] as { sha256?: unknown } | undefined;
    if (v && typeof v.sha256 === 'string') return v.sha256;
  }
  return undefined;
}

/** The content hash of a record with these values. */
export function recordContentHash(def: EntityTypeDef, recordId: string, values: Record<string, unknown>): { hash: string; manifest: Record<string, unknown> } {
  const signed = signableValues(def, values);
  const sha = fileSha256(def, signed);
  const input = { entity: keyOf(def), recordId, ...(sha ? { fileSha256: sha } : {}), values: signed };
  return { hash: contentHash(input), manifest: input };
}
