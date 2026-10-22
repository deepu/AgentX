/**
 * In the project shell, the older MemWise routes open inside a project (doc 26 §10): an inbox
 * item opens under Waiting for you, a case as a run, a playbook, a record, a record type, a
 * dashboard, a domain's page as the project's Home or settings, and a chat in the chat column.
 * Pure: the shell hands in what it knows about projects.
 */

import type { MwCaseSummary, MwInboxItem } from '@memwise/shared/protocol'
import { inboxItemProject } from '@memwise/shared/protocol'
import type { NavigationState } from '../../../../shared/types'
import { ALL_PROJECTS, projectRoute, type ProjectDetails } from '../../../../shared/project-route'

export interface ShellRouteData {
  /** The open project, else the last one used, else the first. */
  currentProject: string
  workflowDomain: (workflowId: string) => string | undefined
  entityDomain: (entityKey: string) => string | undefined
  inbox: MwInboxItem[] | null
  cases: MwCaseSummary[] | null
  /** Whether a project exists (unknown ones fall back to the current project). */
  hasProject: (id: string) => boolean
  /**
   * Stage 3: the project to open an app's screens in when the app id isn't itself a project (a
   * study app): the open project when it runs the app, else the one project that does; undefined
   * when that isn't clear, and the app home opens instead.
   */
  projectForApp?: (appId: string) => string | undefined
}

/**
 * The shell route for a classic one, or null when the route stays as it is (settings, sources,
 * skills, plugins, the pages library, playbook drafts).
 */
export function shellRouteFor(state: NavigationState, data: ShellRouteData): string | null {
  const p = (id: string | undefined) => (id && data.hasProject(id) ? id : data.currentProject)
  const at = (project: string | undefined, details?: ProjectDetails) => projectRoute(p(project), details ?? { type: 'home' })
  const entityDomain = (key: string) => data.entityDomain(key) ?? key.split('.')[0]
  // A classic domain route: in the project of that id (Stage 1, and an app's own project), else
  // the project that runs the app, else the app home (Stage 3: a domain id isn't a project id).
  const inApp = (app: string | undefined, details?: ProjectDetails) => {
    if (!app || data.hasProject(app)) return at(app, details)
    const project = data.projectForApp?.(app)
    if (project) return at(project, details)
    return data.projectForApp ? projectRoute(ALL_PROJECTS, { type: 'app', appId: app }) : at(app, details)
  }
  switch (state.navigator) {
    case 'inbox': {
      if (!state.details) return at(undefined, { type: 'waiting' })
      const item = data.inbox?.find(i => i.id === state.details!.itemId)
      const project = item ? inboxItemProject(item, { workflowDomain: data.workflowDomain, entityDomain }) : undefined
      return at(project, { type: 'waiting', itemId: state.details.itemId })
    }
    case 'cases': {
      if (!state.details) return at(undefined)
      const c = data.cases?.find(x => x.caseId === state.details!.caseId)
      if (c?.project) return at(c.project, { type: 'run', caseId: state.details.caseId })
      return inApp(c?.domain ?? (c ? data.workflowDomain(c.workflowId) : undefined), { type: 'run', caseId: state.details.caseId })
    }
    case 'playbooks': {
      if (!state.details) return at(undefined)
      if (state.details.type !== 'playbook') return null
      return inApp(data.workflowDomain(state.details.playbookId), { type: 'playbook', workflowId: state.details.playbookId })
    }
    case 'domains': {
      const d = state.details
      if (!d) return at(undefined)
      switch (d.type) {
        case 'record': {
          // A record opens in its own project; when the app id isn't a project, under all
          // projects, where the record page finds its project (or shows it there).
          const domain = entityDomain(d.entity)
          const details = { type: 'record' as const, entity: d.entity, recordId: d.recordId }
          if (!domain || data.hasProject(domain) || !data.projectForApp) return at(domain, details)
          return projectRoute(ALL_PROJECTS, details)
        }
        case 'entities': return inApp(d.domain, d.entity ? { type: 'records', entity: d.entity } : { type: 'settings' })
        case 'dashboard': return inApp(d.domain, { type: 'dashboard', domain: d.domain, pageId: d.pageId, ...(d.params ? { params: d.params } : {}) })
        case 'automations': return inApp(d.domain, { type: 'settings', tab: 'automations' })
        case 'domain': return inApp(d.domain, d.tab ? { type: 'settings', tab: d.tab } : undefined)
        // Stage 5: a change request, the audit trail, inspector access, the TMF index.
        case 'regulated': {
          if (d.screen === 'change') return inApp(d.domain, { type: 'cr', crId: d.id! })
          if (d.screen === 'inspectors') return inApp(d.domain, { type: 'settings', tab: 'inspectors' })
          if (d.screen === 'tmf') return inApp(d.domain, d.id ? { type: 'tmf', zone: d.id } : { type: 'tmf' })
          const i = d.id ? d.id.indexOf(':') : -1
          return inApp(d.domain, i > 0 ? { type: 'audit', entity: d.id!.slice(0, i), recordId: d.id!.slice(i + 1) } : { type: 'audit' })
        }
      }
      return null
    }
    case 'sessions': {
      // A chat opens in the chat column of the project's Home.
      return state.details ? at(undefined, { type: 'home', chatId: state.details.sessionId }) : at(undefined)
    }
    case 'plugins': {
      if (state.details?.type === 'records') return inApp(entityDomain(state.details.entity), { type: 'records', entity: state.details.entity })
      return null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------- the active rewriter

type Rewriter = (route: string) => string | null
let active: Rewriter | null = null

/** The shell sets this while it is on; navigation asks it before opening a route. */
export function setShellRouteRewriter(rewriter: Rewriter | null): void {
  active = rewriter
}

/** The route to open instead, or null to open the route as given. */
export function rewriteShellRoute(route: string): string | null {
  return active ? active(route) : null
}
