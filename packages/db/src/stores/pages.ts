/**
 * Personal views and written pages (24 §6). Shared views and dashboards are definitions
 * (`views/*.yaml`, `pages/*.yaml`); a person's own views and the prose pages people write in the
 * app are data, kept here. A written page keeps every version.
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

export interface WrittenPage {
  id: string;
  domain: string;
  /** Where it hangs in the page tree: under an entity type, or one record. */
  under?: { entity: string; id?: string };
  title: string;
  /** Markdown. */
  body: string;
  version: number;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WrittenPageVersion { version: number; title: string; body: string; under?: { entity: string; id?: string }; by?: string; at: string }

type PageDbRow = {
  id: string; domain: string; under: { entity: string; id?: string } | null; title: string; body: string; version: number;
  updated_by: string | null; created_at: Date; updated_at: Date;
};
const toPage = (r: PageDbRow): WrittenPage => ({
  id: r.id, domain: r.domain, ...compact({ under: r.under }), title: r.title, body: r.body, version: r.version,
  ...compact({ updatedBy: r.updated_by }), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const PAGE_COLS = 'id, domain, under, title, body, version, updated_by, created_at, updated_at';

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

  /**
   * Creates a page (no `id`, or an unknown one) or saves a new version of it. With
   * `expectedVersion`, refuses (code `stale`) when someone saved since.
   */
  async save(db: Queryable, page: { id?: string; domain: string; under?: { entity: string; id?: string }; title: string; body: string },
    by: string, opts: { expectedVersion?: number } = {}): Promise<WrittenPage> {
    const title = page.title.trim();
    if (!title) throw new Error('A page needs a title');
    const existing = page.id ? await this.get(db, page.id) : undefined;
    if (opts.expectedVersion !== undefined && (existing?.version ?? 0) !== opts.expectedVersion) {
      throw Object.assign(new Error(`The page changed since you opened it (version ${existing?.version ?? 0}, not ${opts.expectedVersion})`), { code: 'stale' });
    }
    const id = existing?.id ?? page.id ?? `page_${ulid()}`;
    const version = (existing?.version ?? 0) + 1;
    if (existing) {
      await db.query(
        `update mw.pages set under = $2, title = $3, body = $4, version = $5, updated_by = $6, updated_at = now() where id = $1`,
        [id, json(page.under ?? null), title, page.body, version, by]);
    } else {
      await db.query(
        `insert into mw.pages (id, domain, under, title, body, version, updated_by) values ($1, $2, $3, $4, $5, 1, $6)`,
        [id, page.domain, json(page.under ?? null), title, page.body, by]);
    }
    await db.query(
      `insert into mw.page_versions (page_id, version, title, body, under, by) values ($1, $2, $3, $4, $5, $6)`,
      [id, version, title, page.body, json(page.under ?? null), by]);
    return (await this.get(db, id))!;
  }

  async versions(db: Queryable, id: string): Promise<WrittenPageVersion[]> {
    const { rows } = await db.query<{ version: number; title: string; body: string; under: WrittenPageVersion['under'] | null; by: string | null; at: Date }>(
      'select version, title, body, under, by, at from mw.page_versions where page_id = $1 order by version', [id]);
    return rows.map((r) => ({ version: r.version, title: r.title, body: r.body, ...compact({ under: r.under, by: r.by }), at: iso(r.at) }));
  }
}
