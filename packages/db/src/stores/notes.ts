/**
 * Notes and mentions on records (24 §6). One note per record, every save a new version (the
 * old ones stay: append-only). Mentions are `@` references to a record from notes, chat
 * messages, step rationales, comments and pages; the editor writes them as
 * `[[etmf.Site:site_…]]` tokens (`mentionTokens`). The kernel checks who may read the record.
 */
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso } from '../rows.ts';

export interface RecordNote {
  entity: string;
  recordId: string;
  body: string;
  version: number;
  by: string;
  reason?: string;
  at: string;
}

type NoteDbRow = { entity: string; record_id: string; body: string; version: number; by: string; reason: string | null; at: Date };
const toNote = (r: NoteDbRow): RecordNote => ({
  entity: r.entity, recordId: r.record_id, body: r.body, version: r.version, by: r.by, ...compact({ reason: r.reason }), at: iso(r.at),
});

export class PgNoteStore {
  /** The record's note now (its newest version). */
  async get(db: Queryable, entityKey: string, recordId: string): Promise<RecordNote | undefined> {
    const { rows } = await db.query<NoteDbRow>(
      `select entity, record_id, body, version, by, reason, at from mw.record_notes
       where entity = $1 and record_id = $2 order by version desc limit 1`, [entityKey, recordId]);
    return rows[0] ? toNote(rows[0]) : undefined;
  }

  /**
   * Saves a new version of the note and returns its number. With `expectedVersion`, refuses
   * (code `stale`) when someone saved since. Saving the same text again makes no version.
   */
  async save(db: Queryable, entityKey: string, recordId: string, body: string, by: string,
    opts: { reason?: string; expectedVersion?: number } = {}): Promise<number> {
    const now = await this.get(db, entityKey, recordId);
    const version = now?.version ?? 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== version) {
      throw Object.assign(new Error(`The note changed since you opened it (version ${version}, not ${opts.expectedVersion})`), { code: 'stale' });
    }
    if (now && now.body === body) return version;
    await db.query(
      `insert into mw.record_notes (entity, record_id, version, body, by, reason) values ($1, $2, $3, $4, $5, $6)`,
      [entityKey, recordId, version + 1, body, by, opts.reason ?? null]);
    return version + 1;
  }

  /** Every version, oldest first. */
  async history(db: Queryable, entityKey: string, recordId: string): Promise<RecordNote[]> {
    const { rows } = await db.query<NoteDbRow>(
      `select entity, record_id, body, version, by, reason, at from mw.record_notes where entity = $1 and record_id = $2 order by version`,
      [entityKey, recordId]);
    return rows.map(toNote);
  }
}

export type MentionSourceKind = 'note' | 'chat' | 'step' | 'comment' | 'page';

export interface NewMention {
  targetEntity: string;
  targetId: string;
  sourceKind: MentionSourceKind;
  sourceId: string;
  /** How the source reads in the "Mentioned in" list. */
  label?: string;
  caseId?: string;
}

export interface MentionRow extends NewMention { id: string; at: string }

type MentionDbRow = {
  id: string; target_entity: string; target_id: string; source_kind: MentionSourceKind; source_id: string;
  label: string | null; case_id: string | null; at: Date;
};
const toMention = (r: MentionDbRow): MentionRow => ({
  id: r.id, targetEntity: r.target_entity, targetId: r.target_id, sourceKind: r.source_kind, sourceId: r.source_id,
  ...compact({ label: r.label, caseId: r.case_id }), at: iso(r.at),
});

/** `[[etmf.Site:site_01…]]` tokens in a text, in order, without repeats. */
export function mentionTokens(text: string): { entity: string; id: string }[] {
  const out: { entity: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[\[([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?):([A-Za-z0-9_\-]+)\]\]/g)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity: m[1]!, id: m[2]! });
  }
  return out;
}

export class PgMentionStore {
  /** Records a mention; the same source mentioning the same record again changes nothing. */
  async add(db: Queryable, m: NewMention): Promise<string> {
    const id = `men_${ulid()}`;
    const { rows } = await db.query<{ id: string }>(
      `insert into mw.mentions (id, target_entity, target_id, source_kind, source_id, label, case_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (target_entity, target_id, source_kind, source_id) do update set label = coalesce(excluded.label, mw.mentions.label)
       returning id`,
      [id, m.targetEntity, m.targetId, m.sourceKind, m.sourceId, m.label ?? null, m.caseId ?? null]);
    return rows[0]!.id;
  }

  /** Where a record is mentioned, newest first. */
  async forTarget(db: Queryable, entityKey: string, recordId: string): Promise<MentionRow[]> {
    const { rows } = await db.query<MentionDbRow>(
      `select id, target_entity, target_id, source_kind, source_id, label, case_id, at from mw.mentions
       where target_entity = $1 and target_id = $2 order by at desc, id desc`, [entityKey, recordId]);
    return rows.map(toMention);
  }

  /** Makes a source's mentions exactly these (a note or page was edited). */
  async replaceForSource(db: Queryable, sourceKind: MentionSourceKind, sourceId: string,
    targets: { entity: string; id: string; label?: string; caseId?: string }[]): Promise<void> {
    await db.query(
      `delete from mw.mentions where source_kind = $1 and source_id = $2
         and not ((target_entity, target_id) in (select * from unnest($3::text[], $4::text[])))`,
      [sourceKind, sourceId, targets.map((t) => t.entity), targets.map((t) => t.id)]);
    for (const t of targets) {
      await this.add(db, { targetEntity: t.entity, targetId: t.id, sourceKind, sourceId, ...compact({ label: t.label, caseId: t.caseId }) });
    }
  }
}
