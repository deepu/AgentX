/**
 * The project shell's model (docs/memwise/26-projects-and-pages.md §2, Stage 1): which projects
 * there are, grouped by app, what waits for the person in each, and the sidebar's lists. Until
 * projects are stored (Stage 3) each domain is one project, in a placeholder app of the same name,
 * and the project id is the domain id. Pure functions, so the screens and tests share them.
 */

import type { MwChatAnchor, MwDomain, MwInboxItem, MwPlaybookSummary, MwTrigger } from '@memwise/shared/protocol'
import type { ProjectDetails } from '../../../../shared/project-route'
import { inboxItemProject } from '@memwise/shared/protocol'
import { isMetaPlaybook } from '../draft/draft-model'

export interface ShellProject {
  id: string
  name: string
  /** The app it is a copy of (Stage 1: the domain itself). */
  appId: string
  appName: string
  description?: string
  regulated: boolean
  /** Items waiting for the person in this project. */
  waiting: number
}

export interface ShellApp {
  id: string
  name: string
  projects: ShellProject[]
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
export function waitingIn(projectId: string, inbox: MwInboxItem[] | null | undefined, lookups: Lookups): MwInboxItem[] {
  if (!inbox) return []
  if (projectId === '*') return inbox
  const l = projectLookups(lookups)
  return inbox.filter(i => inboxItemProject(i, l) === projectId)
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
      id: d.id, name, appId: d.id, appName: name, regulated: d.regulated,
      ...(d.description ? { description: d.description } : {}),
      waiting: counts.get(d.id) ?? 0,
    }
  })
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

/** A project's playbooks for the sidebar (the meta playbooks that build playbooks are left out). */
export function projectPlaybooks(projectId: string, playbooks: MwPlaybookSummary[] | null | undefined): MwPlaybookSummary[] {
  return (playbooks ?? []).filter(p => (p.domain ?? DEFAULT_PROJECT) === projectId && !isMetaPlaybook(p.id))
}

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
 * What the chat beside a page is about (doc 26 §2): Home and the project's lists talk about the
 * project; Waiting for you about what waits; an item about its step; a dashboard, playbook, run
 * or record about itself. Stage 2 adds written pages.
 */
export function chatAnchorFor(projectId: string, details: ProjectDetails, item?: MwInboxItem | null): MwChatAnchor {
  switch (details.type) {
    case 'waiting':
      if (details.itemId && item) {
        if ('stepRunId' in item && item.stepRunId) return { kind: 'step', id: item.stepRunId }
        if (item.caseId) return { kind: 'case', id: item.caseId }
      }
      return { kind: 'waiting', id: projectId }
    case 'dashboard': return { kind: 'dashboard', domain: details.domain, id: details.pageId }
    case 'playbook': return { kind: 'workflow', id: details.workflowId }
    case 'run': return { kind: 'case', id: details.caseId }
    case 'record': return { kind: 'record', entity: details.entity, id: details.recordId }
    default: return { kind: 'project', id: projectId }
  }
}
