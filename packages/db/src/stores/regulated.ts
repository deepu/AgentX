/**
 * Regulated projects (26 §7, §8; Stage 5 of "Projects and pages"): change requests and their
 * validations, the project audit log (one hash chain per project), and inspector links and their
 * questions. Written by the kernel as system (the audit log only through `mw.audit_append`);
 * people read. A project is a domain for now: `project` holds the domain id.
 */
import crypto from 'node:crypto';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';
import { canonicalJson } from './records.ts';

// ---------------------------------------------------------------- change requests

export type ChangeRequestStatus = 'open' | 'in_review' | 'published' | 'withdrawn';

export interface ChangeRequestRow {
  id: string;
  project: string;
  number: number;
  workflowId: string;
  draftId: string;
  title: string;
  reason: string;
  status: ChangeRequestStatus;
  validationSet: Record<string, unknown>;
  chatId?: string;
  raisedBy: string;
  raisedAt: string;
  fromVersion?: number;
  fromHash?: string;
  toVersion?: number;
  toHash?: string;
  closedAt?: string;
  closedBy?: string;
  updatedAt: string;
}

export interface ChangeValidationRow {
  id: string;
  crId: string;
  draftHash: string;
  setLabel: string;
  total: number;
  passed: number;
  checkErrors: number;
  status: 'passed' | 'failed';
  results: unknown[];
  by?: string;
  at: string;
}

type CrDbRow = {
  id: string; project: string; number: number; workflow_id: string; draft_id: string; title: string; reason: string;
  status: ChangeRequestStatus; validation_set: Record<string, unknown>; chat_id: string | null; raised_by: string; raised_at: Date;
  from_version: number | null; from_hash: string | null; to_version: number | null; to_hash: string | null;
  closed_at: Date | null; closed_by: string | null; updated_at: Date;
};

const toCr = (r: CrDbRow): ChangeRequestRow => ({
  id: r.id, project: r.project, number: r.number, workflowId: r.workflow_id, draftId: r.draft_id, title: r.title, reason: r.reason,
  status: r.status, validationSet: r.validation_set ?? {}, raisedBy: r.raised_by, raisedAt: iso(r.raised_at), updatedAt: iso(r.updated_at),
  ...compact({
    chatId: r.chat_id, fromVersion: r.from_version, fromHash: r.from_hash, toVersion: r.to_version, toHash: r.to_hash,
    closedAt: iso(r.closed_at), closedBy: r.closed_by,
  }),
});

type CrvDbRow = {
  id: string; cr_id: string; draft_hash: string; set_label: string; total: number; passed: number; check_errors: number;
  status: 'passed' | 'failed'; results: unknown[]; by: string | null; at: Date;
};

const toValidation = (r: CrvDbRow): ChangeValidationRow => ({
  id: r.id, crId: r.cr_id, draftHash: r.draft_hash, setLabel: r.set_label, total: r.total, passed: r.passed, checkErrors: r.check_errors,
  status: r.status, results: r.results ?? [], at: iso(r.at), ...compact({ by: r.by }),
});

/** `CR-014`: the number as people write it. */
export const changeRequestLabel = (n: number) => `CR-${String(n).padStart(3, '0')}`;

export class PgChangeRequestStore {
  /**
   * The project's next number, taken: one more than the last, or what `setNextNumber` set (a
   * project moving off a paper log continues its numbers).
   */
  async takeNumber(db: Queryable, project: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `insert into mw.change_request_numbers as c (project, next)
       values ($1, coalesce((select max(number) from mw.change_requests where project = $1), 0) + 2)
       on conflict (project) do update set next = c.next + 1
       returning next - 1 as n`, [project]);
    return rows[0]!.n;
  }

  async setNextNumber(db: Queryable, project: string, next: number): Promise<void> {
    await db.query(
      `insert into mw.change_request_numbers (project, next) values ($1, $2) on conflict (project) do update set next = excluded.next`,
      [project, next]);
  }

  async create(db: Queryable, cr: Pick<ChangeRequestRow, 'project' | 'workflowId' | 'draftId' | 'title' | 'raisedBy'> & Partial<Pick<ChangeRequestRow, 'reason' | 'validationSet' | 'fromVersion' | 'fromHash' | 'chatId'>>): Promise<ChangeRequestRow> {
    const number = await this.takeNumber(db, cr.project);
    const { rows } = await db.query<CrDbRow>(
      `insert into mw.change_requests (id, project, number, workflow_id, draft_id, title, reason, status, validation_set, chat_id, raised_by, from_version, from_hash)
       values ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $12) returning *`,
      [`cr_${ulid()}`, cr.project, number, cr.workflowId, cr.draftId, cr.title, cr.reason ?? '', json(cr.validationSet ?? {}),
        cr.chatId ?? null, cr.raisedBy, cr.fromVersion ?? null, cr.fromHash ?? null]);
    return toCr(rows[0]!);
  }

  async get(db: Queryable, id: string): Promise<ChangeRequestRow | undefined> {
    const { rows } = await db.query<CrDbRow>(`select * from mw.change_requests where id = $1`, [id]);
    return rows[0] && toCr(rows[0]);
  }

  /** By id, or by number in a project (`CR-014` or `14`). */
  async find(db: Queryable, idOrNumber: string, project?: string): Promise<ChangeRequestRow | undefined> {
    const m = /^(?:CR-)?0*(\d+)$/i.exec(idOrNumber.trim());
    if (!m) return this.get(db, idOrNumber);
    const { rows } = await db.query<CrDbRow>(
      `select * from mw.change_requests where number = $1 and ($2::text is null or project = $2) order by raised_at desc limit 1`,
      [Number(m[1]), project ?? null]);
    return rows[0] && toCr(rows[0]);
  }

  async byDraft(db: Queryable, draftId: string): Promise<ChangeRequestRow | undefined> {
    const { rows } = await db.query<CrDbRow>(`select * from mw.change_requests where draft_id = $1`, [draftId]);
    return rows[0] && toCr(rows[0]);
  }

  /** Newest first. */
  async list(db: Queryable, filter: { project?: string; status?: ChangeRequestStatus[]; workflowId?: string } = {}): Promise<ChangeRequestRow[]> {
    const { rows } = await db.query<CrDbRow>(
      `select * from mw.change_requests
        where ($1::text is null or project = $1) and ($2::text[] is null or status = any($2)) and ($3::text is null or workflow_id = $3)
        order by raised_at desc, number desc`,
      [filter.project ?? null, filter.status ?? null, filter.workflowId ?? null]);
    return rows.map(toCr);
  }

  async update(db: Queryable, id: string, patch: Partial<Pick<ChangeRequestRow,
    'title' | 'reason' | 'status' | 'validationSet' | 'chatId' | 'toVersion' | 'toHash' | 'closedAt' | 'closedBy'>>): Promise<ChangeRequestRow | undefined> {
    const { rows } = await db.query<CrDbRow>(
      `update mw.change_requests set
         title = coalesce($2, title), reason = coalesce($3, reason), status = coalesce($4, status),
         validation_set = coalesce($5::jsonb, validation_set), chat_id = coalesce($6, chat_id),
         to_version = coalesce($7, to_version), to_hash = coalesce($8, to_hash),
         closed_at = coalesce($9::timestamptz, closed_at), closed_by = coalesce($10, closed_by), updated_at = clock_timestamp()
       where id = $1 returning *`,
      [id, patch.title ?? null, patch.reason ?? null, patch.status ?? null, json(patch.validationSet), patch.chatId ?? null,
        patch.toVersion ?? null, patch.toHash ?? null, patch.closedAt ?? null, patch.closedBy ?? null]);
    return rows[0] && toCr(rows[0]);
  }

  async addValidation(db: Queryable, v: Omit<ChangeValidationRow, 'id' | 'at'>): Promise<ChangeValidationRow> {
    const { rows } = await db.query<CrvDbRow>(
      `insert into mw.change_request_validations (id, cr_id, draft_hash, set_label, total, passed, check_errors, status, results, by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [`crv_${ulid()}`, v.crId, v.draftHash, v.setLabel, v.total, v.passed, v.checkErrors, v.status, json(v.results), v.by ?? null]);
    return toValidation(rows[0]!);
  }

  /** Oldest first: the first run, then each one after a fix. */
  async validations(db: Queryable, crId: string): Promise<ChangeValidationRow[]> {
    const { rows } = await db.query<CrvDbRow>(`select * from mw.change_request_validations where cr_id = $1 order by at, id`, [crId]);
    return rows.map(toValidation);
  }
}

// ---------------------------------------------------------------- the audit log

export type AuditActorKind = 'person' | 'ai' | 'system' | 'external' | 'inspector' | 'source';

export interface NewAuditEntry {
  project: string;
  actorKind: AuditActorKind;
  actor: string;
  actorLabel?: string;
  action: string;
  entity?: string;
  recordId?: string;
  caseId?: string;
  data?: Record<string, unknown>;
}

export interface AuditEntryRow {
  seq: number;
  id: string;
  project: string;
  /** Server time, UTC, to the microsecond (what the hash covers). */
  at: string;
  actorKind: AuditActorKind;
  actor: string;
  actorLabel: string | null;
  action: string;
  entity: string | null;
  recordId: string | null;
  caseId: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditFilter {
  project: string;
  entity?: string;
  recordId?: string;
  caseId?: string;
  /** Also the entries of the cases that touched the record (its step records). */
  withCases?: boolean;
  actorKinds?: AuditActorKind[];
  actions?: string[];
  /** Only entries with seq greater than this (paging, newest last). */
  afterSeq?: number;
  limit?: number;
}

const ZERO = '0'.repeat(64);

type AuditDbRow = {
  seq: string; id: string; project: string; at_text: string; actor_kind: AuditActorKind; actor: string; actor_label: string | null;
  action: string; entity: string | null; record_id: string | null; case_id: string | null; data: Record<string, unknown>;
  prev_hash: string; hash: string;
};

const AUDIT_COLS = `seq, id, project, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_text, actor_kind, actor,
  actor_label, action, entity, record_id, case_id, data, prev_hash, hash`;

const toAudit = (r: AuditDbRow): AuditEntryRow => ({
  seq: Number(r.seq), id: r.id, project: r.project, at: r.at_text, actorKind: r.actor_kind, actor: r.actor, actorLabel: r.actor_label,
  action: r.action, entity: r.entity, recordId: r.record_id, caseId: r.case_id, data: r.data ?? {}, prevHash: r.prev_hash, hash: r.hash,
});

/**
 * An entry's hash, as `mw.audit_hash` computes it: sha256(prev_hash ‖ canonical JSON of the
 * entry's fields). Lets an export be checked with no database.
 */
export function auditEntryHash(e: Pick<AuditEntryRow, 'id' | 'project' | 'at' | 'actorKind' | 'actor' | 'actorLabel' | 'action' | 'entity' | 'recordId' | 'caseId' | 'data' | 'prevHash'>): string {
  const doc = {
    id: e.id, project: e.project, at: e.at, actor_kind: e.actorKind, actor: e.actor, actor_label: e.actorLabel ?? null, action: e.action,
    entity: e.entity ?? null, record_id: e.recordId ?? null, case_id: e.caseId ?? null, data: e.data,
  };
  return crypto.createHash('sha256').update(e.prevHash + canonicalJson(doc)).digest('hex');
}

export interface AuditChainCheck {
  ok: boolean;
  entries: number;
  /** The first entry that doesn't hold: its hash is wrong, or it doesn't follow the one before. */
  brokenAt?: { seq: number; id: string; reason: 'hash' | 'link' };
  message?: string;
}

/**
 * Checks entries of one project in seq order: each hash recomputes, and each entry's
 * `prev_hash` is the hash of the entry before it. With `complete` (the whole log from its first
 * entry), the first entry must start the chain; a filtered export checks linkage only between
 * entries whose seq follow each other.
 */
export function checkAuditChain(entries: AuditEntryRow[], opts: { complete?: boolean } = {}): AuditChainCheck {
  let prev: AuditEntryRow | undefined;
  for (const [i, e] of entries.entries()) {
    if (auditEntryHash(e) !== e.hash) {
      return { ok: false, entries: entries.length, brokenAt: { seq: e.seq, id: e.id, reason: 'hash' }, message: `entry ${e.seq} (${e.id}) was changed after it was written: its hash doesn't match` };
    }
    const follows = prev ? (opts.complete || prev.seq === e.seq - 1 ? prev.hash === e.prevHash : true) : opts.complete && i === 0 ? e.prevHash === ZERO : true;
    if (!follows) {
      return { ok: false, entries: entries.length, brokenAt: { seq: e.seq, id: e.id, reason: 'link' }, message: `entry ${e.seq} (${e.id}) doesn't follow the entry before it: an entry was removed or changed` };
    }
    prev = e;
  }
  return { ok: true, entries: entries.length };
}

export class PgAuditLog {
  /** Appends one entry, chained to the project's last (in the caller's transaction). */
  async append(db: Queryable, e: NewAuditEntry): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `select mw.audit_append($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) as id`,
      [e.project, e.actorKind, e.actor, e.actorLabel ?? null, e.action, e.entity ?? null, e.recordId ?? null, e.caseId ?? null, json(e.data ?? {})]);
    return rows[0]!.id;
  }

  /** Entries in seq order (oldest first). */
  async list(db: Queryable, f: AuditFilter): Promise<AuditEntryRow[]> {
    const { rows } = await db.query<AuditDbRow>(
      `select ${AUDIT_COLS} from mw.audit_log a
        where project = $1
          and ($2::text is null or (entity = $2 and record_id = $3)
               or ($4::boolean and case_id in (select s.case_id from mw.signatures s where s.entity = $2 and s.record_id = $3 and s.case_id is not null
                                      union select st.case_id from mw.record_versions v join mw.step_runs st on st.id = v.via
                                       where v.entity = $2 and v.record_id = $3)))
          and ($5::text is null or case_id = $5)
          and ($6::text[] is null or actor_kind = any($6))
          and ($7::text[] is null or action = any($7))
          and seq > $8
        order by seq limit $9`,
      [f.project, f.entity ?? null, f.recordId ?? null, f.withCases ?? false, f.caseId ?? null, f.actorKinds ?? null, f.actions ?? null,
        f.afterSeq ?? 0, f.limit ?? 1000]);
    return rows.map(toAudit);
  }

  async get(db: Queryable, id: string): Promise<AuditEntryRow | undefined> {
    const { rows } = await db.query<AuditDbRow>(`select ${AUDIT_COLS} from mw.audit_log where id = $1`, [id]);
    return rows[0] && toAudit(rows[0]);
  }

  /** The whole chain of a project, checked in the database (every hash, every link). */
  async verify(db: Queryable, project: string): Promise<AuditChainCheck> {
    const { rows } = await db.query<{ seq: string; id: string; ok_hash: boolean; ok_link: boolean; n: string }>(
      `select seq, id, hash = mw.audit_hash(prev_hash, id, project, at, actor_kind, actor, actor_label, action, entity, record_id, case_id, data) as ok_hash,
              prev_hash = coalesce(lag(hash) over (order by seq), repeat('0', 64)) as ok_link, count(*) over () as n
         from mw.audit_log where project = $1 order by seq`, [project]);
    const n = rows.length;
    for (const r of rows) {
      if (!r.ok_hash) return { ok: false, entries: n, brokenAt: { seq: Number(r.seq), id: r.id, reason: 'hash' }, message: `entry ${r.seq} (${r.id}) was changed after it was written: its hash doesn't match` };
      if (!r.ok_link) return { ok: false, entries: n, brokenAt: { seq: Number(r.seq), id: r.id, reason: 'link' }, message: `entry ${r.seq} (${r.id}) doesn't follow the entry before it` };
    }
    return { ok: true, entries: n };
  }
}

// ---------------------------------------------------------------- inspectors

export interface InspectorPerson { name: string; email?: string; organisation?: string }

export interface InspectorLinkRow {
  id: string;
  project: string;
  name: string;
  inspectors: InspectorPerson[];
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
}

export interface InspectorQuestionRow {
  id: string;
  linkId: string;
  project: string;
  askedBy?: string;
  entity?: string;
  recordId?: string;
  question: string;
  askedAt: string;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
}

type LinkDbRow = {
  id: string; project: string; name: string; inspectors: InspectorPerson[]; expires_at: Date; created_by: string; created_at: Date;
  revoked_at: Date | null; revoked_by: string | null; first_opened_at: Date | null; last_opened_at: Date | null;
};

const toLink = (r: LinkDbRow): InspectorLinkRow => ({
  id: r.id, project: r.project, name: r.name, inspectors: r.inspectors ?? [], expiresAt: iso(r.expires_at), createdBy: r.created_by,
  createdAt: iso(r.created_at),
  ...compact({ revokedAt: iso(r.revoked_at), revokedBy: r.revoked_by, firstOpenedAt: iso(r.first_opened_at), lastOpenedAt: iso(r.last_opened_at) }),
});

const LINK_COLS = 'id, project, name, inspectors, expires_at, created_by, created_at, revoked_at, revoked_by, first_opened_at, last_opened_at';

type QuestionDbRow = {
  id: string; link_id: string; project: string; asked_by: string | null; entity: string | null; record_id: string | null; question: string;
  asked_at: Date; answer: string | null; answered_by: string | null; answered_at: Date | null;
};

const toQuestion = (r: QuestionDbRow): InspectorQuestionRow => ({
  id: r.id, linkId: r.link_id, project: r.project, question: r.question, askedAt: iso(r.asked_at),
  ...compact({ askedBy: r.asked_by, entity: r.entity, recordId: r.record_id, answer: r.answer, answeredBy: r.answered_by, answeredAt: iso(r.answered_at) }),
});

export class PgInspectorStore {
  async create(db: Queryable, l: Pick<InspectorLinkRow, 'project' | 'name' | 'inspectors' | 'expiresAt' | 'createdBy'> & { tokenHash: string }): Promise<InspectorLinkRow> {
    const { rows } = await db.query<LinkDbRow>(
      `insert into mw.inspector_links (id, project, token_hash, name, inspectors, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${LINK_COLS}`,
      [`insp_${ulid()}`, l.project, l.tokenHash, l.name, json(l.inspectors), l.expiresAt, l.createdBy]);
    return toLink(rows[0]!);
  }

  async get(db: Queryable, id: string): Promise<InspectorLinkRow | undefined> {
    const { rows } = await db.query<LinkDbRow>(`select ${LINK_COLS} from mw.inspector_links where id = $1`, [id]);
    return rows[0] && toLink(rows[0]);
  }

  async byTokenHash(db: Queryable, tokenHash: string): Promise<InspectorLinkRow | undefined> {
    const { rows } = await db.query<LinkDbRow>(`select ${LINK_COLS} from mw.inspector_links where token_hash = $1`, [tokenHash]);
    return rows[0] && toLink(rows[0]);
  }

  /** Newest first. */
  async list(db: Queryable, project: string): Promise<InspectorLinkRow[]> {
    const { rows } = await db.query<LinkDbRow>(`select ${LINK_COLS} from mw.inspector_links where project = $1 order by created_at desc`, [project]);
    return rows.map(toLink);
  }

  async revoke(db: Queryable, id: string, by: string): Promise<InspectorLinkRow | undefined> {
    const { rows } = await db.query<LinkDbRow>(
      `update mw.inspector_links set revoked_at = coalesce(revoked_at, clock_timestamp()), revoked_by = coalesce(revoked_by, $2)
        where id = $1 returning ${LINK_COLS}`, [id, by]);
    return rows[0] && toLink(rows[0]);
  }

  async extend(db: Queryable, id: string, expiresAt: string): Promise<InspectorLinkRow | undefined> {
    const { rows } = await db.query<LinkDbRow>(
      `update mw.inspector_links set expires_at = $2 where id = $1 and revoked_at is null returning ${LINK_COLS}`, [id, expiresAt]);
    return rows[0] && toLink(rows[0]);
  }

  async touch(db: Queryable, id: string): Promise<void> {
    await db.query(
      `update mw.inspector_links set first_opened_at = coalesce(first_opened_at, clock_timestamp()), last_opened_at = clock_timestamp() where id = $1`, [id]);
  }

  async ask(db: Queryable, q: Pick<InspectorQuestionRow, 'linkId' | 'project' | 'question'> & Partial<Pick<InspectorQuestionRow, 'askedBy' | 'entity' | 'recordId'>>): Promise<InspectorQuestionRow> {
    const { rows } = await db.query<QuestionDbRow>(
      `insert into mw.inspector_questions (id, link_id, project, asked_by, entity, record_id, question)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [`insq_${ulid()}`, q.linkId, q.project, q.askedBy ?? null, q.entity ?? null, q.recordId ?? null, q.question]);
    return toQuestion(rows[0]!);
  }

  async question(db: Queryable, id: string): Promise<InspectorQuestionRow | undefined> {
    const { rows } = await db.query<QuestionDbRow>(`select * from mw.inspector_questions where id = $1`, [id]);
    return rows[0] && toQuestion(rows[0]);
  }

  /** Oldest first. */
  async questions(db: Queryable, filter: { linkId?: string; project?: string; open?: boolean }): Promise<InspectorQuestionRow[]> {
    const { rows } = await db.query<QuestionDbRow>(
      `select * from mw.inspector_questions
        where ($1::text is null or link_id = $1) and ($2::text is null or project = $2) and (not $3 or answered_at is null)
        order by asked_at, id`, [filter.linkId ?? null, filter.project ?? null, filter.open ?? false]);
    return rows.map(toQuestion);
  }

  async answer(db: Queryable, id: string, answer: string, by: string): Promise<InspectorQuestionRow | undefined> {
    const { rows } = await db.query<QuestionDbRow>(
      `update mw.inspector_questions set answer = $2, answered_by = $3, answered_at = clock_timestamp()
        where id = $1 and answered_at is null returning *`, [id, answer, by]);
    return rows[0] && toQuestion(rows[0]);
  }
}
