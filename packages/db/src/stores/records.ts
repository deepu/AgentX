/**
 * History and integrity of records (24 §3, §7, §9): record versions with their hash chain,
 * the content hash a signature covers, signatures, and entity events. Versions and events are
 * written by the row trigger of each domain table; these stores read them (and add signatures).
 */
import crypto from 'node:crypto';
import type { EntityEvent, EntityEventKind } from '@memwise/defs';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';

export interface RecordVersionRow {
  entity: string;
  recordId: string;
  version: number;
  at: string;
  /** person id | step:<stepRunId> | source:<x> | system */
  by: string;
  via?: string;
  reason?: string;
  /** The whole record by field name (`status` = lifecycle). */
  values: Record<string, unknown>;
  changed: string[];
  prevHash: string;
  hash: string;
}

export interface ChainCheck { ok: boolean; brokenAt?: number; message?: string }

const ZERO_HASH = '0'.repeat(64);

type VersionDbRow = {
  entity: string; record_id: string; version: number; at: Date; by: string; via: string | null; reason: string | null;
  values: Record<string, unknown>; changed: string[]; prev_hash: string; hash: string;
};

const toVersion = (r: VersionDbRow): RecordVersionRow => ({
  entity: r.entity, recordId: r.record_id, version: r.version, at: iso(r.at), by: r.by,
  ...compact({ via: r.via, reason: r.reason }),
  values: r.values, changed: r.changed, prevHash: r.prev_hash, hash: r.hash,
});

export class PgRecordVersions {
  /** Every version of a record, oldest first. */
  async list(db: Queryable, entityKey: string, recordId: string): Promise<RecordVersionRow[]> {
    const { rows } = await db.query<VersionDbRow>(
      `select entity, record_id, version, at, by, via, reason, "values", changed, prev_hash, hash
       from mw.record_versions where entity = $1 and record_id = $2 order by version`, [entityKey, recordId]);
    return rows.map(toVersion);
  }

  /** The newest version (the record now). */
  async latest(db: Queryable, entityKey: string, recordId: string): Promise<RecordVersionRow | undefined> {
    const { rows } = await db.query<VersionDbRow>(
      `select entity, record_id, version, at, by, via, reason, "values", changed, prev_hash, hash
       from mw.record_versions where entity = $1 and record_id = $2 order by version desc limit 1`, [entityKey, recordId]);
    return rows[0] ? toVersion(rows[0]) : undefined;
  }

  /**
   * Recomputes the chain from the stored rows (in Postgres, with the same function that wrote
   * it): versions numbered 1, 2, 3… without gaps, each `prev_hash` the previous `hash` (64 zeros
   * for the first), each `hash` matching its content. Reports the first version that breaks it.
   */
  async verifyChain(db: Queryable, entityKey: string, recordId: string): Promise<ChainCheck> {
    const { rows } = await db.query<{ version: number; prev_hash: string; hash: string; recomputed: string }>(
      `select version, prev_hash, hash, mw.record_hash(prev_hash, entity, record_id, version, at, by, reason, "values") as recomputed
       from mw.record_versions where entity = $1 and record_id = $2 order by version`, [entityKey, recordId]);
    if (!rows.length) return { ok: false, message: `${entityKey} ${recordId} has no recorded versions` };
    let prev = ZERO_HASH;
    for (const [i, r] of rows.entries()) {
      if (r.version !== i + 1) return { ok: false, brokenAt: i + 1, message: `version ${i + 1} is missing` };
      if (r.prev_hash !== prev) {
        return { ok: false, brokenAt: r.version, message: `version ${r.version} doesn't follow version ${r.version - 1}: the chain was changed` };
      }
      if (r.recomputed !== r.hash) {
        return { ok: false, brokenAt: r.version, message: `version ${r.version} was changed after it was written: its content no longer matches its hash` };
      }
      prev = r.hash;
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------- content hash (24 §9)

/** JSON with object keys sorted, no spaces; `undefined` members dropped (as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * What a signature covers: sha256 (hex) of the canonical JSON of
 * `{ entity, record_id, file_sha256?, values }`. The same record content always hashes the same.
 */
export function contentHash(input: { entity: string; recordId: string; fileSha256?: string; values: Record<string, unknown> }): string {
  const doc = { entity: input.entity, record_id: input.recordId, ...(input.fileSha256 ? { file_sha256: input.fileSha256 } : {}), values: input.values };
  return crypto.createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

// ---------------------------------------------------------------- signatures (24 §9)

export interface NewSignature {
  /** Default `sig_<ulid>`. */
  id?: string;
  stepRunId?: string;
  caseId?: string;
  personId: string;
  /** The person's name when they signed. */
  name: string;
  meaning: string;
  /** The record it covers (entity key and id). */
  entity: string;
  recordId: string;
  contentHash: string;
  /** What was hashed (values, file), for the audit export. */
  manifest?: Record<string, unknown>;
}

export interface SignatureRow extends Omit<NewSignature, 'manifest'> {
  id: string;
  manifest: Record<string, unknown>;
  /** Server time. */
  at: string;
}

type SignatureDbRow = {
  id: string; step_run_id: string | null; case_id: string | null; person_id: string; name: string; meaning: string;
  entity: string; record_id: string; content_hash: string; manifest: Record<string, unknown>; at: Date;
};

const toSignature = (r: SignatureDbRow): SignatureRow => ({
  id: r.id, ...compact({ stepRunId: r.step_run_id, caseId: r.case_id }), personId: r.person_id, name: r.name,
  meaning: r.meaning, entity: r.entity, recordId: r.record_id, contentHash: r.content_hash, manifest: r.manifest, at: iso(r.at),
});

const SIGNATURE_COLS = 'id, step_run_id, case_id, person_id, name, meaning, entity, record_id, content_hash, manifest, at';

/** Signatures are append-only (a trigger refuses changes): one names one record and one hash, for good. */
export class PgSignatureStore {
  async add(db: Queryable, s: NewSignature): Promise<string> {
    const id = s.id ?? `sig_${ulid()}`;
    await db.query(
      `insert into mw.signatures (id, step_run_id, case_id, person_id, name, meaning, entity, record_id, content_hash, manifest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, s.stepRunId ?? null, s.caseId ?? null, s.personId, s.name, s.meaning, s.entity, s.recordId, s.contentHash, json(s.manifest ?? {})]);
    return id;
  }

  async get(db: Queryable, id: string): Promise<SignatureRow | undefined> {
    const { rows } = await db.query<SignatureDbRow>(`select ${SIGNATURE_COLS} from mw.signatures where id = $1`, [id]);
    return rows[0] ? toSignature(rows[0]) : undefined;
  }

  /** A record's signatures, oldest first. */
  async forRecord(db: Queryable, entityKey: string, recordId: string): Promise<SignatureRow[]> {
    const { rows } = await db.query<SignatureDbRow>(
      `select ${SIGNATURE_COLS} from mw.signatures where entity = $1 and record_id = $2 order by at, id`, [entityKey, recordId]);
    return rows.map(toSignature);
  }

  async forCase(db: Queryable, caseId: string): Promise<SignatureRow[]> {
    const { rows } = await db.query<SignatureDbRow>(`select ${SIGNATURE_COLS} from mw.signatures where case_id = $1 order by at, id`, [caseId]);
    return rows.map(toSignature);
  }

  async forStepRun(db: Queryable, stepRunId: string): Promise<SignatureRow[]> {
    const { rows } = await db.query<SignatureDbRow>(`select ${SIGNATURE_COLS} from mw.signatures where step_run_id = $1 order by at, id`, [stepRunId]);
    return rows.map(toSignature);
  }
}

// ---------------------------------------------------------------- entity events (24 §7)

type EventDbRow = { seq: string; id: string; entity: string; record_id: string; kind: EntityEventKind; data: Record<string, unknown>; by: string | null; at: Date };

const toEvent = (r: EventDbRow): EntityEvent => {
  const e: EntityEvent = { id: r.id, seq: Number(r.seq), entity: r.entity, recordId: r.record_id, kind: r.kind, at: iso(r.at) };
  const d = r.data ?? {};
  if (Array.isArray(d.fields)) e.fields = d.fields as string[];
  if (typeof d.state === 'string') e.state = d.state;
  if (typeof d.from === 'string') e.from = d.from;
  if (typeof d.transition === 'string') e.transition = d.transition;
  if (r.by) e.by = r.by;
  return e;
};

export class PgEntityEvents {
  /** Events after `seq` (exclusive), in order; optionally only one entity or one record. */
  async after(db: Queryable, seq: number, limit: number, filter: { entity?: string; recordId?: string } = {}): Promise<EntityEvent[]> {
    const { rows } = await db.query<EventDbRow>(
      `select seq, id, entity, record_id, kind, data, by, at from mw.entity_events
       where seq > $1 and ($3::text is null or entity = $3) and ($4::text is null or record_id = $4)
       order by seq limit $2`, [seq, limit, filter.entity ?? null, filter.recordId ?? null]);
    return rows.map(toEvent);
  }

  /** The newest event's seq, 0 when there is none. */
  async latestSeq(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ seq: string | null }>('select max(seq) as seq from mw.entity_events');
    return Number(rows[0]?.seq ?? 0);
  }
}
