/**
 * The projects service (26 §3, D92, D93): projects inside apps. The files say what a project is
 * (`projects/<id>/project.yaml`, its overrides); `mw.projects` keeps what happened to it (draft,
 * started, archived, a template update skipped). Every change goes through the files and then
 * `index()`, so `memwise check`, git and the app always agree.
 */
import { PgEntityStore, PgProjectStore, projectScoped, withActor, type ProjectRow } from '@memwise/db';
import {
  createProjectFiles, hasRole, projectIdFor, publishAppVersion, resolveEntity, rolesIn, saveAsTemplate as saveFilesAsTemplate,
  seesProject, takeTemplateUpdate, templateUpdate, updateProjectFile, type AppDef, type Diagnostic, type EntityTypeDef,
  type ExampleCase, type MwProjectDef, type ProjectDefs, type TemplateChange,
} from '@memwise/defs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Actor, InboxItem, KernelChange, StartRunInput, TestRunner } from '../types.ts';
import { seedProjectRecords, type SeedDeps } from './seed.ts';
import type {
  MwAppHome, MwAppSummary, MwCreateProjectInput, MwProjectDetail, MwProjectPatch, MwProjectSummary, MwTemplateTestRun,
  MwTemplateUpdateChange, MwTemplateUpdateItem, MwTemplateUpdateReview, MwWaitingGroup, ProjectsService,
} from './types.ts';

/** The workspace playbook that makes a project from a conversation ("Describe it in chat"). */
export const CREATE_PROJECT_PLAYBOOK = 'create-project';

export interface ProjectsDeps {
  pool: pg.Pool;
  /** The workspace folder; without one the service only reads. */
  root?: string;
  /** The definitions as last indexed. */
  project(): Promise<ProjectDefs | undefined>;
  index(): Promise<Diagnostic[]>;
  inbox(actor: Actor): Promise<InboxItem[]>;
  startRun(input: StartRunInput): Promise<{ runId: string; caseId: string }>;
  personByEmail(email: string): Promise<{ id: string } | undefined>;
  /** A person's actor as of now (grants change when project.yaml people change). */
  actorFor(personId: string): Promise<Actor>;
  testRunner?: TestRunner;
  caseToExample(caseId: string, opts?: { name?: string }): Promise<ExampleCase>;
  entities(): Record<string, EntityTypeDef>;
  emit(change: KernelChange): void;
  createRecord: SeedDeps['create'];
  saveFile: SeedDeps['saveFile'];
}

const store = new PgProjectStore();
const entityStore = new PgEntityStore();
const DEFAULT_NOUNS = { one: 'project', many: 'projects' };

const isPerson = (a: Actor): a is Extract<Actor, { kind: 'person' }> => a.kind === 'person';

export function createProjectsService(deps: ProjectsDeps): ProjectsService {
  async function defs(): Promise<ProjectDefs> {
    const d = await deps.project();
    if (!d) throw new Error('projects need a kernel with a workspace folder');
    return d;
  }
  const root = (): string => {
    if (!deps.root) throw new Error('changing projects needs a kernel with a workspace folder');
    return deps.root;
  };

  // ---------------------------------------------------------------- who sees and changes what

  /** A person sees the projects their grants reach (D92); anyone else every project. */
  const sees = (actor: Actor, p: Pick<MwProjectDef, 'app' | 'id'>) => !isPerson(actor) || seesProject(actor, p.app, p.id);

  /**
   * Who changes an app's projects: its owner role (held in that project, when one is named), or
   * when the app names none, anyone with a role there. A workspace without roles lets anyone.
   */
  function mayManage(d: ProjectDefs, actor: Actor, app: string, project?: string): boolean {
    if (!isPerson(actor)) return actor.kind === 'system';
    if (!Object.keys(d.roles ?? {}).length) return true;
    const owner = d.domains?.[app]?.owner;
    return owner ? hasRole(actor, owner, app, project) : rolesIn(actor, app, project).length > 0;
  }
  function mustManage(d: ProjectDefs, actor: Actor, app: string, project?: string) {
    if (mayManage(d, actor, app, project)) return;
    const owner = d.domains?.[app]?.owner;
    throw new Error(`only ${owner ? `the ${d.roles?.[owner]?.title ?? owner}` : 'someone with a role'} in ${d.apps?.[app]?.title ?? app} can do that`);
  }

  function projectOf(d: ProjectDefs, id: string): MwProjectDef {
    const p = d.projects?.[id];
    if (!p) throw new Error(`there is no project ${id}`);
    return p;
  }
  const appOf = (d: ProjectDefs, id: string): AppDef => {
    const a = d.apps?.[id];
    if (!a) throw new Error(`there is no app ${id}`);
    return a;
  };

  async function rows(): Promise<Map<string, ProjectRow>> {
    return new Map((await store.list(deps.pool)).map((r) => [r.id, r]));
  }

  /** The update a project has waiting: the app is ahead, the project isn't archived, and that version wasn't skipped. */
  function pendingUpdate(app: AppDef, p: MwProjectDef, row?: ProjectRow): { to: number } | undefined {
    if (p.implicit || p.version >= app.version) return undefined;
    if ((row?.status ?? p.status) === 'archived') return undefined;
    if (row?.skippedVersion !== undefined && row.skippedVersion >= app.version) return undefined;
    return { to: app.version };
  }

  async function waitingByProject(actor: Actor): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!isPerson(actor)) return out;
    for (const item of await deps.inbox(actor)) {
      if (item.project) out.set(item.project, (out.get(item.project) ?? 0) + 1);
    }
    return out;
  }

  function summaryOf(d: ProjectDefs, p: MwProjectDef, row: ProjectRow | undefined, waiting: Map<string, number>, updates: Set<string>): MwProjectSummary {
    const app = appOf(d, p.app);
    const update = updates.has(p.id) ? pendingUpdate(app, p, row) : undefined;
    return {
      id: p.id, app: p.app, appTitle: app.title, name: row?.name ?? p.name, status: row?.status ?? p.status,
      ...(p.study ? { study: p.study } : {}), templateVersion: p.version, appVersion: app.version,
      ...(p.from ? { from: p.from } : {}), ...(p.implicit ? { implicit: true } : {}),
      ...(update ? { update } : {}),
      waiting: (waiting.get(p.id) ?? 0) + (update ? 1 : 0),
      ...(row ? { createdAt: row.createdAt, updatedAt: row.updatedAt } : {}),
    };
  }

  async function summaries(actor: Actor, filter: { app?: string } = {}): Promise<MwProjectSummary[]> {
    const d = await defs();
    const [r, waiting] = await Promise.all([rows(), waitingByProject(actor)]);
    const out: MwProjectSummary[] = [];
    for (const p of Object.values(d.projects ?? {})) {
      if (filter.app && p.app !== filter.app) continue;
      if (!sees(actor, p)) continue;
      // An update is offered to who can take it.
      const updates = new Set(mayManage(d, actor, p.app, p.id) ? [p.id] : []);
      out.push(summaryOf(d, p, r.get(p.id), waiting, updates));
    }
    // Running first, then drafts, then archived; by name within each.
    const rank = { active: 0, draft: 1, archived: 2 } as const;
    return out.sort((a, b) => a.app.localeCompare(b.app) || rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  }

  async function detail(id: string, actor: Actor): Promise<MwProjectDetail | undefined> {
    const d = await defs();
    const p = d.projects?.[id];
    if (!p || !sees(actor, p)) return undefined;
    const app = appOf(d, p.app);
    const [r, waiting] = await Promise.all([store.get(deps.pool, id), waitingByProject(actor)]);
    const canEdit = mayManage(d, actor, p.app, p.id);
    const base = summaryOf(d, p, r, waiting, new Set(canEdit ? [p.id] : []));
    const people = [];
    for (const person of p.people) {
      const found = await deps.personByEmail(person.email);
      people.push({ ...person, ...(found ? { personId: found.id } : {}) });
    }
    const bound = new Set(Object.keys(d.bindings ?? {}));
    const card = p.template ? app.templates.find((t) => t.id === p.template) : undefined;
    const workflowTitle = (wf: string): string => p.workflows[wf]?.title ?? d.workflows[wf]?.title ?? wf;
    return {
      ...base,
      people,
      connections: p.connections.map((c) => ({
        ...c,
        // A project's own binding (projects/<id>/bindings/) is not there yet: the app's serves every project.
        bound: c.plugin && bound.has(c.plugin) ? 'app' : 'none',
      })),
      settings: r?.settings && Object.keys(r.settings).length ? r.settings : p.settings ?? {},
      without: p.without,
      ...(card ? { templateTitle: card.title } : {}),
      overrides: p.overrides.map((path) => {
        const wf = /^workflows\/([^/]+)\//.exec(path)?.[1];
        return { path, ...(wf ? { workflow: wf } : {}), title: wf ? workflowTitle(wf) : path };
      }),
      playbooks: Object.values(p.workflows).map((w) => ({ id: w.id, title: w.title ?? w.id, version: w.version, overridden: !!w.overridden?.length }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      canEdit,
    };
  }

  /** After a change: the person's grants as they are now (making a project adds them to it). */
  async function must(id: string, actor: Actor): Promise<MwProjectDetail> {
    const p = await detail(id, isPerson(actor) ? await deps.actorFor(actor.personId) : actor);
    if (!p) throw new Error(`there is no project ${id}`);
    return p;
  }

  async function reindex() {
    const diagnostics = await deps.index();
    const errors = diagnostics.filter((x) => x.severity === 'error' && x.file?.startsWith('projects/'));
    if (errors.length) throw new Error(`the project files don't check: ${errors.map((e) => `${e.file}: ${e.message}`).join('; ')}`);
  }

  // ---------------------------------------------------------------- template updates

  async function itemsFor(actor: Actor | undefined, appFilter?: string): Promise<MwTemplateUpdateItem[]> {
    const d = await defs();
    const r = await rows();
    const out: MwTemplateUpdateItem[] = [];
    for (const p of Object.values(d.projects ?? {})) {
      if (appFilter && p.app !== appFilter) continue;
      const app = d.apps?.[p.app];
      if (!app) continue;
      const update = pendingUpdate(app, p, r.get(p.id));
      if (!update) continue;
      if (actor && (!sees(actor, p) || !mayManage(d, actor, p.app, p.id))) continue;
      const since = await deps.pool.query<{ at: Date | null }>(
        `select min(indexed_at) as at from mw.definitions where kind = 'app' and id = $1 and version = $2`, [app.id, app.version]);
      out.push({
        kind: 'template-update', id: `template-update:${p.id}:${update.to}`, project: p.id, projectName: r.get(p.id)?.name ?? p.name,
        app: app.id, appTitle: app.title, from: p.version, to: update.to, title: `Review template update: ${app.title} v${update.to}`,
        since: (since.rows[0]?.at ?? new Date()).toISOString(),
      });
    }
    return out;
  }

  function noteOf(c: TemplateChange): string {
    switch (c.project) {
      case 'overridden-same': return 'This project already does that, so nothing changes here.';
      case 'overridden-differs': return 'This project changed this itself, so it keeps its own; the new template version is not taken here.';
      case 'left-out': return 'This project leaves this out, so nothing changes here.';
      case 'takes':
        return c.kind === 'added' ? 'New here: it comes with the update.' : c.kind === 'removed' ? 'Taken out of this project with the update.' : 'Changes here with the update.';
    }
  }

  async function testRun(p: MwProjectDef, workflowId: string): Promise<MwTemplateTestRun> {
    const runner = deps.testRunner;
    if (!runner) return { workflowId, status: 'skip', differences: ['no test runner'], examples: { passed: 0, total: 0 } };
    // A past case of this project, finished ones first: replayed on the new template it shows
    // whether the case would still go the same way.
    const { rows: past } = await deps.pool.query<{ case_id: string; values: Record<string, { value: unknown }> }>(
      `select r.case_id, c.values from mw.runs r join mw.cases c on c.id = r.case_id
        where r.project = $1 and r.workflow_id = $2 order by (r.status = 'done') desc, r.updated_at desc limit 1`, [p.id, workflowId]);
    let example: ExampleCase | undefined;
    let title: string | undefined;
    if (past[0]) {
      example = await deps.caseToExample(past[0].case_id, { name: `past-${past[0].case_id.replace(/^case_/, '').slice(-8).toLowerCase()}` }).catch(() => undefined);
      title = Object.values(past[0].values ?? {}).map((v) => v?.value).find((v): v is string => typeof v === 'string');
    }
    const outcomes = await runner({ projectDir: root(), workflowId, ...(example ? { extraExamples: [example] } : {}) });
    const replay = example ? outcomes.find((o) => o.name === example!.name) : undefined;
    const own = outcomes.filter((o) => o !== replay);
    const examples = { passed: own.filter((o) => o.status === 'pass').length, total: own.length };
    const base = { workflowId, ...(past[0] && example ? { caseId: past[0].case_id } : {}), ...(title ? { title } : {}), examples };
    if (!replay) {
      const failing = own.filter((o) => o.status === 'fail');
      return { ...base, status: failing.length ? 'different' : own.length ? 'same' : 'skip', differences: failing.flatMap((o) => o.differences.length ? o.differences : [o.reason ?? o.name]) };
    }
    if (replay.status === 'pass') return { ...base, status: 'same', differences: [] };
    if (replay.status === 'skip') return { ...base, status: 'skip', differences: replay.reason ? [replay.reason] : [] };
    return { ...base, status: !replay.differences.length && replay.reason ? 'error' : 'different', differences: replay.differences.length ? replay.differences : [replay.reason ?? 'failed'] };
  }

  // ---------------------------------------------------------------- the app home

  async function home(appId: string, actor: Actor): Promise<MwAppHome> {
    const d = await defs();
    const app = appOf(d, appId);
    const entities = deps.entities();
    const r = await rows();
    const waiting = await waitingByProject(actor);
    const projects = Object.values(d.projects ?? {}).filter((p) => p.app === appId && sees(actor, p));
    const statusOf = (p: MwProjectDef) => r.get(p.id)?.status ?? p.status;
    const settingsOf = (p: MwProjectDef) => { const s = r.get(p.id)?.settings; return s && Object.keys(s).length ? s : p.settings ?? {}; };
    const columns = app.home?.columns ?? [];
    const defOf = (name: string) => resolveEntity(entities, appId, name);

    const aggregate = async (value: Extract<(typeof columns)[number], { value: unknown }>['value'], ids: string[]) => {
      const v = value as Record<string, string | undefined>;
      const kind = (['count', 'percent', 'sum', 'avg'] as const).find((k) => k in v)!;
      const def = defOf(v[kind]!);
      if (!def) return null;
      return withActor(deps.pool, actor, (db) => entityStore.aggregate(db, def, entities, {
        kind, ...(v.field ? { field: v.field } : {}), ...(v.where ? { where: v.where } : {}), ...(v.of ? { of: v.of } : {}),
        ...(projectScoped(def) ? { projects: ids } : {}),
      }));
    };

    const nextOf = (p: MwProjectDef): { label: string; date?: string } | undefined => {
      if (!app.home?.next) return undefined;
      const n = settingsOf(p)[app.home.next];
      if (typeof n === 'string') return { label: n };
      if (n && typeof n === 'object' && typeof (n as { label?: unknown }).label === 'string') {
        const date = (n as { date?: unknown }).date;
        return { label: (n as { label: string }).label, ...(typeof date === 'string' ? { date } : date instanceof Date ? { date: date.toISOString().slice(0, 10) } : {}) };
      }
      return undefined;
    };

    const rank = { active: 0, draft: 1, archived: 2 } as const;
    const ordered = [...projects].sort((a, b) => rank[statusOf(a)] - rank[statusOf(b)] || (r.get(a.id)?.name ?? a.name).localeCompare(r.get(b.id)?.name ?? b.name));
    const out: MwAppHome['rows'] = [];
    for (const p of ordered) {
      const status = statusOf(p);
      const values: (number | string | null)[] = [];
      for (const c of columns) {
        if ('setting' in c) {
          const v = settingsOf(p)[c.setting];
          values.push(typeof v === 'number' || typeof v === 'string' ? v : null);
        } else {
          // A draft has no records yet: nothing to count.
          values.push(status === 'draft' ? null : await aggregate(c.value, [p.id]));
        }
      }
      const next = nextOf(p);
      out.push({
        project: p.id, name: r.get(p.id)?.name ?? p.name, ...(p.study ? { study: p.study } : {}), status, values,
        ...(next ? { next } : {}), waiting: waiting.get(p.id) ?? 0,
      });
    }

    const active = projects.filter((p) => statusOf(p) === 'active');
    const percent = columns.find((c): c is Extract<typeof c, { value: unknown }> => 'value' in c && 'percent' in (c.value as object));
    const headline = percent ? { label: percent.label, value: active.length ? await aggregate(percent.value, active.map((p) => p.id)) : null } : undefined;
    const milestones = active.flatMap((p) => {
      const n = nextOf(p);
      return n ? [{ project: p.id, name: r.get(p.id)?.name ?? p.name, label: n.label, ...(n.date ? { date: n.date } : {}) }] : [];
    }).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));

    return {
      app: app.id, title: app.home?.title ?? app.title, ...(app.home?.link ? { link: app.home.link } : {}), nouns: app.nouns ?? DEFAULT_NOUNS,
      columns: columns.map((c) => ({ label: c.label, ...('format' in c && c.format ? { format: c.format } : {}) })),
      rows: out,
      totals: {
        projects: projects.length, active: active.length,
        draft: projects.filter((p) => statusOf(p) === 'draft').length, archived: projects.filter((p) => statusOf(p) === 'archived').length,
      },
      ...(headline ? { headline } : {}),
      milestones,
      bottlenecks: await bottlenecks(d, projects.filter((p) => statusOf(p) === 'active'), r),
    };
  }

  /** Person steps waiting in these projects, by the project's people who hold the step's role there. */
  async function bottlenecks(d: ProjectDefs, projects: MwProjectDef[], r: Map<string, ProjectRow>): Promise<MwAppHome['bottlenecks']> {
    if (!projects.length) return [];
    const { rows: waiting } = await deps.pool.query<{ project: string; assignee: string | null; n: number }>(
      `select s.project, s.assignee, count(*)::int as n from mw.step_runs s
        where s.status = 'waiting' and s.performer = 'person' and s.project = any($1::text[]) group by s.project, s.assignee`,
      [projects.map((p) => p.id)]);
    const byPerson = new Map<string, MwAppHome['bottlenecks'][number]>();
    for (const p of projects) {
      for (const person of p.people) {
        const count = waiting.filter((w) => w.project === p.id && w.assignee && person.roles.includes(w.assignee)).reduce((a, w) => a + w.n, 0);
        if (!count) continue;
        const entry = byPerson.get(person.email) ?? { name: person.name ?? person.email, roles: [], waiting: [], total: 0 };
        const found = await deps.personByEmail(person.email);
        if (found) entry.personId = found.id;
        entry.roles = [...new Set([...entry.roles, ...person.roles.map((role) => d.roles?.[role]?.title ?? role)])];
        entry.waiting.push({ project: p.id, projectName: r.get(p.id)?.name ?? p.name, count });
        entry.total += count;
        byPerson.set(person.email, entry);
      }
    }
    for (const b of byPerson.values()) b.waiting.sort((x, y) => y.count - x.count || x.projectName.localeCompare(y.projectName));
    return [...byPerson.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- the service

  const changed = (projectId?: string) => deps.emit({ kind: 'projects', ...(projectId ? { projectId } : {}) });

  const service: ProjectsService = {
    async apps(actor) {
      const d = await defs();
      const projects = await summaries(actor);
      return Object.values(d.apps ?? {}).map((app): MwAppSummary => ({
        id: app.id, title: app.title, ...(app.description ? { description: app.description } : {}), version: app.version,
        nouns: app.nouns ?? DEFAULT_NOUNS, ...(app.home ? { home: { title: app.home.title, ...(app.home.link ? { link: app.home.link } : {}) } } : {}),
        templates: app.templates, projects: projects.filter((p) => p.app === app.id), canCreate: mayManage(d, actor, app.id),
      })).filter((a) => a.projects.length || a.canCreate);
    },

    list: (actor, filter) => summaries(actor, filter),
    get: (id, actor) => detail(id, actor),

    async create(input, actor) {
      const d = await defs();
      const source = input.copyFrom ? projectOf(d, input.copyFrom) : undefined;
      if (source && !sees(actor, source)) throw new Error(`there is no project ${input.copyFrom}`);
      const appId = source?.app ?? input.app;
      if (!appId) throw new Error('name the app, or a project to copy');
      appOf(d, appId);
      mustManage(d, actor, appId);
      if (!input.name?.trim()) throw new Error('a project needs a name');
      const taken = [...Object.keys(d.projects ?? {}), ...Object.keys(d.domains ?? {})];
      const id = input.id ?? projectIdFor(input.name, taken);
      // Whoever makes it is in it: a person creating a study holds the owner role there.
      const people = input.people ?? (source ? undefined : await creatorAsPerson(d, actor, appId));
      await createProjectFiles(d, {
        id, name: input.name.trim(), app: appId, status: 'draft',
        ...(input.template ? { template: input.template } : {}), ...(input.copyFrom ? { copyFrom: input.copyFrom } : {}),
        ...(input.study ? { study: input.study } : {}), ...(people ? { people } : {}),
        ...(input.without ? { without: input.without } : {}), ...(input.settings ? { settings: input.settings } : {}),
      });
      await reindex();
      if (isPerson(actor)) await deps.pool.query('update mw.projects set created_by = $2 where id = $1 and created_by is null', [id, actor.personId]);
      changed(id);
      return must(id, actor);
    },

    async update(id, patch, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      const fields: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw new Error('a project needs a name');
        fields.name = patch.name.trim();
      }
      if (patch.study !== undefined) fields.study = patch.study?.trim() || undefined;
      if (patch.people) {
        fields.people = patch.people.map((x) => ({ email: x.email.trim().toLowerCase(), ...(x.name ? { name: x.name } : {}), roles: x.roles, ...(x.note ? { note: x.note } : {}) }));
      }
      if (patch.connections) fields.connections = Object.fromEntries(patch.connections.map(({ id: cid, ...c }) => [cid, c]));
      if (patch.settings) fields.settings = patch.settings;
      await updateProjectFile(d, id, fields);
      await reindex();
      changed(id);
      return must(id, actor);
    },

    async start(id, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      if (!p.implicit) await updateProjectFile(d, id, { status: undefined });
      await store.setStatus(deps.pool, id, 'active');
      await reindex();
      changed(id);
      return must(id, actor);
    },

    async archive(id, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      if (p.implicit) throw new Error(`${p.name} is its app's own project; it can't be archived`);
      await updateProjectFile(d, id, { status: 'archived' });
      await store.setStatus(deps.pool, id, 'archived');
      await reindex();
      changed(id);
      return must(id, actor);
    },

    async discard(id, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      const row = await store.get(deps.pool, id);
      if ((row?.status ?? p.status) !== 'draft' || p.implicit) throw new Error(`only a draft can be discarded; ${p.name} has started`);
      await rm(join(root(), p.dir!), { recursive: true, force: true });
      await store.discardDraft(deps.pool, id);
      await reindex();
      changed(id);
    },

    templateUpdates: (actor) => itemsFor(actor),

    async reviewUpdate(id, actor, opts = {}) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) return undefined;
      const item = (await itemsFor(undefined)).find((i) => i.project === id);
      const update = await templateUpdate(d, id);
      if (!item || !update) return undefined;
      const title = (c: TemplateChange) => (c.workflow ? d.workflows[c.workflow]?.title ?? p.workflows[c.workflow]?.title ?? c.workflow : c.path);
      const changes: MwTemplateUpdateChange[] = update.changes.map((c) => ({ ...c, title: title(c), note: noteOf(c) }));
      const taken = changes.filter((c) => c.project === 'takes');
      const nothingChanges = !taken.length;
      const kept = changes.length - taken.length;
      const summary = nothingChanges
        ? `${p.name} already does what ${item.appTitle} v${item.to} brings, so nothing changes here.`
        : `${taken.length} ${taken.length === 1 ? 'change comes' : 'changes come'} to ${p.name} with ${item.appTitle} v${item.to}${kept ? `; ${kept} it already has or leaves out` : ''}.`;
      const test = opts.test && update.workflowsChanged[0] ? await testRun(p, update.workflowsChanged[0]) : undefined;
      return { item, changes, nothingChanges, summary, ...(test ? { test } : {}) };
    },

    async takeUpdate(id, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      const r = await takeTemplateUpdate(d, id);
      await store.skipVersion(deps.pool, id, null);
      await reindex();
      changed(id);
      deps.emit({ kind: 'inbox' });
      return r;
    },

    async skipUpdate(id, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      await store.skipVersion(deps.pool, id, appOf(d, p.app).version);
      changed(id);
      deps.emit({ kind: 'inbox' });
    },

    async publishTemplate(appId, files, actor) {
      const d = await defs();
      appOf(d, appId);
      mustManage(d, actor, appId);
      const version = await publishAppVersion(d, appId, files);
      await reindex();
      changed();
      deps.emit({ kind: 'inbox' });
      return { version, updates: await itemsFor(undefined, appId) };
    },

    async saveAsTemplate(id, opts, actor) {
      const d = await defs();
      const p = projectOf(d, id);
      if (!sees(actor, p)) throw new Error(`there is no project ${id}`);
      mustManage(d, actor, p.app, p.id);
      const r = await saveFilesAsTemplate(d, id, opts);
      await reindex();
      changed(id);
      deps.emit({ kind: 'inbox' });
      return r;
    },

    home,

    async waiting(actor) {
      const d = await defs();
      const [items, updates] = await Promise.all([deps.inbox(actor), itemsFor(actor)]);
      const r = await rows();
      const groups = new Map<string, MwWaitingGroup>();
      const group = (project: string | undefined): MwWaitingGroup => {
        const key = project ?? '';
        let g = groups.get(key);
        if (!g) {
          const p = project ? d.projects?.[project] : undefined;
          const appId = p?.app ?? (project && d.apps?.[project] ? project : '');
          g = {
            project: key, projectName: (project && (r.get(project)?.name ?? p?.name)) || '', app: appId,
            appTitle: appId ? d.apps?.[appId]?.title ?? appId : '', items: [], updates: [],
          };
          groups.set(key, g);
        }
        return g;
      };
      for (const item of items) group(item.project).items.push(item);
      for (const u of updates) group(u.project).updates.push(u);
      // By app, then project name; what belongs to no project last.
      return [...groups.values()].sort((a, b) => (!a.project ? 1 : 0) - (!b.project ? 1 : 0) || a.appTitle.localeCompare(b.appTitle) || a.projectName.localeCompare(b.projectName));
    },

    async describe(input, actor) {
      const d = await defs();
      appOf(d, input.app);
      mustManage(d, actor, input.app);
      if (!d.workflows[CREATE_PROJECT_PLAYBOOK]) throw new Error(`this workspace has no ${CREATE_PROJECT_PLAYBOOK} playbook: make the project from a template or a copy`);
      return deps.startRun({
        workflowId: CREATE_PROJECT_PLAYBOOK, case: { app: input.app, request: input.request },
        ...(isPerson(actor) ? { by: actor.personId } : {}),
      });
    },

    async seed(id, actor) {
      if (actor.kind !== 'system') throw new Error('only the kernel itself seeds a project');
      const d = await defs();
      const p = projectOf(d, id);
      const r = await seedProjectRecords({ pool: deps.pool, root: root(), entities: deps.entities, create: deps.createRecord, saveFile: deps.saveFile }, p);
      if (r.created) changed(id);
      return r;
    },
  };

  /** The person making a project, as its owner (the app's owner role), when the workspace knows them. */
  async function creatorAsPerson(d: ProjectDefs, actor: Actor, app: string) {
    if (!isPerson(actor)) return undefined;
    const owner = d.domains?.[app]?.owner;
    const { rows: found } = await deps.pool.query<{ email: string; name: string }>('select email, name from mw.people where id = $1', [actor.personId]);
    if (!found[0] || !owner) return undefined;
    return [{ email: found[0].email, name: found[0].name, roles: [owner], note: 'owner' }];
  }

  return service;
}
