/**
 * Personal views and written pages (24 §6). Shared views and dashboards are definitions
 * (`views/*.yaml`, `pages/*.yaml`); a person's own views and the prose pages people write in the
 * app are data, kept here. A written page keeps every version.
 *
 * Projects and pages (26 §4): a page belongs to a project, may hang under a parent page, is a
 * draft until kept, and a kept one has a refresh schedule. Every version says how it was made
 * (`via`: `chat:<id>`, `run:<id>`, `person:<id>`) and why. A refresh that changes the answer waits
 * as a page change (`PgPageChangeStore`) until someone accepts it.
 */
import type { ViewDef } from '@memwise/defs';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';

export class PgViewStore {
  /** A person's own views in a domain, oldest first. */
  async listPersonal(db: Queryable, personId: string, domain: string): Promise<ViewDef[]> {
    const { rows } = await db.query<{ id: string; body: ViewDef }>(
      'select id, body from mw.views where person_id = $1 and domain = $2 order by created_at, id', [personId, domain]);
    return rows.map((r) => ({ ...r.body, id: r.id }));
  }

  /** Creates or replaces a personal view (an id the person doesn't own makes a new view). */
  async save(db: Queryable, personId: string, domain: string, view: ViewDef): Promise<ViewDef> {
    const id = view.id || `view_${ulid()}`;
    const body = { ...view, id };
    delete (body as { file?: string }).file;
    const { rowCount } = await db.query(
      `update mw.views set body = $4, domain = $3, updated_at = now() where id = $1 and person_id = $2`, [id, personId, domain, json(body)]);
    if (rowCount) return body;
    const fresh = await db.query(`select 1 from mw.views where id = $1`, [id]);
    const useId = fresh.rowCount ? `view_${ulid()}` : id;
    await db.query('insert into mw.views (id, person_id, domain, body) values ($1, $2, $3, $4)', [useId, personId, domain, json({ ...body, id: useId })]);
    return { ...body, id: useId };
  }

  /** Removes a person's view; true when there was one. */
  async remove(db: Queryable, personId: string, id: string): Promise<boolean> {
    const r = await db.query('delete from mw.views where id = $1 and person_id = $2', [id, personId]);
    return !!r.rowCount;
  }
}

export type PageStatus = 'draft' | 'kept' | 'archived';

/**
 * A kept page's refresh schedule: `every` is `daily`, `month` or a weekday (`mon` … `sun`);
 * `next` is when the refresh is due; `summaryDue` marks a parent whose sub-page changed.
 */
export interface PageRefresh {
  every: string;
  /** Last day to refresh (YYYY-MM-DD), for "Keep watching, daily until 28 Oct". */
  until?: string;
  next?: string;
  last?: string;
  /** The playbook that refreshes it, when not the app's default. */
  playbook?: string;
  summaryDue?: string;
}

export interface WrittenPage {
  id: string;
  domain: string;
  /** The project it belongs to (Stage 1 and 2: the domain id). */
  project: string;
  /** Where it hangs in the page tree: under an entity type, or one record. */
  under?: { entity: string; id?: string };
  /** The parent page. */
  parent?: string;
  title: string;
  /** Markdown. */
  body: string;
  version: number;
  status: PageStatus;
  /** The question it answers, when it was built from one. */
  question?: string;
  /** The chat that made it. */
  chatId?: string;
  refresh?: PageRefresh;
  pinned: boolean;
  /** A parent page that sums up its kept sub-pages. */
  sumsChildren: boolean;
  /** Who kept it (answer changes go to them). */
  owner?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WrittenPageVersion {
  version: number; title: string; body: string; under?: { entity: string; id?: string }; by?: string;
  /** `chat:<id>`, `run:<id>`, `person:<id>` */
  via?: string;
  reason?: string;
  at: string;
}

type PageDbRow = {
  id: string; domain: string; project: string; under: { entity: string; id?: string } | null; parent: string | null; title: string; body: string;
  version: number; status: PageStatus; question: string | null; chat_id: string | null; refresh: PageRefresh | null; pinned: boolean;
  sums_children: boolean; owner: string | null; created_by: string | null; updated_by: string | null; created_at: Date; updated_at: Date;
};
const toPage = (r: PageDbRow): WrittenPage => ({
  id: r.id, domain: r.domain, project: r.project, ...compact({ under: r.under, parent: r.parent }), title: r.title, body: r.body, version: r.version,
  status: r.status, ...compact({ question: r.question, chatId: r.chat_id, refresh: r.refresh }), pinned: r.pinned, sumsChildren: r.sums_children,
  ...compact({ owner: r.owner, createdBy: r.created_by, updatedBy: r.updated_by }), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const PAGE_COLS = `id, domain, project, under, parent, title, body, version, status, question, chat_id, refresh, pinned, sums_children, owner,
  created_by, updated_by, created_at, updated_at`;

/** What a new page may say beyond its title and body. */
export interface NewPage {
  id?: string;
  domain: string;
  /** Default the domain. */
  project?: string;
  under?: { entity: string; id?: string };
  parent?: string;
  title: string;
  body: string;
  status?: PageStatus;
  question?: string;
  chatId?: string;
  refresh?: PageRefresh;
  pinned?: boolean;
  sumsChildren?: boolean;
  owner?: string;
}

/** How a version was made: who, through what, and why. */
export interface VersionNote { via?: string; reason?: string; expectedVersion?: number }

const stale = (version: number | undefined, expected: number) =>
  Object.assign(new Error(`The page changed since you opened it (version ${version ?? 0}, not ${expected})`), { code: 'stale' });

export class PgPageStore {
  async get(db: Queryable, id: string): Promise<WrittenPage | undefined> {
    const { rows } = await db.query<PageDbRow>(`select ${PAGE_COLS} from mw.pages where id = $1`, [id]);
    return rows[0] ? toPage(rows[0]) : undefined;
  }

  /** A domain's written pages, by title. */
  async list(db: Queryable, domain: string): Promise<WrittenPage[]> {
    const { rows } = await db.query<PageDbRow>(`select ${PAGE_COLS} from mw.pages where domain = $1 order by title, id`, [domain]);
    return rows.map(toPage);
  }

  /** A project's pages (archived ones too when asked), parents before children, then by title. */
  async listProject(db: Queryable, project: string, opts: { archived?: boolean } = {}): Promise<WrittenPage[]> {
    const { rows } = await db.query<PageDbRow>(
      `select ${PAGE_COLS} from mw.pages where project = $1 and ($2 or status <> 'archived') order by title, id`,
      [project, opts.archived === true]);
    return rows.map(toPage);
  }

  /** The pages directly under a page, by title. */
  async children(db: Queryable, parent: string, opts: { archived?: boolean } = {}): Promise<WrittenPage[]> {
    const { rows } = await db.query<PageDbRow>(
      `select ${PAGE_COLS} from mw.pages where parent = $1 and ($2 or status <> 'archived') order by title, id`, [parent, opts.archived === true]);
    return rows.map(toPage);
  }

  /** Kept pages whose refresh is due at `now` (or that sum up a sub-page that changed). */
  async due(db: Queryable, now: Date): Promise<WrittenPage[]> {
    const { rows } = await db.query<PageDbRow>(
      `select ${PAGE_COLS} from mw.pages
        where status = 'kept' and refresh is not null
          and (refresh ->> 'until' is null or (refresh ->> 'until')::date >= ($1::timestamptz)::date)
          and ((refresh ->> 'next')::timestamptz <= $1 or (refresh ->> 'summaryDue') is not null)
        order by updated_at, id limit 500`, [now.toISOString()]);
    return rows.map(toPage);
  }

  /**
   * Creates a page (no `id`, or an unknown one) or saves a new version of it. With
   * `expectedVersion`, refuses (code `stale`) when someone saved since. A new page is kept (the
   * prose pages of 0006) unless it says `status: 'draft'`, as a page built from a question does.
   */
  async save(db: Queryable, page: NewPage, by: string, opts: VersionNote = {}): Promise<WrittenPage> {
    const title = page.title.trim();
    if (!title) throw new Error('A page needs a title');
    const existing = page.id ? await this.get(db, page.id) : undefined;
    if (opts.expectedVersion !== undefined && (existing?.version ?? 0) !== opts.expectedVersion) throw stale(existing?.version, opts.expectedVersion);
    if (existing) return this.write(db, existing.id, { title, body: page.body, under: page.under ?? null }, by, opts);
    const id = page.id ?? `page_${ulid()}`;
    await db.query(
      `insert into mw.pages (id, domain, project, under, parent, title, body, version, status, question, chat_id, refresh, pinned, sums_children,
                             owner, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [id, page.domain, page.project ?? page.domain, json(page.under ?? null), page.parent ?? null, title, page.body, page.status ?? 'kept',
        page.question ?? null, page.chatId ?? null, json(page.refresh ?? null), page.pinned === true, page.sumsChildren === true, page.owner ?? null, by]);
    await this.addVersion(db, id, 1, title, page.body, page.under ?? null, by, opts);
    return (await this.get(db, id))!;
  }

  /**
   * A new version with a changed title, body or place (whatever is given); `null` clears
   * `under`/`parent`. The version number goes up by one, and the version says how and why.
   */
  async write(db: Queryable, id: string, change: { title?: string; body?: string; under?: WrittenPage['under'] | null; parent?: string | null },
    by: string, opts: VersionNote = {}): Promise<WrittenPage> {
    const existing = await this.get(db, id);
    if (!existing) throw Object.assign(new Error(`There is no page ${id}`), { code: 'missing' });
    if (opts.expectedVersion !== undefined && existing.version !== opts.expectedVersion) throw stale(existing.version, opts.expectedVersion);
    const title = change.title !== undefined ? change.title.trim() : existing.title;
    if (!title) throw new Error('A page needs a title');
    const body = change.body ?? existing.body;
    const under = change.under === undefined ? existing.under ?? null : change.under;
    const parent = change.parent === undefined ? existing.parent ?? null : change.parent;
    const version = existing.version + 1;
    // Guarded by the version read above, so two writers at once can't both make version n+1.
    const { rowCount } = await db.query(
      `update mw.pages set under = $2, parent = $3, title = $4, body = $5, version = $6, updated_by = $7, updated_at = now()
        where id = $1 and version = $8`,
      [id, json(under), parent, title, body, version, by, existing.version]);
    if (!rowCount) throw stale(existing.version + 1, existing.version);
    await this.addVersion(db, id, version, title, body, under, by, opts);
    return (await this.get(db, id))!;
  }

  private async addVersion(db: Queryable, id: string, version: number, title: string, body: string, under: WrittenPage['under'] | null,
    by: string, opts: VersionNote) {
    await db.query(
      `insert into mw.page_versions (page_id, version, title, body, under, by, via, reason) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, version, title, body, json(under ?? null), by, opts.via ?? null, opts.reason ?? null]);
  }

  /** Changes what a page is, not what it says (no new version): status, schedule, place, flags. */
  async set(db: Queryable, id: string, change: {
    status?: PageStatus; refresh?: PageRefresh | null; parent?: string | null; pinned?: boolean; sumsChildren?: boolean; owner?: string | null;
    question?: string | null; chatId?: string | null;
  }): Promise<WrittenPage | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (change.status !== undefined) add('status', change.status);
    if (change.refresh !== undefined) add('refresh', json(change.refresh));
    if (change.parent !== undefined) add('parent', change.parent);
    if (change.pinned !== undefined) add('pinned', change.pinned);
    if (change.sumsChildren !== undefined) add('sums_children', change.sumsChildren);
    if (change.owner !== undefined) add('owner', change.owner);
    if (change.question !== undefined) add('question', change.question);
    if (change.chatId !== undefined) add('chat_id', change.chatId);
    if (!sets.length) return this.get(db, id);
    await db.query(`update mw.pages set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    return this.get(db, id);
  }

  async versions(db: Queryable, id: string): Promise<WrittenPageVersion[]> {
    const { rows } = await db.query<{ version: number; title: string; body: string; under: WrittenPageVersion['under'] | null; by: string | null; via: string | null; reason: string | null; at: Date }>(
      'select version, title, body, under, by, via, reason, at from mw.page_versions where page_id = $1 order by version', [id]);
    return rows.map((r) => ({ version: r.version, title: r.title, body: r.body, ...compact({ under: r.under, by: r.by, via: r.via, reason: r.reason }), at: iso(r.at) }));
  }

  /** One version, with its body. */
  async version(db: Queryable, id: string, version: number): Promise<WrittenPageVersion | undefined> {
    const { rows } = await db.query<{ version: number; title: string; body: string; under: WrittenPageVersion['under'] | null; by: string | null; via: string | null; reason: string | null; at: Date }>(
      'select version, title, body, under, by, via, reason, at from mw.page_versions where page_id = $1 and version = $2', [id, version]);
    const r = rows[0];
    return r ? { version: r.version, title: r.title, body: r.body, ...compact({ under: r.under, by: r.by, via: r.via, reason: r.reason }), at: iso(r.at) } : undefined;
  }

  /** Every version without its body (`body` is empty): what a history line needs. */
  async versionNotes(db: Queryable, id: string): Promise<WrittenPageVersion[]> {
    const { rows } = await db.query<{ version: number; title: string; by: string | null; via: string | null; reason: string | null; at: Date }>(
      'select version, title, by, via, reason, at from mw.page_versions where page_id = $1 order by version', [id]);
    return rows.map((r) => ({ version: r.version, title: r.title, body: '', ...compact({ by: r.by, via: r.via, reason: r.reason }), at: iso(r.at) }));
  }
}

// ---------------------------------------------------------------- answer changes (26 §4)

export type PageChangeStatus = 'pending' | 'accepted' | 'sent_back' | 'nothing_new';

/** What "Review an answer change" shows: the headline before and after, the new sections and what was left out. */
export interface PageChangeSummary {
  /** For the waiting list: "1 new trial". */
  label?: string;
  /** The headline now, and as the refresh wrote it. */
  before?: string;
  after?: string;
  /** When the headline stays: what the change adds, in one sentence ("The same, plus: …"). */
  plus?: string;
  /** Sections the refresh added or changed, with where each change came from. */
  sections?: { heading: string; markdown: string; origin: 'refresh' | 'chat'; changed?: 'added' | 'changed' }[];
  /** Sections the refresh removed. */
  removed?: string[];
  /** Papers or sources the refresh looked at and left out, with why. */
  leftOut?: { title: string; href?: string; why: string }[];
  numbers?: { added: string[]; removed: string[] };
  /** For the history: what changed, in a few words ("ATTAIN-MAINTAIN added"). */
  title?: string;
  /** What the reviewer's chat said it changed in the update ("added a note under the chart"). */
  chatNote?: string;
  /** What started the refresh: `schedule` (with the weekday), `manual`, `summary` (a sub-page changed). */
  from?: { kind: 'schedule' | 'manual' | 'summary'; every?: string; by?: string };
}

export interface PageChange {
  id: string;
  pageId: string;
  fromVersion: number;
  toVersion?: number;
  runId?: string;
  caseId?: string;
  stepRunId?: string;
  status: PageChangeStatus;
  title: string;
  body: string;
  summary: PageChangeSummary;
  reviewedBy?: string;
  comment?: string;
  reviewedAt?: string;
  at: string;
}

type ChangeDbRow = {
  id: string; page_id: string; from_version: number; to_version: number | null; run_id: string | null; case_id: string | null; step_run_id: string | null;
  status: PageChangeStatus; title: string; body: string; summary: PageChangeSummary; reviewed_by: string | null; comment: string | null;
  reviewed_at: Date | null; at: Date;
};
const toChange = (r: ChangeDbRow): PageChange => ({
  id: r.id, pageId: r.page_id, fromVersion: r.from_version,
  ...compact({ toVersion: r.to_version, runId: r.run_id, caseId: r.case_id, stepRunId: r.step_run_id }),
  status: r.status, title: r.title, body: r.body, summary: r.summary ?? {},
  ...compact({ reviewedBy: r.reviewed_by, comment: r.comment, reviewedAt: iso(r.reviewed_at) }), at: iso(r.at),
});

export class PgPageChangeStore {
  async get(db: Queryable, id: string): Promise<PageChange | undefined> {
    const { rows } = await db.query<ChangeDbRow>('select * from mw.page_changes where id = $1', [id]);
    return rows[0] ? toChange(rows[0]) : undefined;
  }

  /** The change waiting for review on a page, if any (one at a time). */
  async pending(db: Queryable, pageId: string): Promise<PageChange | undefined> {
    const { rows } = await db.query<ChangeDbRow>(`select * from mw.page_changes where page_id = $1 and status = 'pending'`, [pageId]);
    return rows[0] ? toChange(rows[0]) : undefined;
  }

  /** A page's changes, newest first; `withBody: false` leaves the proposed bodies out (`body` is empty). */
  async forPage(db: Queryable, pageId: string, opts: { withBody?: boolean } = {}): Promise<PageChange[]> {
    const cols = opts.withBody === false
      ? `id, page_id, from_version, to_version, run_id, case_id, step_run_id, status, title, '' as body, summary, reviewed_by, comment, reviewed_at, at`
      : '*';
    const { rows } = await db.query<ChangeDbRow>(`select ${cols} from mw.page_changes where page_id = $1 order by at desc, id desc`, [pageId]);
    return rows.map(toChange);
  }

  async forRun(db: Queryable, runId: string): Promise<PageChange | undefined> {
    const { rows } = await db.query<ChangeDbRow>('select * from mw.page_changes where run_id = $1 order by at desc limit 1', [runId]);
    return rows[0] ? toChange(rows[0]) : undefined;
  }

  /** Changes reviewed by these step runs (the inbox's "Review an answer change" items). */
  async forStepRuns(db: Queryable, stepRunIds: string[]): Promise<PageChange[]> {
    if (!stepRunIds.length) return [];
    const { rows } = await db.query<ChangeDbRow>('select * from mw.page_changes where step_run_id = any($1::text[])', [stepRunIds]);
    return rows.map(toChange);
  }

  /**
   * Records a refresh's new page for review. A page has one pending change: an older one is
   * replaced (sent back as replaced, returned in `superseded` so its run's review can be ended). The same id again (a retried
   * compare) updates the change only while it is still pending; a decided one is returned as it is.
   */
  async propose(db: Queryable, c: Pick<PageChange, 'pageId' | 'fromVersion' | 'title' | 'body' | 'summary'> & { runId?: string; caseId?: string; id?: string }):
    Promise<PageChange & { superseded: { id: string; runId?: string }[] }> {
    const id = c.id ?? `pch_${ulid()}`;
    const existing = await this.get(db, id);
    if (existing && existing.status !== 'pending') return { ...existing, superseded: [] };
    // One pending change per page: a newer refresh supersedes one nobody reviewed yet.
    const old = await db.query<{ id: string; run_id: string | null }>(
      `update mw.page_changes set status = 'sent_back', comment = 'Replaced by a newer refresh', reviewed_at = now()
        where page_id = $1 and status = 'pending' and id <> $2 returning id, run_id`, [c.pageId, id]);
    const { rows } = await db.query<ChangeDbRow>(
      `insert into mw.page_changes (id, page_id, from_version, run_id, case_id, title, body, summary)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set title = excluded.title, body = excluded.body, summary = excluded.summary
         where mw.page_changes.status = 'pending'
       returning *`,
      [id, c.pageId, c.fromVersion, c.runId ?? null, c.caseId ?? null, c.title, c.body, json(c.summary)]);
    const row = rows[0] ? toChange(rows[0]) : (await this.get(db, id))!;
    return { ...row, superseded: old.rows.map((r) => ({ id: r.id, ...(r.run_id ? { runId: r.run_id } : {}) })) };
  }

  /** Changes the proposed page while it waits (the reviewer's chat). */
  async revise(db: Queryable, id: string, change: { body?: string; title?: string; summary?: PageChangeSummary }): Promise<PageChange | undefined> {
    const { rows } = await db.query<ChangeDbRow>(
      `update mw.page_changes set body = coalesce($2, body), title = coalesce($3, title), summary = coalesce($4, summary)
        where id = $1 and status = 'pending' returning *`, [id, change.body ?? null, change.title ?? null, json(change.summary)]);
    return rows[0] ? toChange(rows[0]) : undefined;
  }

  /**
   * A refresh that found nothing material: one row, for the page's history ("nothing new"). With
   * an `id` (derived from the run), a retried compare finds the row it wrote and adds no second one.
   */
  async nothingNew(db: Queryable, c: { pageId: string; fromVersion: number; runId?: string; caseId?: string; summary?: PageChangeSummary; id?: string }): Promise<PageChange> {
    const id = c.id ?? `pch_${ulid()}`;
    const { rows } = await db.query<ChangeDbRow>(
      `insert into mw.page_changes (id, page_id, from_version, run_id, case_id, status, title, body, summary, reviewed_at)
       select $1, p.id, $3, $4, $5, 'nothing_new', p.title, '', $6, now() from mw.pages p where p.id = $2
       on conflict (id) do nothing
       returning *`, [id, c.pageId, c.fromVersion, c.runId ?? null, c.caseId ?? null, json(c.summary ?? {})]);
    if (rows[0]) return toChange(rows[0]);
    const again = await this.get(db, id);
    if (!again) throw new Error(`There is no page ${c.pageId}`);
    return again;
  }

  async setStepRun(db: Queryable, id: string, stepRunId: string): Promise<void> {
    await db.query('update mw.page_changes set step_run_id = $2 where id = $1', [id, stepRunId]);
  }

  /** Accepted (it became `toVersion`) or sent back. Only a pending change is decided; false otherwise. */
  async decide(db: Queryable, id: string, d: { status: 'accepted' | 'sent_back'; by: string; comment?: string; toVersion?: number }): Promise<boolean> {
    const { rowCount } = await db.query(
      `update mw.page_changes set status = $2, reviewed_by = $3, comment = $4, to_version = $5, reviewed_at = now()
        where id = $1 and status = 'pending'`, [id, d.status, d.by, d.comment ?? null, d.toVersion ?? null]);
    return !!rowCount;
  }
}
