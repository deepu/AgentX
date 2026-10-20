/**
 * Installed plugins, binding versions and identity links (Phase 4, 22 §2, §3, §6). Written by
 * the kernel as system; people only read them.
 */
import type { IdentityCandidate, IdentityLink, MatchMethod, PluginManifest } from '@memwise/defs';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';

// ---------------------------------------------------------------- installed plugins

export interface PluginRow {
  id: string;
  version: string;
  hash: string;
  dir: string;
  manifest: PluginManifest;
  notes: string[];
  installedBy?: string;
  installedAt: string;
}

export class PgPluginStore {
  /** Records an install; installing the same version again updates its row (same folder, rediscovered tools). */
  async record(db: Queryable, p: Omit<PluginRow, 'installedAt'>): Promise<void> {
    await db.query(
      `insert into mw.plugins (id, version, hash, dir, manifest, notes, installed_by) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id, version) do update set hash = excluded.hash, dir = excluded.dir, manifest = excluded.manifest,
         notes = excluded.notes, installed_by = coalesce(excluded.installed_by, mw.plugins.installed_by)`,
      [p.id, p.version, p.hash, p.dir, json(p.manifest), json(p.notes), p.installedBy ?? null]);
  }

  /** Every installed version, newest install first. */
  async list(db: Queryable, id?: string): Promise<PluginRow[]> {
    const { rows } = await db.query<PluginDbRow>(
      `select * from mw.plugins where ($1::text is null or id = $1) order by id, installed_at desc, version desc`, [id ?? null]);
    return rows.map(toPlugin);
  }

  async get(db: Queryable, id: string, version: string): Promise<PluginRow | undefined> {
    const { rows } = await db.query<PluginDbRow>(`select * from mw.plugins where id = $1 and version = $2`, [id, version]);
    return rows[0] && toPlugin(rows[0]);
  }
}

interface PluginDbRow {
  id: string; version: string; hash: string; dir: string; manifest: PluginManifest; notes: string[] | null;
  installed_by: string | null; installed_at: Date;
}

function toPlugin(r: PluginDbRow): PluginRow {
  return {
    id: r.id, version: r.version, hash: r.hash, dir: r.dir, manifest: r.manifest, notes: r.notes ?? [],
    installedAt: iso(r.installed_at), ...compact({ installedBy: r.installed_by }),
  };
}

// ---------------------------------------------------------------- binding versions

export interface BindingVersionRow {
  pluginId: string;
  version: number;
  pluginVersion: string;
  hash: string;
  frozenBy?: string;
  runId?: string;
  draftId?: string;
  frozenAt: string;
}

export class PgBindingVersionStore {
  /** Records a freeze; recording the same version again (a retried freeze) changes nothing. */
  async record(db: Queryable, v: Omit<BindingVersionRow, 'frozenAt'>): Promise<void> {
    await db.query(
      `insert into mw.binding_versions (plugin_id, version, plugin_version, hash, frozen_by, run_id, draft_id)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (plugin_id, version) do nothing`,
      [v.pluginId, v.version, v.pluginVersion, v.hash, v.frozenBy ?? null, v.runId ?? null, v.draftId ?? null]);
  }

  /** Newest first. */
  async list(db: Queryable, pluginId: string): Promise<BindingVersionRow[]> {
    const { rows } = await db.query<BindingDbRow>(
      `select * from mw.binding_versions where plugin_id = $1 order by version desc`, [pluginId]);
    return rows.map(toBindingVersion);
  }

  /** The freeze a draft made, if it made one (a retried freeze finds it). */
  async byDraft(db: Queryable, draftId: string): Promise<BindingVersionRow | undefined> {
    const { rows } = await db.query<BindingDbRow>(
      `select * from mw.binding_versions where draft_id = $1 order by version desc limit 1`, [draftId]);
    return rows[0] && toBindingVersion(rows[0]);
  }
}

interface BindingDbRow {
  plugin_id: string; version: number; plugin_version: string; hash: string; frozen_by: string | null; run_id: string | null;
  draft_id: string | null; frozen_at: Date;
}

function toBindingVersion(r: BindingDbRow): BindingVersionRow {
  return {
    pluginId: r.plugin_id, version: r.version, pluginVersion: r.plugin_version, hash: r.hash, frozenAt: iso(r.frozen_at),
    ...compact({ frozenBy: r.frozen_by, runId: r.run_id, draftId: r.draft_id }),
  };
}

// ---------------------------------------------------------------- identity links and candidates

export type NewIdentityLink = Omit<IdentityLink, 'id' | 'at'>;
export type NewIdentityCandidate = Omit<IdentityCandidate, 'id' | 'status' | 'decidedBy' | 'decidedAt' | 'createdAt'>;

export class PgIdentityStore {
  /** Links an outside record; a record already linked keeps its link (returns false). */
  async link(db: Queryable, l: NewIdentityLink): Promise<boolean> {
    const r = await db.query(
      `insert into mw.identity_links (id, entity, record_id, plugin, source, external_id, method, score, reasons, linked_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (plugin, source, external_id) do nothing`,
      [`link_${ulid()}`, l.entity, l.recordId, l.plugin, l.source, l.externalId, l.method, l.score, json(l.reasons), l.linkedBy ?? null]);
    return (r.rowCount ?? 0) > 0;
  }

  async linkOf(db: Queryable, plugin: string, source: string, externalId: string): Promise<IdentityLink | undefined> {
    const { rows } = await db.query<LinkRow>(
      `select * from mw.identity_links where plugin = $1 and source = $2 and external_id = $3`, [plugin, source, externalId]);
    return rows[0] && toLink(rows[0]);
  }

  /** Links of one domain record, oldest first. */
  async links(db: Queryable, entity: string, recordId: string): Promise<IdentityLink[]> {
    const { rows } = await db.query<LinkRow>(
      `select * from mw.identity_links where entity = $1 and record_id = $2 order by at, id`, [entity, recordId]);
    return rows.map(toLink);
  }

  async linksOf(db: Queryable, plugin: string, source?: string): Promise<IdentityLink[]> {
    const { rows } = await db.query<LinkRow>(
      `select * from mw.identity_links where plugin = $1 and ($2::text is null or source = $2) order by at, id`, [plugin, source ?? null]);
    return rows.map(toLink);
  }

  /** A pending candidate; the same pair again (pending, confirmed or rejected) adds nothing (returns false). */
  async propose(db: Queryable, c: NewIdentityCandidate): Promise<boolean> {
    const r = await db.query(
      `insert into mw.identity_candidates (id, entity, record_id, plugin, source, external_id, score, reasons, external)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (plugin, source, external_id, record_id) do nothing`,
      [`idc_${ulid()}`, c.entity, c.recordId, c.plugin, c.source, c.externalId, c.score, json(c.reasons), json(c.external)]);
    return (r.rowCount ?? 0) > 0;
  }

  async candidate(db: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<IdentityCandidate | undefined> {
    const { rows } = await db.query<CandidateRow>(
      `select * from mw.identity_candidates where id = $1${opts.forUpdate ? ' for update' : ''}`, [id]);
    return rows[0] && toCandidate(rows[0]);
  }

  /** Candidates, oldest first. */
  async candidates(db: Queryable, filter: { status?: IdentityCandidate['status']; plugin?: string; source?: string; externalId?: string } = {}): Promise<IdentityCandidate[]> {
    const { rows } = await db.query<CandidateRow>(
      `select * from mw.identity_candidates
        where ($1::text is null or status = $1) and ($2::text is null or plugin = $2) and ($3::text is null or source = $3)
          and ($4::text is null or external_id = $4)
        order by created_at, id`,
      [filter.status ?? null, filter.plugin ?? null, filter.source ?? null, filter.externalId ?? null]);
    return rows.map(toCandidate);
  }

  /** Decides a pending candidate (`settled`: the kernel's, not a person's rejection); false when it was already decided. */
  async decide(db: Queryable, id: string, status: 'confirmed' | 'rejected' | 'settled', by: string): Promise<boolean> {
    const r = await db.query(
      `update mw.identity_candidates set status = $2, decided_by = $3, decided_at = now() where id = $1 and status = 'pending'`,
      [id, status, by]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Once a pair is linked, the other pending candidates of the same source for either side: the
   * same outside record, or the same domain record (links are one to one per source). They are
   * `settled`, no longer asked; not `rejected`, which is a person's "different" and stays so.
   */
  async settleOthers(db: Queryable, c: Pick<IdentityCandidate, 'plugin' | 'source' | 'externalId' | 'entity' | 'recordId' | 'id'>, by: string): Promise<number> {
    const r = await db.query(
      `update mw.identity_candidates set status = 'settled', decided_by = $7, decided_at = now()
        where plugin = $1 and source = $2 and id <> $3 and status = 'pending'
          and (external_id = $4 or (entity = $5 and record_id = $6))`,
      [c.plugin, c.source, c.id, c.externalId, c.entity, c.recordId, by]);
    return r.rowCount ?? 0;
  }

  /** The link a domain record has from one source, if any. */
  async linkOfRecord(db: Queryable, plugin: string, source: string, entity: string, recordId: string): Promise<IdentityLink | undefined> {
    const { rows } = await db.query<LinkRow>(
      `select * from mw.identity_links where plugin = $1 and source = $2 and entity = $3 and record_id = $4 order by at, id limit 1`,
      [plugin, source, entity, recordId]);
    return rows[0] && toLink(rows[0]);
  }
}

interface LinkRow {
  id: string; entity: string; record_id: string; plugin: string; source: string; external_id: string; method: MatchMethod;
  score: number; reasons: string[] | null; linked_by: string | null; at: Date;
}

function toLink(r: LinkRow): IdentityLink {
  return {
    id: r.id, entity: r.entity, recordId: r.record_id, plugin: r.plugin, source: r.source, externalId: r.external_id,
    method: r.method, score: Number(r.score), reasons: r.reasons ?? [], at: iso(r.at), ...compact({ linkedBy: r.linked_by }),
  };
}

interface CandidateRow {
  id: string; entity: string; record_id: string; plugin: string; source: string; external_id: string; score: number;
  reasons: string[] | null; external: Record<string, unknown> | null; status: IdentityCandidate['status'];
  decided_by: string | null; decided_at: Date | null; created_at: Date;
}

function toCandidate(r: CandidateRow): IdentityCandidate {
  return {
    id: r.id, entity: r.entity, recordId: r.record_id, plugin: r.plugin, source: r.source, externalId: r.external_id,
    score: Number(r.score), reasons: r.reasons ?? [], external: r.external ?? {}, status: r.status, createdAt: iso(r.created_at),
    ...compact({ decidedBy: r.decided_by, decidedAt: iso(r.decided_at) }),
  };
}
