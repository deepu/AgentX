// Inspectors (26 §8, D117): a read-only external link for an inspection, until an end date. It
// shows filed documents, their signatures and their audit trail, and nothing else: no drafts, no
// chats, no review proposals or other AI suggestions, no notes. Every view and download is
// written to the project's audit log; questions go to the people (an inbox item for the domain's
// owner), never to an agent. Only the sha256 of a link's token is kept.
import crypto from 'node:crypto';
import { PgEntityStore, PgInspectorStore, type InspectorLinkRow, type InspectorQuestionRow, type StoredEntityRow } from '@memwise/db';
import { keyOf, type EntityTypeDef, type ProjectDefs } from '@memwise/defs';
import type pg from 'pg';
import { isDocumentLike } from '../records/review.ts';
import { entityByName, recordTitle, refEntity } from '../records/context.ts';
import { signatureViews } from '../records/page.ts';
import type { Actor, InboxItem, PersonActor, PublicRequestInfo } from '../types.ts';
import { holdsRole } from './changes.ts';
import { TMF_ZONES, zoneOfArtifact } from './tmf.ts';
import type {
  AuditEntryView, AuditLogService, InspectorDocument, InspectorIndex, InspectorLinkView, InspectorQuestionView, InspectorRefusal,
  InspectorService,
} from './types.ts';

export const INSPECTOR_TOKEN_PREFIX = 'mwi_';
const TOKEN_RE = /^mwi_[A-Za-z0-9_-]{43}$/;
/** The longest an inspector link may run. */
export const MAX_INSPECTOR_DAYS = 90;
/** States a filed document is shown in (a superseded version stays part of the file). */
const FILED_STATES = new Set(['filed', 'superseded']);
/** What an inspector's trail leaves out: change requests, other inspectors, exports. */
const HIDDEN_ACTIONS = /^(change|inspector|audit)\./;

/**
 * Whether an entry of a document's trail is shown to an inspector: not the kernel's own entries
 * (above), and of record changes only those of this record (its cases also wrote other records).
 */
export function inspectorSees(e: Pick<AuditEntryView, 'action' | 'entity' | 'recordId'>, entity: string, recordId: string): boolean {
  if (HIDDEN_ACTIONS.test(e.action)) return false;
  if (e.action.startsWith('record.')) return e.entity === entity && e.recordId === recordId;
  return true;
}

/** An AI entry without the AI's own words about it (D117: no AI suggestions); its quote of the document stays. */
export function withoutAiProse<T extends Pick<AuditEntryView, 'actorKind' | 'data'>>(e: T): T {
  if (e.actorKind !== 'ai' || !e.data || !('rationale' in e.data)) return e;
  const { rationale: _drop, ...data } = e.data;
  return { ...e, data };
}

export const inspectorTokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export interface InspectorDeps {
  pool: pg.Pool;
  entities(): Record<string, EntityTypeDef>;
  project(): ProjectDefs | undefined;
  people: import('@memwise/db').PgPeopleStore;
  files?: import('@memwise/db').PgFileStore;
  auditLog: () => AuditLogService;
  publicUrl?: () => string | undefined;
  emit(change: import('../types.ts').KernelChange): void;
}

const store = new PgInspectorStore();
const entityStore = new PgEntityStore();

const humanize = (id: string) => {
  const w = id.replace(/[_.-]+/g, ' ').trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : id;
};

function linkStatus(l: InspectorLinkRow, now = Date.now()): InspectorLinkView['status'] {
  if (l.revokedAt) return 'revoked';
  return new Date(l.expiresAt).getTime() <= now ? 'expired' : 'active';
}

export function createInspectorService(deps: InspectorDeps): InspectorService & { inboxItems(actor: Actor): Promise<InboxItem[]> } {
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) names.set(id, (await deps.people.get(id).catch(() => undefined))?.name ?? id);
    return names.get(id)!;
  };
  const who = (l: InspectorLinkRow) => l.inspectors.map((i) => [i.name, i.organisation].filter(Boolean).join(', ')).join('; ') || l.name;

  /** The record types an inspector sees: the project's documents that are filed. */
  function documentTypes(project: string): EntityTypeDef[] {
    return Object.values(deps.entities()).filter((d) => (d.domain ?? 'domain') === project && isDocumentLike(d)
      && (d.lifecycle ?? Object.keys(d.lifecycleChart?.states ?? {})).some((s) => FILED_STATES.has(s)));
  }

  async function linkView(l: InspectorLinkRow): Promise<InspectorLinkView> {
    const { rows } = await deps.pool.query<{ action: string; n: number }>(
      `select action, count(*)::int as n from mw.audit_log where project = $1 and actor_kind = 'inspector' and actor = $2 group by action`, [l.project, l.id]);
    const count = (a: string) => rows.find((r) => r.action === a)?.n ?? 0;
    const qs = await store.questions(deps.pool, { linkId: l.id });
    return {
      id: l.id, project: l.project, name: l.name, inspectors: l.inspectors, expiresAt: l.expiresAt,
      createdBy: { id: l.createdBy, name: await nameOf(l.createdBy) }, createdAt: l.createdAt,
      ...(l.revokedAt ? { revokedAt: l.revokedAt } : {}), ...(l.firstOpenedAt ? { firstOpenedAt: l.firstOpenedAt } : {}),
      ...(l.lastOpenedAt ? { lastOpenedAt: l.lastOpenedAt } : {}),
      status: linkStatus(l), views: count('inspector.viewed') + count('inspector.opened') + count('inspector.listed'), downloads: count('inspector.downloaded'),
      questions: { open: qs.filter((q) => !q.answeredAt).length, answered: qs.filter((q) => q.answeredAt).length },
    };
  }

  async function questionView(q: InspectorQuestionRow, link?: InspectorLinkRow): Promise<InspectorQuestionView> {
    const l = link ?? (await store.get(deps.pool, q.linkId));
    let record: InspectorQuestionView['record'];
    if (q.entity && q.recordId) {
      const def = entityByName(deps.entities(), q.entity);
      const row = def ? await entityStore.get(deps.pool, def, q.recordId).catch(() => undefined) : undefined;
      record = { entity: q.entity, id: q.recordId, title: def && row ? recordTitle(def, q.recordId, row.values) : q.recordId };
    }
    return {
      id: q.id, linkId: q.linkId, linkName: l?.name ?? '', project: q.project, question: q.question, askedAt: q.askedAt,
      ...(q.askedBy ? { askedBy: q.askedBy } : {}), ...(record ? { record } : {}),
      ...(q.answer ? { answer: q.answer } : {}), ...(q.answeredBy ? { answeredBy: { id: q.answeredBy, name: await nameOf(q.answeredBy) } } : {}),
      ...(q.answeredAt ? { answeredAt: q.answeredAt } : {}),
    };
  }

  /** The link a token opens, if it may still be used. */
  async function linkFor(token: string): Promise<InspectorLinkRow | InspectorRefusal> {
    if (!TOKEN_RE.test(token)) return { refused: 'unknown' };
    const l = await store.byTokenHash(deps.pool, inspectorTokenHash(token));
    if (!l) return { refused: 'unknown' };
    const s = linkStatus(l);
    return s === 'active' ? l : { refused: s };
  }
  const refused = (x: unknown): x is InspectorRefusal => !!x && typeof x === 'object' && 'refused' in x;

  async function logged(l: InspectorLinkRow, action: string, rec: { entity?: string; recordId?: string }, data: Record<string, unknown> = {}) {
    await deps.auditLog().append({
      project: l.project, actorKind: 'inspector', actor: l.id, actorLabel: who(l), action,
      ...(rec.entity ? { entity: rec.entity } : {}), ...(rec.recordId ? { recordId: rec.recordId } : {}), data: { link: l.name, ...data },
    });
  }

  /** A filed document of the link's project, or undefined. */
  async function filedDocument(l: InspectorLinkRow, entity: string, id: string): Promise<{ def: EntityTypeDef; row: StoredEntityRow } | undefined> {
    const def = entityByName(deps.entities(), entity, l.project);
    if (!def || !documentTypes(l.project).includes(def)) return undefined;
    const row = await entityStore.get(deps.pool, def, id);
    if (!row || !FILED_STATES.has(row.lifecycle ?? '')) return undefined;
    return { def, row };
  }

  async function documentView(def: EntityTypeDef, row: StoredEntityRow): Promise<InspectorDocument> {
    const entities = deps.entities();
    const values: InspectorDocument['values'] = [];
    let file: InspectorDocument['file'];
    let site: InspectorDocument['site'];
    for (const [name, f] of Object.entries(def.fields)) {
      const v = row.values[name];
      if (f.type.kind === 'scalar' && (f.type.name === 'Document' || f.type.name === 'File')) {
        if (!file && v && typeof v === 'object') {
          const d = v as { id: string; name: string; mime: string; size: number; sha256: string };
          file = { id: d.id, name: d.name, mime: d.mime, size: d.size, sha256: d.sha256 };
        }
        continue;
      }
      if (v === null || v === undefined || v === '') continue;
      let shown = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const target = f.type.kind === 'ref' ? refEntity(entities, def, name) : undefined;
      if (target && typeof v === 'string') {
        const t = await entityStore.get(deps.pool, target, v).catch(() => undefined);
        if (t) shown = recordTitle(target, v, t.values);
        if (target.entity === 'Site') site = { id: v, label: shown };
      }
      values.push({ field: name, label: humanize(name), value: shown });
    }
    const { rows } = await deps.pool.query<{ at: Date }>(
      `select min(at) as at from mw.record_versions where entity = $1 and record_id = $2 and "values" ->> 'status' = 'filed'`, [keyOf(def), row.id]);
    const sigs = await signatureViews(deps.pool, def, row.id, row.values);
    const artifact = typeof row.values.artifact === 'string' ? row.values.artifact : undefined;
    const zone = zoneOfArtifact(artifact);
    return {
      entity: keyOf(def), id: row.id, title: recordTitle(def, row.id, row.values), status: row.lifecycle ?? '', version: row.version,
      ...(zone ? { zone } : {}), ...(site ? { site } : {}), ...(artifact ? { artifact } : {}),
      ...(rows[0]?.at ? { filedAt: rows[0].at.toISOString() } : {}),
      signatures: sigs.map((s) => ({ name: s.name, meaning: s.meaning, at: s.at, changedSince: s.changedSince })),
      ...(file ? { file } : {}), values,
    };
  }

  async function filedDocuments(l: InspectorLinkRow): Promise<InspectorDocument[]> {
    const out: InspectorDocument[] = [];
    for (const def of documentTypes(l.project)) {
      const rows = await entityStore.list(deps.pool, def, { limit: 100_000, unrestricted: true });
      for (const row of rows) if (FILED_STATES.has(row.lifecycle ?? '')) out.push(await documentView(def, row));
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  const owners = (project: string) => deps.project()?.domains?.[project]?.owner;

  const service = {
    async create(input: { project: string; name: string; inspectors: import('@memwise/db').InspectorPerson[]; expiresAt: string }, by: PersonActor) {
      const domain = deps.project()?.domains?.[input.project];
      if (!domain) throw new Error(`there is no project ${input.project}`);
      if (!domain.regulated) throw new Error(`${domain.name ?? input.project} is not regulated: inspector access is for regulated projects`);
      const owner = domain.owner;
      if (owner && !holdsRole(by, owner, input.project)) throw new Error(`only the ${deps.project()?.roles[owner]?.title ?? owner} gives inspectors access`);
      const expires = new Date(input.expiresAt);
      if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new Error('the access must end in the future');
      if (expires.getTime() - Date.now() > MAX_INSPECTOR_DAYS * 86_400_000) throw new Error(`inspector access can last at most ${MAX_INSPECTOR_DAYS} days`);
      const inspectors = input.inspectors.map((i) => ({ name: i.name.trim(), ...(i.email?.trim() ? { email: i.email.trim() } : {}), ...(i.organisation?.trim() ? { organisation: i.organisation.trim() } : {}) })).filter((i) => i.name);
      if (!inspectors.length) throw new Error('name at least one inspector');
      const token = INSPECTOR_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
      const row = await store.create(deps.pool, {
        project: input.project, name: input.name.trim() || 'Inspection', inspectors, expiresAt: expires.toISOString(), createdBy: by.personId, tokenHash: inspectorTokenHash(token),
      });
      await deps.auditLog().append({
        project: input.project, actorKind: 'person', actor: by.personId, actorLabel: await nameOf(by.personId), action: 'inspector.link_created',
        data: { link: row.id, name: row.name, inspectors: inspectors.map((i) => i.name), expiresAt: row.expiresAt },
      });
      const base = deps.publicUrl?.()?.replace(/\/+$/, '');
      return { link: await linkView(row), token, ...(base ? { url: `${base}/v/${token}` } : {}) };
    },

    async list(project: string, actor: Actor) {
      void actor;
      return Promise.all((await store.list(deps.pool, project)).map(linkView));
    },

    async revoke(id: string, by: PersonActor) {
      const l = await store.get(deps.pool, id);
      if (!l) throw new Error(`there is no inspector link ${id}`);
      const owner = owners(l.project);
      if (owner && !holdsRole(by, owner, l.project) && by.personId !== l.createdBy) throw new Error('only the project owner ends inspector access');
      const r = (await store.revoke(deps.pool, id, by.personId))!;
      await deps.auditLog().append({ project: l.project, actorKind: 'person', actor: by.personId, actorLabel: await nameOf(by.personId), action: 'inspector.link_revoked', data: { link: l.id, name: l.name } });
      deps.emit({ kind: 'regulated', project: l.project });
      return linkView(r);
    },

    async extend(id: string, expiresAt: string, by: PersonActor) {
      const l = await store.get(deps.pool, id);
      if (!l) throw new Error(`there is no inspector link ${id}`);
      const owner = owners(l.project);
      if (owner && !holdsRole(by, owner, l.project)) throw new Error('only the project owner changes inspector access');
      const at = new Date(expiresAt);
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) throw new Error('the access must end in the future');
      if (at.getTime() - Date.now() > MAX_INSPECTOR_DAYS * 86_400_000) throw new Error(`inspector access can last at most ${MAX_INSPECTOR_DAYS} days`);
      const r = await store.extend(deps.pool, id, at.toISOString());
      if (!r) throw new Error('this access was ended; give a new link instead');
      await deps.auditLog().append({ project: l.project, actorKind: 'person', actor: by.personId, actorLabel: await nameOf(by.personId), action: 'inspector.link_extended', data: { link: l.id, expiresAt: r.expiresAt } });
      return linkView(r);
    },

    async questions(filter: { project?: string; linkId?: string; open?: boolean }, actor: Actor) {
      void actor;
      return Promise.all((await store.questions(deps.pool, filter)).map((q) => questionView(q)));
    },

    async answer(questionId: string, answer: string, by: PersonActor) {
      const q = await store.question(deps.pool, questionId);
      if (!q) throw new Error(`there is no question ${questionId}`);
      if (!answer.trim()) throw new Error('write the answer first');
      const r = await store.answer(deps.pool, questionId, answer.trim(), by.personId);
      if (!r) throw new Error('this question was answered already');
      await deps.auditLog().append({
        project: q.project, actorKind: 'person', actor: by.personId, actorLabel: await nameOf(by.personId), action: 'inspector.answered',
        ...(q.entity ? { entity: q.entity } : {}), ...(q.recordId ? { recordId: q.recordId } : {}), data: { question: q.id, link: q.linkId },
      });
      return questionView(r);
    },

    // ---------------------------------------------------------------- the inspector's side

    async open(token: string, req?: PublicRequestInfo): Promise<InspectorIndex | InspectorRefusal> {
      const l = await linkFor(token);
      if (refused(l)) return l;
      await store.touch(deps.pool, l.id);
      await logged(l, 'inspector.opened', {}, { ...(req?.ip ? { ip: req.ip } : {}), ...(req?.userAgent ? { userAgent: req.userAgent.slice(0, 200) } : {}) });
      const docs = await filedDocuments(l);
      const sites = new Map<string, string>();
      for (const d of docs) if (d.site) sites.set(d.site.id, d.site.label);
      const domain = deps.project()?.domains?.[l.project];
      return {
        session: { linkId: l.id, project: l.project, projectName: domain?.name ?? l.project, name: l.name, inspector: who(l), expiresAt: l.expiresAt },
        zones: TMF_ZONES.map((z) => ({ id: z.id, number: z.number, name: z.name, filed: docs.filter((d) => d.zone === z.number).length })),
        sites: [...sites].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
      };
    },

    async documents(token: string, filter: { zone?: string; site?: string; q?: string }) {
      const l = await linkFor(token);
      if (refused(l)) return l;
      const all = await filedDocuments(l);
      const zone = TMF_ZONES.find((z) => z.number === filter.zone || z.id === filter.zone)?.number;
      const atSite = all.filter((d) => !filter.site || d.site?.id === filter.site);
      const q = filter.q?.trim().toLowerCase();
      const shown = atSite.filter((d) => (!zone || d.zone === zone) && (!q || `${d.title} ${d.artifact ?? ''} ${d.site?.label ?? ''}`.toLowerCase().includes(q)));
      await logged(l, 'inspector.listed', {}, { ...(zone ? { zone } : {}), ...(filter.site ? { site: filter.site } : {}), ...(q ? { q } : {}), shown: shown.length });
      return { documents: shown, total: atSite.length };
    },

    async document(token: string, entity: string, id: string) {
      const l = await linkFor(token);
      if (refused(l)) return l;
      const found = await filedDocument(l, entity, id);
      if (!found) return undefined;
      await logged(l, 'inspector.viewed', { entity: keyOf(found.def), recordId: id }, { version: found.row.version });
      return documentView(found.def, found.row);
    },

    async trail(token: string, entity: string, id: string) {
      const l = await linkFor(token);
      if (refused(l)) return l;
      const found = await filedDocument(l, entity, id);
      if (!found) return undefined;
      await logged(l, 'inspector.viewed', { entity: keyOf(found.def), recordId: id }, { view: 'trail' });
      const key = keyOf(found.def);
      const { entries, chain } = await deps.auditLog().list({ project: l.project, entity: key, recordId: id, limit: 2000 }, { kind: 'system' });
      return { entries: entries.filter((e: AuditEntryView) => inspectorSees(e, key, id)).map(withoutAiProse), chain: { ok: chain.ok } };
    },

    async download(token: string, entity: string, id: string) {
      const l = await linkFor(token);
      if (refused(l)) return l;
      const found = await filedDocument(l, entity, id);
      if (!found || !deps.files) return undefined;
      const doc = await documentView(found.def, found.row);
      if (!doc.file) return undefined;
      const file = await deps.files.read(deps.pool, doc.file.id);
      if (!file) return undefined;
      await logged(l, 'inspector.downloaded', { entity: keyOf(found.def), recordId: id }, { file: doc.file.name, sha256: doc.file.sha256, version: found.row.version });
      return { name: file.meta.name, mime: file.meta.mime, data: file.data };
    },

    async ask(token: string, input: { question: string; entity?: string; recordId?: string }) {
      const l = await linkFor(token);
      if (refused(l)) return l;
      const question = input.question.trim().slice(0, 4000);
      if (!question) throw new Error('write the question first');
      let entity: string | undefined;
      if (input.entity && input.recordId) {
        const found = await filedDocument(l, input.entity, input.recordId);
        if (found) entity = keyOf(found.def);
      }
      const q = await store.ask(deps.pool, { linkId: l.id, project: l.project, question, askedBy: who(l), ...(entity ? { entity, recordId: input.recordId! } : {}) });
      await logged(l, 'inspector.asked', { ...(entity ? { entity, recordId: input.recordId! } : {}) }, { question: q.id });
      return questionView(q, l);
    },

    async requests(token: string) {
      const l = await linkFor(token);
      if (refused(l)) return l;
      return Promise.all((await store.questions(deps.pool, { linkId: l.id })).map((q) => questionView(q, l)));
    },

    /** Open questions, for the owners of their projects (domains). */
    async inboxItems(actor: Actor): Promise<InboxItem[]> {
      if (actor.kind !== 'person') return [];
      const open = await store.questions(deps.pool, { open: true });
      const mine = open.filter((q) => {
        const owner = owners(q.project);
        return owner ? holdsRole(actor, owner, q.project) : true;
      });
      return Promise.all(mine.map(async (q) => ({ kind: 'inspector-question' as const, id: `inspector-question:${q.id}`, question: await questionView(q), since: q.askedAt })));
    },
  };
  return service;
}
