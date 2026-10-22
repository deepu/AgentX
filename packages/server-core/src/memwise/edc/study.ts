/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9): the EDC study home, "Also in other apps",
 * and the same record in the other apps.
 *
 * Everything here reads as the viewer (their access holds) from records the Rave connector keeps
 * (a read-only copy of what Rave owns, refreshed by the binding's `sync:`, D110), and says when
 * that copy was read, so a page shows "synced 6 min ago" instead of passing it off as live.
 *
 * Until projects exist (Stage 3), a project id is read as the study key ("MW-301"); with them, the
 * project's `study:` names the key, and every app's project with that key is the same study.
 */
import type { EntityTypeDef, ProjectDefs } from '@memwise/defs'
import type { Actor, InboxItem, RecordQueryResult, RecordsService } from '@memwise/runtime'
import type {
  MwEdcHome, MwEdcSiteProgress, MwEdcWaiting, MwLinkedRecord, MwRecordRef, MwSourceSync, MwStudyApp, MwStudyApps,
} from '@memwise/shared/protocol'
import type { MemwiseService } from '../service'
import { domainName, humanize, pluginTitle, toRecordPage } from '../dto'

/** Queries open longer than this are "old" (the EDC Site's `old_queries`). */
export const OLD_QUERY_DAYS = 14
export const EDC_DOMAIN = 'edc'

type Row = RecordQueryResult['rows'][number]

function recordsOf(svc: MemwiseService): RecordsService {
  const records = (svc.kernel as { records?: RecordsService }).records
  if (!records) throw new Error('Records are not available in this version.')
  return records
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : 0)
const optNum = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : num(v))
const bare = (key: string) => key.slice(key.indexOf('.') + 1)
const domainOf = (key: string) => (key.includes('.') ? key.slice(0, key.indexOf('.')) : 'domain')
const refOf = (entity: string, r: Row): MwRecordRef => ({ entity, id: r.id, title: r.title, ...(r.status ? { status: r.status } : {}) })

/** All rows of an entity the actor may see (sites, studies: tens, not thousands), within a project when given. */
async function rowsOf(svc: MemwiseService, actor: Actor, entity: string, project?: string, limit = 500): Promise<Row[]> {
  return (await recordsOf(svc).query({ entity, limit, ...(project ? { project } : {}) }, actor)).rows
}

interface ProjectLite { id: string; name?: string; app?: string; apps?: string[]; study?: string; implicit?: boolean; status?: string }

/** Stage 3's projects, read loosely: absent before them. */
function projectsOf(project: ProjectDefs): Record<string, ProjectLite> {
  return (project as { projects?: Record<string, ProjectLite> }).projects ?? {}
}

/** A real project (not an app's own) running `domain`: its records are its own, so reads stay in it. */
function scopeOf(p: ProjectLite | undefined, domain: string): string | undefined {
  return p && !p.implicit && (p.apps ?? [p.app]).includes(domain) ? p.id : undefined
}

/** The record of a domain's Study entity whose key field (the first in its title) is `key`. */
function studyKeyField(def: EntityTypeDef): string | undefined {
  const m = /\{(\w+)\}/.exec(def.title ?? '')
  return m?.[1] ?? (def.fields.code ? 'code' : def.fields.protocol ? 'protocol' : undefined)
}

const sameKey = (a: unknown, key: string) => typeof a === 'string' && a.trim().toLowerCase() === key.trim().toLowerCase()

async function studyRecord(svc: MemwiseService, actor: Actor, project: ProjectDefs, domain: string, key: string, scope?: string): Promise<{ row: Row; entity: string } | undefined> {
  const entity = `${domain}.Study`
  const def = project.entities[entity]
  if (!def) return undefined
  const field = studyKeyField(def)
  const rows = await rowsOf(svc, actor, entity, scope)
  const row = rows.find((r) => (field && sameKey(r.values[field], key)) || sameKey(r.values.rave_ref, key))
  return row ? { row, entity } : undefined
}

/** A Study row's key: its key field (the protocol, "MW-301"), not the Rave OID. */
function keyOfRow(project: ProjectDefs, domain: string, r: Row): string {
  const def = project.entities[`${domain}.Study`]
  const field = (def && studyKeyField(def)) ?? 'protocol'
  return String(r.values[field] ?? r.values.rave_ref ?? r.title)
}

export interface ResolvedStudy {
  key: string;
  study?: { row: Row; entity: string };
  /** The project whose records these are, when the study is a real project's (Stage 6 Part B). */
  project?: string;
}

/**
 * The study a project means in an app (Stage 6 Part B), in this order:
 *  1. the project's own `study:` (projects/<id>/project.yaml). It is the answer even before the
 *     first read has brought the study's record, so a project never shows another study;
 *  2. before projects, the id read as a study key ("MW-301");
 *  3. the connection's study (`RAVE_STUDY`, a setting);
 *  4. the app's default: its only study, or with several the one with the most sites (ties: the
 *     first by key), so the home shows the main study rather than nothing.
 * One study is the same study in every app through the projects naming it, not through a global.
 */
export async function resolveStudy(svc: MemwiseService, actor: Actor, project: ProjectDefs, domain: string, projectId: string,
  env: Record<string, string | undefined> = process.env): Promise<ResolvedStudy> {
  const p = projectsOf(project)[projectId]
  const scope = scopeOf(p, domain)
  const at = (r: ResolvedStudy): ResolvedStudy => (scope ? { ...r, project: scope } : r)
  if (p?.study) {
    const found = await studyRecord(svc, actor, project, domain, p.study, scope)
    return at({ key: found ? keyOfRow(project, domain, found.row) : p.study, ...(found ? { study: found } : {}) })
  }
  for (const key of [p ? undefined : projectId, env.RAVE_STUDY?.trim() || undefined]) {
    if (!key) continue
    const found = await studyRecord(svc, actor, project, domain, key, scope)
    if (found) return at({ key: keyOfRow(project, domain, found.row), study: found })
  }
  const entity = `${domain}.Study`
  if (!project.entities[entity]) return at({ key: projectId })
  const all = await rowsOf(svc, actor, entity, scope)
  if (all.length === 0) return at({ key: projectId })
  let pick = all[0]!
  if (all.length > 1) {
    const sites = project.entities[`${domain}.Site`] ? await rowsOf(svc, actor, `${domain}.Site`, scope) : []
    const count = (r: Row) => sites.filter((x) => sameKey(x.values.study, keyOfRow(project, domain, r))).length
    pick = [...all].sort((a, b) => count(b) - count(a) || keyOfRow(project, domain, a).localeCompare(keyOfRow(project, domain, b)))[0]!
  }
  return at({ key: keyOfRow(project, domain, pick), study: { row: pick, entity } })
}

/** The plugin whose binding fills this domain's entities, and its last read. */
async function sourceOf(svc: MemwiseService, project: ProjectDefs, domain: string): Promise<MwSourceSync | null> {
  const binding = Object.values(project.bindings ?? {}).find((b) => Object.values(b.records ?? {}).some((r) => domainOf(r.entity) === domain))
  if (!binding) return null
  const identity = (svc.kernel as { identity?: { syncs?: () => Promise<{ plugin: string; at?: string; nextDue?: string; error?: string; errorAt?: string; counts: Record<string, number> }[]> } }).identity
  const sync = (await identity?.syncs?.().catch(() => []))?.find((s) => s.plugin === binding.plugin)
  return {
    plugin: binding.plugin, title: pluginTitle(project, binding.plugin),
    ...(sync?.at ? { at: sync.at } : {}), ...(sync?.nextDue ? { nextDue: sync.nextDue } : {}),
    ...(sync?.error ? { error: sync.error } : {}), ...(sync?.errorAt ? { errorAt: sync.errorAt } : {}),
    ...(sync?.counts && Object.keys(sync.counts).length ? { counts: sync.counts } : {}),
  }
}

/** What waits for the actor from this domain's playbooks, one line per case and kind. */
function waitingIn(project: ProjectDefs, items: InboxItem[], domain: string): MwEdcHome['waiting'] {
  const groups = new Map<string, MwEdcWaiting>()
  let total = 0
  for (const i of items) {
    const workflowId = 'workflowId' in i ? i.workflowId : undefined
    const wf = workflowId ? project.workflows[workflowId] : undefined
    const inDomain = wf ? (wf.domain ?? 'domain') === domain : i.kind === 'flag' && i.domain === domain
    if (!inDomain) continue
    total++
    const caseId = 'caseId' in i ? i.caseId : undefined
    const key = `${caseId ?? i.id}:${i.kind}`
    const g = groups.get(key)
    if (g) { g.count++; if (i.since < g.since) g.since = i.since; continue }
    groups.set(key, {
      kind: i.kind, count: 1, since: i.since,
      ...(caseId ? { caseId } : {}), ...(workflowId ? { workflowId, workflowTitle: wf?.title ?? humanize(workflowId) } : {}),
      ...('dueAt' in i && i.dueAt ? { dueAt: i.dueAt } : {}),
    })
  }
  return { total, items: [...groups.values()].sort((a, b) => a.since.localeCompare(b.since)) }
}

export async function edcHome(svc: MemwiseService, actor: Actor, project: ProjectDefs, input: { projectId: string; domain?: string }): Promise<MwEdcHome> {
  const domain = input.domain ?? EDC_DOMAIN
  if (!project.domains?.[domain]) throw new Error(`There is no ${domain.toUpperCase()} app in this workspace.`)
  const { key, study, project: scope } = await resolveStudy(svc, actor, project, domain, input.projectId)
  const siteEntity = `${domain}.Site`
  const sites = project.entities[siteEntity] ? (await rowsOf(svc, actor, siteEntity, scope)).filter((r) => r.values.study === undefined || sameKey(r.values.study, key)) : []
  const progress: MwEdcSiteProgress[] = sites.map((r) => {
    const target = optNum(r.values.enrolment_target)
    const randomised = num(r.values.randomised)
    return {
      site: refOf(siteEntity, r), number: String(r.values.site_number ?? r.title), randomised,
      ...(target !== undefined ? { target, percent: target > 0 ? Math.round((randomised / target) * 100) : 0 } : {}),
      openQueries: num(r.values.open_queries), oldQueries: num(r.values.old_queries),
    }
  }).sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101) || a.number.localeCompare(b.number))

  const sv = study?.row.values ?? {}
  const siteTarget = progress.reduce((n, s) => n + (s.target ?? 0), 0)
  const target = optNum(sv.enrolment_target) ?? (siteTarget || undefined)
  const plannedByNow = optNum(sv.planned_by_now)
  const pagesVerified = optNum(sv.pages_verified)
  const kernel = svc.kernel as { inbox?: (a: Actor) => Promise<InboxItem[]> }
  const items = actor.kind === 'person' && kernel.inbox ? await kernel.inbox(actor).catch(() => []) : []
  const name = typeof sv.name === 'string' && sv.name ? sv.name : undefined
  return {
    domain,
    study: { key, ...(name ? { name } : {}), ...(study ? { record: refOf(study.entity, study.row) } : {}) },
    source: await sourceOf(svc, project, domain),
    randomised: { value: progress.reduce((n, s) => n + s.randomised, 0), ...(target !== undefined ? { target } : {}), ...(plannedByNow !== undefined ? { plannedByNow } : {}) },
    queries: { open: progress.reduce((n, s) => n + s.openQueries, 0), old: progress.reduce((n, s) => n + s.oldQueries, 0), olderThanDays: OLD_QUERY_DAYS },
    pagesVerified: pagesVerified ?? null,
    waiting: waitingIn(project, items, domain),
    sites: progress,
  }
}

/** Entities of `a` and `b` paired by a link (D71), named once each. */
function sharedEntities(project: ProjectDefs, a: string, b: string): string[] {
  const out = new Set<string>()
  for (const [key, def] of Object.entries(project.entities)) {
    const from = domainOf(key)
    if (from !== a && from !== b) continue
    for (const [k, l] of Object.entries(def.links ?? {})) {
      const target = l.target || k
      const to = domainOf(target)
      if ((from === a && to === b) || (from === b && to === a)) out.add(`${humanize(bare(target))}s`)
    }
  }
  return [...out].sort()
}

/**
 * "Also in other apps": the same study in each other app that has it, with a few headline facts.
 * With projects (Stage 6 Part B) the link is the project: every other app's project naming the
 * same `study:`, and the study's record in it. Before them, or for a study no other project names,
 * an app's Study record with the same key.
 */
export async function studyApps(svc: MemwiseService, actor: Actor, project: ProjectDefs, input: { projectId: string; domain?: string }): Promise<MwStudyApps> {
  const here = input.domain ?? EDC_DOMAIN
  const { key } = await resolveStudy(svc, actor, project, here, input.projectId)
  const projects = Object.values(projectsOf(project))
  const ownStudy = projectsOf(project)[input.projectId]?.study
  const apps: MwStudyApp[] = []
  for (const domain of Object.keys(project.domains ?? {}).sort()) {
    if (domain === here || domain === 'domain') continue
    // The projects of that app naming this study (archived ones too: it is still the same study).
    const same = projects.filter((p) => !p.implicit && p.id !== input.projectId && (p.apps ?? [p.app]).includes(domain) && p.study && (sameKey(p.study, key) || (ownStudy && sameKey(p.study, ownStudy))))
      .sort((a, b) => a.id.localeCompare(b.id))
    const hits: { target?: ProjectLite; found: { row: Row; entity: string } }[] = []
    for (const target of same) {
      const found = await studyRecord(svc, actor, project, domain, target.study!, target.id).catch(() => undefined)
      if (found) hits.push({ target, found })
    }
    // No project of that app has the study's record (or none names it): its record by key, anywhere.
    if (!hits.length) {
      const found = await studyRecord(svc, actor, project, domain, key).catch(() => undefined)
      if (found) hits.push({ found })
    }
    for (const { target, found } of hits) {
      const shares = sharedEntities(project, here, domain)
      const def = project.entities[found.entity]!
      const facts = Object.entries(def.calculated ?? {}).map(([name, c]) => ({
        name, label: humanize(name), type: c.kind === 'rollup' && c.rollup === 'percent' ? 'Percentage' : 'Number', value: found.row.values[name] ?? null,
      }))
      apps.push({
        domain, domainName: domainName(project, domain), record: refOf(found.entity, found.row), facts, shares,
        ...(target ? { project: { id: target.id, name: target.name ?? target.id } } : {}),
      })
    }
  }
  return { study: { key }, apps }
}

/** The same record in the other apps: paired by a link either way (`mw.identity_links`, plugin `domain:<d>`). */
export async function linkedRecords(svc: MemwiseService, actor: Actor, project: ProjectDefs, input: { entity: string; id: string }, names?: Map<string, string>): Promise<MwLinkedRecord[]> {
  const pool = (svc.kernel as { pool?: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, string>[] }> } }).pool
  if (!pool || !project.entities[input.entity]) return []
  // Only for a record the viewer may see: the links would otherwise say it exists, and what it is paired with.
  if (!(await recordsOf(svc).page(input.entity, input.id, actor).catch(() => undefined))) return []
  const pairs: { entity: string; id: string }[] = []
  // It follows another record (etmf.Site → edc.Site) …
  const out = await pool.query(`select plugin, source, external_id from mw.identity_links where entity = $1 and record_id = $2 and plugin like 'domain:%'`, [input.entity, input.id])
  for (const r of out.rows) pairs.push({ entity: `${r.plugin!.slice('domain:'.length)}.${r.source}`, id: r.external_id! })
  // … or another record follows it (edc.Site ← etmf.Site).
  const into = await pool.query(`select entity, record_id from mw.identity_links where plugin = $1 and source = $2 and external_id = $3`, [`domain:${domainOf(input.entity)}`, bare(input.entity), input.id])
  for (const r of into.rows) pairs.push({ entity: r.entity!, id: r.record_id! })

  const result: MwLinkedRecord[] = []
  for (const p of pairs) {
    if (!project.entities[p.entity]) continue
    const page = await recordsOf(svc).page(p.entity, p.id, actor).catch(() => undefined)
    if (!page) continue // not theirs to see
    const dto = toRecordPage({ project }, page, names)
    const domain = domainOf(p.entity)
    result.push({
      domain, domainName: domainName(project, domain), entity: p.entity, id: p.id, title: dto.title,
      ...(dto.status ? { status: dto.status } : {}),
      // Its own facts: not those it follows from the record asked about, nor what the viewer can't see.
      fields: dto.fields.filter((f) => !f.followed && !f.hidden && f.name !== 'status').map((f) => ({ ...f, editable: false })),
    })
  }
  return result
}
