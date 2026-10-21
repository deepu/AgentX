// kernel.pages (26 §4): pages built from a question. A page is a draft until someone keeps it;
// keeping gives it a refresh schedule, and the minute sweep starts "Refresh a page" when it is
// due. A refresh that changes the answer waits as a page change ("Review an answer change")
// until someone accepts it or sends it back. Pages nest; a parent that sums up its sub-pages is
// refreshed again when one of its kept sub-pages changes, and drafts never feed its summary.
// Chat writes pages through here too (`page_update`), acting as the person, each write a new
// version that says it came from the chat, with Undo.
import { PgPageChangeStore, PgPageStore, type PageChange, type PageChangeSummary, type Queryable, type WrittenPage } from '@memwise/db';
import { hasRole, type ProjectDefs } from '@memwise/defs';
import type pg from 'pg';
import { derivedRunId } from '../flow/context.ts';
import type {
  Actor, KernelChange, PageChangeRef, PageChangeView, PageChild, PageHistoryEntry, PageSummary, PagesService, PageView, PageWriteResult,
  RecordsService, StartRunInput, SubmitResult, SubmitStepInput,
} from '../types.ts';
import { blockJson, changedSections, compareBodies, headline, LIVE_BLOCKS, replaceFences, type PageBlockKind } from './blocks.ts';
import { nextRefresh, normalEvery } from './schedule.ts';

/** The built-in "Refresh a page" playbook, used when an app names none (`pages.refresh`). */
export const REFRESH_PAGE = 'refresh-page';
const WEEK_MS = 7 * 86_400_000;

export interface PagesDeps {
  pool: pg.Pool;
  project(): ProjectDefs | undefined;
  people: { get(id: string): Promise<{ name: string } | undefined> };
  records(): RecordsService;
  /** The kernel's startRun as the kernel itself (any case field may be set). */
  start(input: StartRunInput, opts?: { actsFor?: string }): Promise<{ runId: string; caseId: string }>;
  submitStep(input: SubmitStepInput): Promise<SubmitResult>;
  emit(change: KernelChange): void;
}

const pages = new PgPageStore();
const changes = new PgPageChangeStore();

const byOf = (actor: Actor): string => (actor.kind === 'person' ? actor.personId : actor.kind === 'step' ? `step:${actor.token.stepRunId}` : 'system');
const viaOf = (actor: Actor, via?: string): string => via ?? (actor.kind === 'person' ? `person:${actor.personId}` : actor.kind === 'step' ? `run:${actor.token.runId}` : 'system');
const iso = (d: Date) => d.toISOString();

/** The page as a summary: what the tree, Home and the waiting list show. */
function summaryOf(p: WrittenPage, extra: { pending?: PageChange; last?: PageChange } = {}): PageSummary {
  const last = extra.last;
  return {
    id: p.id, project: p.project, domain: p.domain, ...(p.parent ? { parent: p.parent } : {}), title: p.title, status: p.status,
    ...(p.question ? { question: p.question } : {}), headline: headline(p.body), ...(p.refresh ? { refresh: p.refresh } : {}),
    pinned: p.pinned, sumsChildren: p.sumsChildren, version: p.version, ...(p.owner ? { owner: p.owner } : {}),
    ...(p.createdBy ? { createdBy: p.createdBy } : {}), updatedAt: p.updatedAt,
    ...(extra.pending ? { pendingChange: { id: extra.pending.id, ...(extra.pending.summary.label ? { label: extra.pending.summary.label } : {}) } } : {}),
    ...(last ? { lastRefresh: { at: last.reviewedAt ?? last.at, status: last.status, ...(last.summary.title ? { title: last.summary.title } : {}) } } : {}),
  };
}

export interface PagesCore extends PagesService {
  /** Used by the page tools: the page as a refresh reads it. */
  forRefresh(id: string): Promise<Record<string, unknown>>;
  /** Used by `page.list`: a project's pages in a few words each. */
  forList(project: string, keptOnly: boolean): Promise<Record<string, unknown>[]>;
  /** The project a playbook's runs belong to (Stage 2: its domain). */
  projectOfWorkflow(workflowId: string): string;
  /** The compare step: a material change waits for review; otherwise one "nothing new" line. */
  compare(input: { page: string; body: string; title?: string; label?: string; changeTitle?: string; plus?: string;
    leftOut?: { title: string; href?: string; why: string }[]; reason?: string; by?: string; runId?: string; caseId?: string }): Promise<{ outcome: 'material' | 'nothing_new'; change?: string }>;
  /** Accepting (the review's answer, or a person with no run waiting): the new body becomes the page. */
  accept(changeId: string, by: string, opts?: { comment?: string; via?: string }): Promise<{ version: number }>;
  sendBack(changeId: string, by: string, comment?: string): Promise<void>;
  /** The person who answered this run's review step, and their comment. */
  reviewerOf(runId: string): Promise<{ by?: string; comment?: string }>;
  /** Whether this person reviews answer changes on the page (the waiting list shows them only theirs). */
  reviewable(pageId: string, actor: Actor): Promise<boolean>;
}

export function createPagesService(deps: PagesDeps): PagesCore {
  const { pool } = deps;
  const changed = (p: { project?: string; id?: string }, changeId?: string) =>
    deps.emit({ kind: 'pages', ...(p.project ? { project: p.project } : {}), ...(p.id ? { pageId: p.id } : {}), ...(changeId ? { changeId } : {}) });

  /** The domain a project is a copy of (Stage 1 and 2: the project id is the domain id). */
  const domainOfProject = (project: string) => project;
  const domainDef = (domain: string) => deps.project()?.domains?.[domain];
  const regulated = (p: Pick<WrittenPage, 'domain'>) => !!domainDef(p.domain)?.regulated;

  function refreshPlaybook(project: string): string {
    return domainDef(domainOfProject(project))?.pageRules?.refresh ?? REFRESH_PAGE;
  }

  const names = new Map<string, string>();
  async function nameOf(by: string | undefined): Promise<string | undefined> {
    if (!by || by === 'system' || by.startsWith('step:') || by.startsWith('role:')) return undefined;
    if (!names.has(by)) {
      const p = await deps.people.get(by).catch(() => undefined);
      if (p) names.set(by, p.name);
    }
    return names.get(by);
  }

  /** Whether the actor may accept or send back answer changes on this page: its owner, the app's reviewer role, or anyone when neither is set. */
  function mayReview(actor: Actor, p: WrittenPage): boolean {
    if (actor.kind === 'system') return true;
    if (actor.kind !== 'person') return false;
    const reviewer = domainDef(p.domain)?.pageRules?.reviewer;
    if (p.owner === actor.personId) return true;
    if (reviewer && hasRole(actor, reviewer, p.domain)) return true;
    return !p.owner && !reviewer;
  }

  const refusal = (status: NonNullable<PageWriteResult['status']>, message: string): PageWriteResult => ({ applied: false, status, message });

  /** Marks a parent that sums up its sub-pages for a summary refresh (one of its kept sub-pages changed). */
  async function markParent(db: Queryable, p: WrittenPage) {
    if (!p.parent || p.status !== 'kept') return;
    const parent = await pages.get(db, p.parent);
    if (!parent?.sumsChildren || parent.status !== 'kept' || !parent.refresh) return;
    await pages.set(db, parent.id, { refresh: { ...parent.refresh, summaryDue: new Date().toISOString() } });
  }

  // ---------------------------------------------------------------- reading

  async function history(p: WrittenPage, list?: PageChange[]): Promise<PageHistoryEntry[]> {
    const versions = await pages.versions(pool, p.id);
    const all = list ?? (await changes.forPage(pool, p.id));
    const out: PageHistoryEntry[] = [];
    const acceptedVersions = new Set(all.filter((c) => c.status === 'accepted' && c.toVersion).map((c) => c.toVersion!));
    for (const v of versions) {
      if (acceptedVersions.has(v.version)) continue;
      const via = v.via ?? '';
      const kind: PageHistoryEntry['kind'] = v.version === 1
        ? (p.question ? 'asked' : 'made')
        : v.reason === 'Undo' ? 'undo' : via.startsWith('chat:') ? 'chat' : via.startsWith('run:') ? 'refresh' : 'person';
      out.push({ at: v.at, kind, version: v.version, ...(v.by ? { by: v.by } : {}), ...(v.reason ? { text: v.reason } : {}) });
    }
    for (const c of all) {
      if (c.status === 'pending') continue;
      if (c.status === 'sent_back' && c.comment === 'Replaced by a newer refresh') continue;
      out.push({
        at: c.reviewedAt ?? c.at, kind: c.status, changeId: c.id, ...(c.toVersion ? { version: c.toVersion } : {}),
        ...(c.reviewedBy ? { by: c.reviewedBy } : {}), ...(c.summary.title ? { text: c.summary.title } : c.comment ? { text: c.comment } : {}),
      });
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.version ?? 0) - (a.version ?? 0)));
    for (const e of out) {
      const n = await nameOf(e.by);
      if (n) e.byName = n;
    }
    return out;
  }

  async function children(p: WrittenPage): Promise<PageChild[]> {
    const out: PageChild[] = [];
    for (const c of await pages.children(pool, p.id)) {
      const list = await changes.forPage(pool, c.id);
      out.push({ ...summaryOf(c, { pending: list.find((x) => x.status === 'pending'), last: list.find((x) => x.status !== 'pending') }), inSummary: c.status === 'kept' });
    }
    return out;
  }

  /** Live blocks computed for this viewer now; written blocks as they are. */
  async function resolveBody(p: WrittenPage, kids: PageChild[], recent: PageView['changes'], actor: Actor): Promise<string> {
    return replaceFences(p.body, async (f) => {
      if (!(LIVE_BLOCKS as readonly string[]).includes(f.lang)) return undefined;
      const spec = (blockJson(f) ?? {}) as Record<string, unknown>;
      const kind = f.lang as PageBlockKind;
      const computedAt = new Date().toISOString();
      if (kind === 'subpages') {
        const cards = [];
        for (const c of kids) {
          const child = await pages.get(pool, c.id);
          const l = child ? (await history(child))[0] : undefined;
          cards.push({
            id: c.id, title: c.title, status: c.status, headline: c.headline, inSummary: c.inSummary, ...(c.refresh ? { every: c.refresh.every } : {}),
            ...(l ? { last: { kind: l.kind, at: l.at, ...(l.byName ? { byName: l.byName } : {}), ...(l.text ? { text: l.text } : {}) } } : {}),
          });
        }
        return JSON.stringify({ ...spec, pages: cards, ...(spec.changes !== false ? { changes: recent } : {}), computedAt });
      }
      // records: a live query, as this viewer may see it.
      try {
        const entity = typeof spec.entity === 'string' ? spec.entity : '';
        if (!entity) return JSON.stringify({ ...spec, error: 'A records block needs an entity.', computedAt });
        const r = await deps.records().query({
          entity, domain: p.domain,
          ...(typeof spec.filter === 'string' && spec.filter.trim() ? { filter: spec.filter } : {}),
          ...(Array.isArray(spec.columns) ? { columns: spec.columns.filter((c): c is string => typeof c === 'string') } : {}),
          ...(Array.isArray(spec.sort) ? { sort: (spec.sort as unknown[]).flatMap((s) => typeof s === 'string' ? [s.startsWith('-') ? { field: s.slice(1), desc: true } : { field: s }] : []) } : {}),
          limit: Math.min(Math.max(Number(spec.limit) || 20, 1), 200),
        }, actor);
        return JSON.stringify({
          ...spec, computedAt,
          result: {
            entity: r.entity, total: r.total, columns: r.columns.map((c) => ({ name: c.name, type: c.type })),
            rows: r.rows.map((row) => ({
              id: row.id, title: row.title, ...(row.status ? { status: row.status } : {}),
              values: Object.fromEntries(Object.entries(row.values).filter(([k]) => !row.hidden.includes(k))),
              ...(row.refs ? { refs: Object.fromEntries(Object.entries(row.refs).map(([k, ref]) => [k, ref.title])) } : {}),
            })),
          },
        });
      } catch (e) {
        return JSON.stringify({ ...spec, error: e instanceof Error ? e.message : String(e), computedAt });
      }
    });
  }

  async function view(p: WrittenPage, actor: Actor): Promise<PageView> {
    const list = await changes.forPage(pool, p.id);
    const kids = await children(p);
    const hist = await history(p, list);
    const breadcrumb: PageView['breadcrumb'] = [];
    for (let at = p.parent, n = 0; at && n < 20; n++) {
      const up = await pages.get(pool, at);
      if (!up) break;
      breadcrumb.unshift({ id: up.id, title: up.title });
      at = up.parent;
    }
    // A parent's "What changed this week": each sub-page's latest line in the last seven days.
    const since = new Date(Date.now() - WEEK_MS).toISOString();
    const recent: PageView['changes'] = [];
    for (const c of kids) {
      const child = await pages.get(pool, c.id);
      if (!child) continue;
      const line = (await history(child)).find((h) => h.at >= since && ['accepted', 'nothing_new', 'made', 'asked', 'chat'].includes(h.kind));
      if (!line) continue;
      const kind = line.kind === 'asked' ? 'made' : (line.kind as 'accepted' | 'nothing_new' | 'made' | 'chat');
      recent.push({ pageId: c.id, title: c.title, kind, at: line.at, ...(line.text ? { text: line.text } : {}), ...(line.byName ? { byName: line.byName } : {}) });
    }
    const versions = p.version > 1 ? await pages.versions(pool, p.id) : [];
    const current = versions.find((v) => v.version === p.version);
    const previous = versions.find((v) => v.version === p.version - 1);
    const fromChat = current?.via?.startsWith('chat:') && previous
      ? { version: p.version, chatId: current.via.slice(5), sections: changedSections(previous.body, current.body) }
      : undefined;
    return {
      ...summaryOf(p, { pending: list.find((c) => c.status === 'pending'), last: list.find((c) => c.status !== 'pending') }),
      body: await resolveBody(p, kids, recent, actor),
      written: p.body,
      ...(p.chatId ? { chatId: p.chatId } : {}),
      regulated: regulated(p),
      breadcrumb,
      children: kids,
      history: hist,
      ...(fromChat ? { changedFromChat: fromChat } : {}),
      canUndo: p.version > 1 && p.status !== 'archived' && !(regulated(p) && p.status === 'kept'),
      changes: recent,
    };
  }

  async function changeView(c: PageChange, actor: Actor): Promise<PageChangeView | undefined> {
    const p = await pages.get(pool, c.pageId);
    if (!p) return undefined;
    const before = (await pages.version(pool, p.id, c.fromVersion))?.body ?? p.body;
    const waiting = c.status === 'pending' && c.runId
      ? (await pool.query(`select id from mw.step_runs where run_id = $1 and status = 'waiting' and performer = 'person' order by started_at desc limit 1`, [c.runId])).rows[0]?.id as string | undefined
      : undefined;
    const reviewedByName = await nameOf(c.reviewedBy);
    return {
      id: c.id, pageId: p.id, pageTitle: p.title, project: p.project, status: c.status, fromVersion: c.fromVersion,
      ...(c.toVersion ? { toVersion: c.toVersion } : {}), summary: c.summary, before, after: c.body,
      ...(c.runId ? { runId: c.runId } : {}), ...(c.caseId ? { caseId: c.caseId } : {}), ...(waiting ? { stepRunId: waiting } : {}),
      ...(c.reviewedBy ? { reviewedBy: c.reviewedBy } : {}), ...(reviewedByName ? { reviewedByName } : {}), ...(c.comment ? { comment: c.comment } : {}),
      at: c.at, mayDecide: c.status === 'pending' && mayReview(actor, p),
    };
  }

  /** Where a new or moved page may hang: a page of the same project that isn't the page itself or under it. */
  async function parentProblem(project: string, id: string | undefined, parent: string | null | undefined): Promise<string | undefined> {
    if (!parent) return undefined;
    const up = await pages.get(pool, parent);
    if (!up || up.status === 'archived') return `There is no page ${parent} to put it under.`;
    if (up.project !== project) return `${up.title} is in another project.`;
    for (let at: string | undefined = up.id, n = 0; at && n < 50; n++) {
      if (at === id) return `A page can't go under itself or one of its own sub-pages.`;
      at = (await pages.get(pool, at))?.parent;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- refreshing

  async function startRefresh(p: WrittenPage, key: string, reason: 'schedule' | 'manual' | 'summary', by?: string) {
    const workflowId = refreshPlaybook(p.project);
    // The run is named after the page (`page_title`, when its case type has the field).
    const named = !!deps.project()?.workflows[workflowId]?.caseType?.fields?.page_title;
    return deps.start({
      workflowId, runId: derivedRunId(key), by: by ?? `page:${p.id}`,
      case: { ...(named ? { page_title: p.title } : {}), page: p.id, reason, ...(by ? { asked_by: by } : {}) },
    }, { ...(domainDef(p.domain)?.pageRules?.reviewer ? { actsFor: domainDef(p.domain)!.pageRules!.reviewer! } : domainDef(p.domain)?.owner ? { actsFor: domainDef(p.domain)!.owner! } : {}) });
  }

  const core: PagesCore = {
    refreshPlaybook,

    async list(project, _actor) {
      const out: PageSummary[] = [];
      const all = await pages.listProject(pool, project);
      for (const p of all) {
        const list = await changes.forPage(pool, p.id);
        out.push(summaryOf(p, { pending: list.find((c) => c.status === 'pending'), last: list.find((c) => c.status !== 'pending') }));
      }
      // Parents before their children, each level by title.
      const byParent = new Map<string, PageSummary[]>();
      const ids = new Set(out.map((p) => p.id));
      for (const p of out) {
        const k = p.parent && ids.has(p.parent) ? p.parent : '';
        byParent.set(k, [...(byParent.get(k) ?? []), p]);
      }
      const ordered: PageSummary[] = [];
      const walk = (k: string, depth: number) => {
        for (const p of byParent.get(k) ?? []) {
          ordered.push(p);
          if (depth < 20) walk(p.id, depth + 1);
        }
      };
      walk('', 0);
      return ordered;
    },

    async get(id, actor) {
      const p = await pages.get(pool, id);
      return p ? view(p, actor) : undefined;
    },

    async versions(id, _actor) {
      return pages.versions(pool, id);
    },

    async create(input, actor) {
      if (actor.kind !== 'person' && actor.kind !== 'system') return refusal('forbidden', 'Only a person makes pages.');
      const title = input.title?.trim();
      if (!title) return refusal('invalid', 'A page needs a title.');
      const domain = domainOfProject(input.project);
      const project = deps.project();
      if (project?.domains && Object.keys(project.domains).length && !project.domains[domain]) return refusal('invalid', `There is no project ${input.project}.`);
      const problem = await parentProblem(input.project, undefined, input.parent);
      if (problem) return refusal('invalid', problem);
      const p = await pages.save(pool, {
        domain, project: input.project, title, body: input.body ?? '', status: input.status ?? 'draft',
        ...(input.parent ? { parent: input.parent } : {}), ...(input.question ? { question: input.question } : {}),
        ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.sumsChildren ? { sumsChildren: true } : {}),
      }, byOf(actor), { via: viaOf(actor, input.via), reason: input.reason ?? (input.question ? 'Asked a question' : 'Made the page') });
      changed(p);
      return { applied: true, status: 'applied', page: await view(p, actor) };
    },

    async update(id, input, actor) {
      if (actor.kind !== 'person' && actor.kind !== 'system') return refusal('forbidden', 'Only a person changes pages.');
      const p = await pages.get(pool, id);
      if (!p) return refusal('missing', `There is no page ${id}.`);
      if (p.status === 'archived') return refusal('invalid', `${p.title} is archived, so it can't be changed.`);
      if (p.status === 'kept' && regulated(p)) {
        return refusal('regulated', `${domainDef(p.domain)?.name ?? p.domain} is a regulated project: a kept page there changes through a change request, which isn't built yet. Nothing was changed.`);
      }
      if (input.parent !== undefined) {
        const problem = await parentProblem(p.project, p.id, input.parent);
        if (problem) return refusal('invalid', problem);
      }
      const body = input.body;
      const title = input.title?.trim();
      const moved = input.parent !== undefined && (input.parent ?? undefined) !== p.parent;
      if (input.sumsChildren !== undefined) await pages.set(pool, id, { sumsChildren: input.sumsChildren });
      if ((body === undefined || body === p.body) && (!title || title === p.title) && !moved) {
        const same = (await pages.get(pool, id))!;
        if (input.sumsChildren !== undefined) changed(same);
        return { applied: true, status: 'applied', page: await view(same, actor), message: 'Nothing to change.' };
      }
      try {
        const saved = await pages.write(pool, id, {
          ...(title ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(input.parent !== undefined ? { parent: input.parent } : {}),
        }, byOf(actor), { via: viaOf(actor, input.via), reason: input.reason ?? 'Changed the page', ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}) });
        if (saved.status === 'kept') await markParent(pool, saved);
        changed(saved);
        return { applied: true, status: 'applied', page: await view(saved, actor) };
      } catch (e) {
        if ((e as { code?: string }).code === 'stale') return refusal('stale', (e as Error).message);
        throw e;
      }
    },

    async undo(id, actor, opts = {}) {
      if (actor.kind !== 'person' && actor.kind !== 'system') return refusal('forbidden', 'Only a person undoes a change.');
      const p = await pages.get(pool, id);
      if (!p) return refusal('missing', `There is no page ${id}.`);
      if (p.status === 'archived') return refusal('invalid', `${p.title} is archived.`);
      if (p.status === 'kept' && regulated(p)) return refusal('regulated', `${p.title} is in a regulated project; a change there is undone by a change request.`);
      if (opts.version !== undefined && opts.version !== p.version) return refusal('stale', `The page changed again since (version ${p.version}); open it again before undoing.`);
      if (p.version < 2) return refusal('invalid', 'There is no earlier version to go back to.');
      const back = await pages.version(pool, id, p.version - 1);
      if (!back) return refusal('invalid', 'The earlier version was not found.');
      const saved = await pages.write(pool, id, { title: back.title, body: back.body }, byOf(actor), { via: viaOf(actor), reason: 'Undo', expectedVersion: p.version });
      changed(saved);
      return { applied: true, status: 'applied', page: await view(saved, actor) };
    },

    async keep(id, input, actor) {
      if (actor.kind !== 'person' && actor.kind !== 'system') return refusal('forbidden', 'Only a person keeps a page.');
      const p = await pages.get(pool, id);
      if (!p) return refusal('missing', `There is no page ${id}.`);
      if (p.status === 'archived') return refusal('invalid', `${p.title} is archived.`);
      const every = normalEvery(input.every ?? domainDef(p.domain)?.pageRules?.every ?? 'mon');
      if (!every) return refusal('invalid', `"${input.every}" is not a schedule: say a weekday (mon … sun), daily or month.`);
      if (input.until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.until)) return refusal('invalid', 'until is a date, YYYY-MM-DD.');
      if (input.parent !== undefined) {
        const problem = await parentProblem(p.project, p.id, input.parent);
        if (problem) return refusal('invalid', problem);
        if ((input.parent ?? undefined) !== p.parent) {
          await pages.write(pool, id, { parent: input.parent }, byOf(actor), { via: viaOf(actor), reason: 'Moved the page' });
        }
      }
      const next = nextRefresh(every, new Date());
      const playbook = refreshPlaybook(p.project);
      const kept = (await pages.set(pool, id, {
        status: 'kept', ...(actor.kind === 'person' ? { owner: actor.personId } : {}),
        refresh: { every, ...(input.until ? { until: input.until } : {}), next: iso(next), ...(p.refresh?.last ? { last: p.refresh.last } : {}), playbook },
      }))!;
      // A newly kept sub-page goes into its parent's summary at the parent's next refresh.
      await markParent(pool, kept);
      changed(kept);
      return { applied: true, status: 'applied', page: await view(kept, actor) };
    },

    async archive(id, actor) {
      if (actor.kind !== 'person' && actor.kind !== 'system') return refusal('forbidden', 'Only a person archives a page.');
      const p = await pages.get(pool, id);
      if (!p) return refusal('missing', `There is no page ${id}.`);
      const archived = (await pages.set(pool, id, { status: 'archived', refresh: null, pinned: false }))!;
      changed(archived);
      return { applied: true, status: 'applied', page: await view(archived, actor) };
    },

    async refreshNow(id, actor) {
      const p = await pages.get(pool, id);
      if (!p) return { started: false, message: `There is no page ${id}.` };
      if (p.status === 'archived') return { started: false, message: `${p.title} is archived.` };
      // One refresh at a time: a running one is the answer.
      const running = await pool.query(
        `select r.id, r.case_id from mw.runs r join mw.cases c on c.id = r.case_id
          where r.status = 'active' and r.workflow_id = $1 and c.values -> 'page' ->> 'value' = $2 limit 1`, [refreshPlaybook(p.project), p.id]);
      if (running.rows[0]) return { started: false, runId: running.rows[0].id, caseId: running.rows[0].case_id, message: `${p.title} is being refreshed already.` };
      try {
        const by = actor.kind === 'person' ? actor.personId : undefined;
        const r = await startRefresh(p, `page:${p.id}:manual:${Date.now()}`, 'manual', by);
        return { started: true, ...r };
      } catch (e) {
        return { started: false, message: `The refresh could not start: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async getChange(id, actor) {
      const c = await changes.get(pool, id);
      return c ? changeView(c, actor) : undefined;
    },

    async decideChange(id, input, actor) {
      const c = await changes.get(pool, id);
      if (!c) return { applied: false, status: 'missing', message: `There is no answer change ${id}.` };
      if (c.status !== 'pending') return { applied: false, status: 'stale', message: `This change was already ${c.status === 'accepted' ? 'accepted' : 'sent back'}.` };
      const p = await pages.get(pool, c.pageId);
      if (!p) return { applied: false, status: 'missing', message: 'Its page was not found.' };
      if (!mayReview(actor, p)) return { applied: false, status: 'forbidden', message: `Only ${p.title}'s owner or its reviewers accept changes to it.` };
      const outcome = input.decision === 'accept' ? 'accepted' : 'sent_back';
      const waiting = c.runId
        ? (await pool.query(`select id from mw.step_runs where run_id = $1 and status = 'waiting' and performer = 'person' order by started_at desc limit 1`, [c.runId])).rows[0]?.id as string | undefined
        : undefined;
      if (waiting && actor.kind === 'person') {
        await changes.setStepRun(pool, c.id, waiting);
        const r = await deps.submitStep({ stepRunId: waiting, outcome, values: {}, by: actor, ...(input.comment ? { comment: input.comment } : {}) });
        return { applied: r.applied, status: r.status, ...(r.message ? { message: r.message } : {}) };
      }
      // No review step waits (a change made outside a run): decided here.
      if (input.decision === 'accept') await core.accept(c.id, byOf(actor), { ...(input.comment ? { comment: input.comment } : {}) });
      else await core.sendBack(c.id, byOf(actor), input.comment);
      return { applied: true, status: 'applied' };
    },

    async reviseChange(id, input, actor) {
      const c = await changes.get(pool, id);
      if (!c || c.status !== 'pending') return { applied: false, message: 'Only a change waiting for review can be changed.' };
      const p = await pages.get(pool, c.pageId);
      if (!p) return { applied: false, message: 'Its page was not found.' };
      if (!mayReview(actor, p)) return { applied: false, message: `Only ${p.title}'s owner or its reviewers change it.` };
      // The sections this edit changed are marked as from chat; the refresh's own stay as they were.
      const fromRefresh = new Map((c.summary.sections ?? []).map((s) => [s.heading, s]));
      const touched = new Set(changedSections(c.body, input.body));
      const cmp = compareBodies(p.body, input.body);
      const sections: NonNullable<PageChangeSummary['sections']> = [...cmp.added.map((s) => ({ ...s, changed: 'added' as const })), ...cmp.changed.filter((s) => s.heading).map((s) => ({ ...s, changed: 'changed' as const }))]
        .map((s) => ({
          heading: s.heading ?? '', markdown: s.markdown, changed: s.changed,
          origin: touched.has(s.heading ?? '') ? 'chat' as const : (fromRefresh.get(s.heading ?? '')?.origin ?? 'refresh'),
        }));
      const summary: PageChangeSummary = {
        ...c.summary, after: cmp.after, sections, removed: cmp.removed, numbers: cmp.numbers,
        ...(input.note ? { chatNote: input.note } : {}),
      };
      const saved = await changes.revise(pool, id, { body: input.body, summary });
      changed(p, id);
      return { applied: !!saved, ...(saved ? { change: await changeView(saved, actor) } : {}) };
    },

    async sweep(now = new Date()) {
      const out: { pageId: string; runId: string; caseId?: string }[] = [];
      for (const p of await pages.due(pool, now)) {
        try {
          const r = p.refresh!;
          if (r.summaryDue) {
            const started = await startRefresh(p, `page:${p.id}:summary:${r.summaryDue}`, 'summary');
            await pages.set(pool, p.id, { refresh: { ...r, summaryDue: undefined } as typeof r });
            out.push({ pageId: p.id, ...started });
            continue;
          }
          if (!r.next || new Date(r.next) > now) continue;
          // A desktop closed through several slots refreshes once, for the latest one.
          const started = await startRefresh(p, `page:${p.id}:${r.next}`, 'schedule');
          await pages.set(pool, p.id, { refresh: { ...r, next: iso(nextRefresh(r.every, now)) } });
          out.push({ pageId: p.id, ...started });
        } catch {
          // A refresh that can't start (its playbook missing) waits for the next sweep; the page says when it last refreshed.
        }
      }
      if (out.length) deps.emit({ kind: 'pages' });
      return out;
    },

    // ---------------------------------------------------------------- for the page tools

    async forRefresh(id) {
      const p = await pages.get(pool, id);
      if (!p) throw new Error(`There is no page ${id}`);
      const kids = await pages.children(pool, id);
      const kept = kids.filter((c) => c.status === 'kept');
      const list = await changes.forPage(pool, id);
      const last = list.find((c) => c.status !== 'pending' && c.status !== 'sent_back');
      return {
        id: p.id, title: p.title, project: p.project, status: p.status, version: p.version, ...(p.question ? { question: p.question } : {}),
        body: p.body, headline: headline(p.body), ...(p.parent ? { parent: p.parent } : {}),
        last_refresh: p.refresh?.last ?? last?.at ?? p.createdAt,
        sums_children: p.sumsChildren,
        // A parent sums up its kept sub-pages only: drafts are listed apart so they are left out.
        ...(p.sumsChildren ? {
          children: kept.map((c) => ({ id: c.id, title: c.title, question: c.question ?? null, headline: headline(c.body), body: c.body })),
          drafts_left_out: kids.filter((c) => c.status === 'draft').map((c) => c.title),
        } : {}),
      };
    },

    async forList(project, keptOnly) {
      const all = await core.list(project, { kind: 'system' });
      return all.filter((p) => p.status === 'kept' || (!keptOnly && p.status === 'draft')).map((p) => ({
        id: p.id, title: p.title, status: p.status, ...(p.question ? { question: p.question } : {}), headline: p.headline,
        ...(p.parent ? { parent: p.parent } : {}), sums_children: p.sumsChildren, ...(p.refresh?.every ? { every: p.refresh.every } : {}),
        ...(p.lastRefresh ? { last_refresh: p.lastRefresh } : {}), ...(p.pendingChange ? { change_waiting: p.pendingChange.label ?? true } : {}),
      }));
    },

    projectOfWorkflow(workflowId) {
      const wf = deps.project()?.workflows[workflowId];
      return wf?.domain ?? 'domain';
    },

    async compare(input) {
      const p = await pages.get(pool, input.page);
      if (!p) throw new Error(`There is no page ${input.page}`);
      const from = input.reason === 'schedule' ? { kind: 'schedule' as const, ...(p.refresh?.every ? { every: p.refresh.every } : {}) }
        : input.reason === 'summary' ? { kind: 'summary' as const } : { kind: 'manual' as const, ...(input.by ? { by: input.by } : {}) };
      const cmp = compareBodies(p.body, input.body);
      const now = new Date().toISOString();
      const stamp = async () => { if (p.refresh) await pages.set(pool, p.id, { refresh: { ...(await pages.get(pool, p.id))!.refresh!, last: now } }); };
      if (!cmp.material) {
        const c = await changes.nothingNew(pool, { pageId: p.id, fromVersion: p.version, ...(input.runId ? { runId: input.runId } : {}), ...(input.caseId ? { caseId: input.caseId } : {}), summary: { from } });
        await stamp();
        changed(p, c.id);
        return { outcome: 'nothing_new' };
      }
      const summary: PageChangeSummary = {
        ...(input.label ? { label: input.label } : {}), ...(input.changeTitle ? { title: input.changeTitle } : {}),
        before: cmp.before, after: cmp.after, ...(input.plus ? { plus: input.plus } : {}),
        // The headline is shown as before and after; the sections are the named ones that moved.
        sections: [
          ...cmp.added.map((s) => ({ heading: s.heading ?? '', markdown: s.markdown, origin: 'refresh' as const, changed: 'added' as const })),
          ...cmp.changed.filter((s) => s.heading).map((s) => ({ heading: s.heading!, markdown: s.markdown, origin: 'refresh' as const, changed: 'changed' as const })),
        ],
        ...(cmp.removed.length ? { removed: cmp.removed } : {}),
        ...(input.leftOut?.length ? { leftOut: input.leftOut } : {}),
        numbers: cmp.numbers, from,
      };
      const c = await changes.propose(pool, {
        pageId: p.id, fromVersion: p.version, title: input.title?.trim() || p.title, body: input.body, summary,
        ...(input.runId ? { runId: input.runId, id: `pch_${input.runId.replace(/^run_/, '')}` } : {}), ...(input.caseId ? { caseId: input.caseId } : {}),
      });
      await stamp();
      changed(p, c.id);
      return { outcome: 'material', change: c.id };
    },

    async accept(changeId, by, opts = {}) {
      const c = await changes.get(pool, changeId);
      if (!c) throw new Error(`There is no answer change ${changeId}`);
      if (c.status === 'accepted' && c.toVersion) return { version: c.toVersion };
      if (c.status !== 'pending') throw new Error(`The change was ${c.status === 'sent_back' ? 'sent back' : 'already decided'}`);
      const p = (await pages.get(pool, c.pageId))!;
      const saved = await pages.write(pool, p.id, { title: c.title, body: c.body }, by, {
        via: opts.via ?? (c.runId ? `run:${c.runId}` : `person:${by}`), reason: c.summary.title ? `Accepted: ${c.summary.title}` : 'Accepted the answer change',
      });
      await changes.decide(pool, c.id, { status: 'accepted', by, toVersion: saved.version, ...(opts.comment ? { comment: opts.comment } : {}) });
      await markParent(pool, saved);
      changed(saved, c.id);
      return { version: saved.version };
    },

    async sendBack(changeId, by, comment) {
      const c = await changes.get(pool, changeId);
      if (!c) throw new Error(`There is no answer change ${changeId}`);
      if (c.status !== 'pending') return;
      await changes.decide(pool, c.id, { status: 'sent_back', by, ...(comment ? { comment } : {}) });
      changed({ id: c.pageId }, c.id);
    },

    async reviewable(pageId, actor) {
      const p = await pages.get(pool, pageId);
      return !!p && mayReview(actor, p);
    },

    async reviewerOf(runId) {
      const { rows } = await pool.query(
        `select decided_by, comment from mw.step_runs where run_id = $1 and performer = 'person' and decided_by is not null
          order by finished_at desc nulls last, started_at desc limit 1`, [runId]);
      return { ...(rows[0]?.decided_by ? { by: rows[0].decided_by } : {}), ...(rows[0]?.comment ? { comment: rows[0].comment } : {}) };
    },
  };
  return core;
}

/** The answer changes these step runs review, for the waiting list (kernel.inbox). */
export async function pageChangeRefs(pool: pg.Pool, runIds: string[]): Promise<Map<string, PageChangeRef>> {
  const out = new Map<string, PageChangeRef>();
  if (!runIds.length) return out;
  const { rows } = await pool.query(
    `select c.id, c.run_id, c.page_id, c.summary, c.at, p.title, p.project from mw.page_changes c join mw.pages p on p.id = c.page_id
      where c.run_id = any($1::text[]) and c.status = 'pending'`, [runIds]);
  for (const r of rows) {
    const s = (r.summary ?? {}) as PageChangeSummary;
    out.set(r.run_id, {
      changeId: r.id, pageId: r.page_id, pageTitle: r.title, project: r.project, ...(s.label ? { label: s.label } : {}),
      ...(s.from ? { from: s.from } : {}), at: (r.at as Date).toISOString(),
    });
  }
  return out;
}
