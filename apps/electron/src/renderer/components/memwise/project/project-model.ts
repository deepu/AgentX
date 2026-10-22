/**
 * The project shell's model (docs/memwise/26-projects-and-pages.md §2, Stage 1): which projects
 * there are, grouped by app, what waits for the person in each, and the sidebar's lists. Until
 * projects are stored (Stage 3) each domain is one project, in a placeholder app of the same name,
 * and the project id is the domain id. Pure functions, so the screens and tests share them.
 */

import type { MwApp, MwChatAnchor, MwDomain, MwInboxItem, MwPageSummary, MwPlaybookSummary, MwProjectStatus, MwRecordQueryInput, MwTrigger } from '@memwise/shared/protocol'
import type { ProjectDetails } from '../../../../shared/project-route'
import { inboxItemProject } from '@memwise/shared/protocol'
import { isMetaPlaybook } from '../draft/draft-model'

export interface ShellProject {
  id: string
  name: string
  /** The app it is a copy of (Stage 1: the domain itself). */
  appId: string
  appName: string
  /**
   * The domain whose definitions it shows (its playbooks, record types, pages): its app's. In
   * Stage 1 the project id; from Stage 3 a study `mw301` shows the `etmf` domain.
   */
  domain: string
  /** Every app it runs, `appId` first (D105: a firm's one project running GST and ITR). */
  apps: string[]
  description?: string
  regulated: boolean
  /** Items waiting for the person in this project. */
  waiting: number
  /** Stage 3: the project is stored (its records and runs are its own, filtered by its id). */
  stored?: boolean
  status?: MwProjectStatus
  /** An app's own project (no project.yaml). */
  implicit?: boolean
  /** A newer template version waits for review (`from`: the version it is on). */
  update?: { to: number; from?: number }
}

export interface ShellApp {
  id: string
  name: string
  projects: ShellProject[]
  /** Stage 3: the app home's link ("All studies"). */
  home?: { title: string; link?: string }
  /** Stage 3: the person may make projects here. */
  canCreate?: boolean
  /** Stage 3: what a project is called here ({ one: study, many: studies }). */
  nouns?: { one: string; many: string }
}

/** The default domain (24 §2): a project with no domains of its own shows as the workspace. */
export const DEFAULT_PROJECT = 'domain'

export interface Lookups {
  playbooks: MwPlaybookSummary[] | null | undefined
  domains: MwDomain[] | null | undefined
}

/** Resolves the project of inbox items from the playbooks' and entities' domains. */
export function projectLookups({ playbooks, domains }: Lookups) {
  const wf = new Map((playbooks ?? []).map(p => [p.id, p.domain]))
  const ent = new Map<string, string>()
  for (const d of domains ?? []) for (const e of d.entities) ent.set(e.key, d.id)
  return {
    workflowDomain: (id: string) => wf.get(id),
    entityDomain: (key: string) => ent.get(key) ?? key.split('.')[0],
  }
}

/** The items waiting in one project ('*': all of them). */
export function waitingIn(projectId: string, inbox: MwInboxItem[] | null | undefined, lookups: Lookups, apps?: readonly string[]): MwInboxItem[] {
  if (!inbox) return []
  if (projectId === '*') return inbox
  const l = projectLookups(lookups)
  return inbox.filter(i => inboxItemProject(i, l) === projectId || (!!apps && isAppItem(i) && apps.includes(i.domain!)))
}

/**
 * Stage 5 on Stage 3: a change request or an inspector's question is its app's (`domain`), not one
 * project's, so it waits in every project that runs the app (`apps`, a study's `[etmf]`).
 */
function isAppItem(i: MwInboxItem): i is Extract<MwInboxItem, { kind: 'change-request' | 'inspector-question' }> {
  return (i.kind === 'change-request' || i.kind === 'inspector-question') && !i.project && !!i.domain
}

/** Projects from the domains (Stage 1), with their waiting counts. */
export function shellProjects(domains: MwDomain[] | null | undefined, inbox: MwInboxItem[] | null | undefined, playbooks: MwPlaybookSummary[] | null | undefined, workspaceName?: string): ShellProject[] {
  if (!domains) return []
  const l = projectLookups({ playbooks, domains })
  const counts = new Map<string, number>()
  for (const i of inbox ?? []) {
    const p = inboxItemProject(i, l)
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  // The default domain only shows when it is the only one, or when it has something in it (items
  // waiting on a playbook being built are in it, so it shows while there are any).
  const own = domains.filter(d => d.id !== DEFAULT_PROJECT)
  // When it shows beside others it comes last, so a person still lands on a project of their own.
  const shownDefault = domains.filter(d => d.id === DEFAULT_PROJECT && (hasContent(d) || (counts.get(d.id) ?? 0) > 0))
  const list = own.length ? [...own, ...shownDefault] : domains
  return list.map(d => {
    const name = d.id === DEFAULT_PROJECT ? workspaceName || d.name : d.name
    return {
      id: d.id, name, appId: d.id, appName: name, domain: d.id, apps: [d.id], regulated: d.regulated,
      ...(d.description ? { description: d.description } : {}),
      waiting: counts.get(d.id) ?? 0,
    }
  })
}

/**
 * Projects as stored (Stage 3): each project the person sees, once, with its waiting count from
 * the server. An app's own project of the default domain shows as Stage 1 showed it: only when it
 * is the only one or has something in it. Archived projects go last.
 */
export function storedShellProjects(apps: MwApp[], domains: MwDomain[] | null | undefined, workspaceName?: string): ShellProject[] {
  const seen = new Map<string, ShellProject>()
  for (const app of apps) {
    for (const p of app.projects) {
      if (seen.has(p.id)) continue
      const domain = domains?.find(d => d.id === p.app)
      const name = p.implicit && p.id === DEFAULT_PROJECT ? workspaceName || p.name : p.name
      seen.set(p.id, {
        id: p.id, name, appId: p.app, appName: p.app === app.id ? app.title : p.appTitle, domain: p.app, apps: p.apps,
        regulated: domain?.regulated ?? false, waiting: p.waiting, stored: true, status: p.status,
        ...(domain?.description && p.implicit ? { description: domain.description } : {}),
        ...(p.implicit ? { implicit: true } : {}), ...(p.update ? { update: { ...p.update, from: p.templateVersion } } : {}),
      })
    }
  }
  const all = [...seen.values()]
  const own = all.filter(p => !(p.implicit && p.id === DEFAULT_PROJECT))
  const defaultDomain = domains?.find(d => d.id === DEFAULT_PROJECT)
  const shownDefault = all.filter(p => p.implicit && p.id === DEFAULT_PROJECT && (p.waiting > 0 || (defaultDomain ? hasContent(defaultDomain) : false)))
  const list = own.length ? [...own, ...shownDefault] : all
  const rank = (p: ShellProject) => (p.status === 'archived' ? 1 : 0)
  return list.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p)
}

/** Apps as stored, each with the shown projects that run it (a project running two apps is under both). */
export function storedShellApps(apps: MwApp[], projects: ShellProject[]): ShellApp[] {
  const out: ShellApp[] = []
  for (const app of apps) {
    const own = projects.filter(p => p.apps.includes(app.id))
    if (!own.length && !app.canCreate) continue
    out.push({
      id: app.id, name: app.title, projects: own, canCreate: app.canCreate, nouns: app.nouns,
      ...(app.home ? { home: app.home } : {}),
    })
  }
  return out
}

/** The records a project's lists show: its domain's, and only its own once projects are stored. */
export function projectRecordScope(project: Pick<ShellProject, 'id' | 'domain' | 'stored'>): Pick<MwRecordQueryInput, 'domain' | 'project'> {
  return { domain: project.domain, ...(project.stored ? { project: project.id } : {}) }
}

/** The run's project: Stage 3's own field, else (Stage 1) its playbook's domain. */
export function caseProject(c: { project?: string; domain?: string }): string {
  return c.project ?? c.domain ?? DEFAULT_PROJECT
}

function hasContent(d: MwDomain): boolean {
  return d.workflows.some(w => !isMetaPlaybook(w)) || d.entities.length > 0 || d.pages.length > 0
}

/** Projects grouped by app, in the order the domains came. */
export function groupByApp(projects: ShellProject[]): ShellApp[] {
  const apps: ShellApp[] = []
  for (const p of projects) {
    let app = apps.find(a => a.id === p.appId)
    if (!app) { app = { id: p.appId, name: p.appName, projects: [] }; apps.push(app) }
    app.projects.push(p)
  }
  return apps
}

/** The project to open: the one asked for if it exists, else the last one used, else the first. */
export function pickProject(projects: ShellProject[], wanted?: string | null, last?: string | null): ShellProject | null {
  return projects.find(p => p.id === wanted) ?? projects.find(p => p.id === last) ?? projects[0] ?? null
}

/**
 * A project's playbooks for the sidebar: every app's it runs (the meta playbooks that build
 * playbooks are left out). Pass the project, or (Stage 1) a domain id.
 */
export function projectPlaybooks(project: string | Pick<ShellProject, 'apps'>, playbooks: MwPlaybookSummary[] | null | undefined): MwPlaybookSummary[] {
  const apps = typeof project === 'string' ? [project] : project.apps
  return (playbooks ?? []).filter(p => apps.includes(p.domain ?? DEFAULT_PROJECT) && !isMetaPlaybook(p.id) && !APP_PLAYBOOKS.includes(p.id))
}

/** The app's own playbooks (`@memwise/defs` APP_PLAYBOOKS): they make projects, so no project lists them. */
export const APP_PLAYBOOKS: readonly string[] = ['create-project']

/**
 * The short tag beside a playbook in the sidebar: how it starts. `email` for an incoming message,
 * the day for a weekly schedule ("Fri"), the date for a monthly one ("1st"); none when a person
 * or a record change starts it.
 */
export function playbookStartTag(workflowId: string, triggers: MwTrigger[] | null | undefined): string | undefined {
  const own = (triggers ?? []).filter(t => t.workflowId === workflowId)
  for (const t of own) {
    if (t.kind === 'message') return 'email'
    if (t.kind === 'every') {
      const day = /\bon ([A-Za-z]+)/.exec(t.description)?.[1]
      if (day && /^(mon|tue|wed|thu|fri|sat|sun)/i.test(day)) return day.slice(0, 1).toUpperCase() + day.slice(1, 3).toLowerCase()
      const nth = /\b(\d+)(st|nd|rd|th)\b/.exec(t.description)
      if (nth) return `${nth[1]}${nth[2]}`
      if (/month/i.test(t.description)) return '1st'
      if (/day\b/i.test(t.description)) return 'daily'
      return 'weekly'
    }
  }
  return undefined
}

/** A project's record types for the sidebar, top level first, with their counts. */
export function projectRecordTypes(domain: MwDomain | null | undefined): { key: string; title: string; count: number }[] {
  if (!domain) return []
  return domain.entities.map(e => ({ key: e.key, title: pluralTitle(e.title), count: e.count }))
}

/**
 * The sidebar's RECORDS rows with their counts. A stored project (Stage 3) shows its own counts
 * only: until they are read a row has no count, never the app's count across every project.
 */
export function sidebarRecordCounts(
  project: Pick<ShellProject, 'stored'>, types: { key: string; title: string; count: number }[], own: Record<string, number> | null | undefined,
): { key: string; title: string; count?: number }[] {
  if (!project.stored) return types
  return types.map(r => (own && typeof own[r.key] === 'number' ? { ...r, count: own[r.key] } : { key: r.key, title: r.title }))
}

/** "Site" → "Sites", "Study" → "Studies"; titles already plural stay as they are. */
export function pluralTitle(title: string): string {
  if (/s$/i.test(title)) return title
  if (/[^aeiou]y$/i.test(title)) return `${title.slice(0, -1)}ies`
  if (/(ch|sh|x|z)$/i.test(title)) return `${title}es`
  return `${title}s`
}

/** Two-letter initials for a person's avatar. */
export function initials(name: string | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}

/** Inbox items, the oldest waiting first (the one waiting longest is usually the one to do). */
export function sortWaiting(items: MwInboxItem[]): MwInboxItem[] {
  return [...items].sort((a, b) => {
    const da = 'dueAt' in a && a.dueAt ? a.dueAt : undefined
    const db = 'dueAt' in b && b.dueAt ? b.dueAt : undefined
    if (da && db && da !== db) return da < db ? -1 : 1
    if (da && !db) return -1
    if (db && !da) return 1
    return a.since < b.since ? -1 : a.since > b.since ? 1 : 0
  })
}

/** One string per anchor, to tell anchors apart. */
export function anchorKeyOf(anchor: MwChatAnchor): string {
  if (anchor.kind === 'record') return `record:${anchor.entity}:${anchor.id}`
  if (anchor.kind === 'dashboard') return `dashboard:${anchor.domain}:${anchor.id}`
  return `${anchor.kind}:${anchor.id}`
}

/**
 * Where a written page shows in the sidebar (26 §4): at the top of PAGES, or, when it was written
 * under a record (`under`), in the record tree under that record.
 */
export function writtenPagePlace(p: Pick<MwPageSummary, 'under'>): 'top' | 'record-tree' {
  return p.under ? 'record-tree' : 'top'
}

/**
 * What the chat beside a page is about (doc 26 §2): Home and the project's lists talk about the
 * project; Waiting for you about what waits; an item about its step; a dashboard, playbook, run
 * or record about itself; a written page about the page (it can change the page, with Undo), and
 * an answer change opened outside Waiting for you about its page (`changePageId`, once known);
 * a change request, the audit trail and the TMF index about themselves.
 * `scope` (Stage 4 with Stage 3): a stored project's id. A playbook's chat there changes that
 * project's own copy, and a list's chat filters that project's records.
 */
export function chatAnchorFor(projectId: string, details: ProjectDetails, item?: MwInboxItem | null, changePageId?: string, scope?: string): MwChatAnchor {
  switch (details.type) {
    case 'waiting':
      if (details.itemId && item) {
        if ('stepRunId' in item && item.stepRunId) return { kind: 'step', id: item.stepRunId }
        if (item.caseId) return { kind: 'case', id: item.caseId }
      }
      return { kind: 'waiting', id: projectId }
    case 'dashboard': return { kind: 'dashboard', domain: details.domain, id: details.pageId }
    case 'playbook': return { kind: 'workflow', id: details.workflowId, ...(scope ? { project: scope } : {}) }
    case 'run': return { kind: 'case', id: details.caseId }
    case 'record': return { kind: 'record', entity: details.entity, id: details.recordId }
    case 'records': return { kind: 'records', id: details.entity, ...(scope ? { project: scope } : {}) }
    case 'page': return { kind: 'page', id: details.pageId }
    case 'change': return changePageId ? { kind: 'page', id: changePageId } : { kind: 'project', id: projectId }
    // Stage 5 (doc 26 §8): a change request's chat edits it; the trail and the index have their own.
    // A label (`CR-014`) is per project, so the anchor carries the project.
    case 'cr': return { kind: 'change', id: details.crId, project: projectId }
    case 'audit': return { kind: 'audit', id: projectId }
    // Project settings' Audit trail tab is the same page, with the same chat.
    case 'settings': return details.tab === 'audit' ? { kind: 'audit', id: projectId } : { kind: 'project', id: projectId }
    case 'tmf': return { kind: 'tmf', id: projectId }
    default: return { kind: 'project', id: projectId }
  }
}

/** The inbox item id of a project's template update (as Waiting across projects names it). */
export function updateItemId(project: Pick<ShellProject, 'id' | 'update'>): string | undefined {
  return project.update ? `template-update:${project.id}:${project.update.to}` : undefined
}
