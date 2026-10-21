/**
 * In the project shell, the older MemWise routes open inside a project (doc 26 §10): an inbox
 * item opens under Waiting for you, a case as a run, a playbook, a record, a record type, a
 * dashboard, a domain's page as the project's Home or settings, and a chat in the chat column.
 * Pure: the shell hands in what it knows about projects.
 */

import type { MwCaseSummary, MwInboxItem } from '@memwise/shared/protocol'
import { inboxItemProject } from '@memwise/shared/protocol'
import type { NavigationState } from '../../../../shared/types'
import { projectRoute, type ProjectDetails } from '../../../../shared/project-route'

export interface ShellRouteData {
  /** The open project, else the last one used, else the first. */
  currentProject: string
  workflowDomain: (workflowId: string) => string | undefined
  entityDomain: (entityKey: string) => string | undefined
  inbox: MwInboxItem[] | null
  cases: MwCaseSummary[] | null
  /** Whether a project exists (unknown ones fall back to the current project). */
  hasProject: (id: string) => boolean
}

/**
 * The shell route for a classic one, or null when the route stays as it is (settings, sources,
 * skills, plugins, the pages library, playbook drafts).
 */
export function shellRouteFor(state: NavigationState, data: ShellRouteData): string | null {
  const p = (id: string | undefined) => (id && data.hasProject(id) ? id : data.currentProject)
  const at = (project: string | undefined, details?: ProjectDetails) => projectRoute(p(project), details ?? { type: 'home' })
  const entityDomain = (key: string) => data.entityDomain(key) ?? key.split('.')[0]
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
      return at(c?.domain ?? (c ? data.workflowDomain(c.workflowId) : undefined), { type: 'run', caseId: state.details.caseId })
    }
    case 'playbooks': {
      if (!state.details) return at(undefined)
      if (state.details.type !== 'playbook') return null
      return at(data.workflowDomain(state.details.playbookId), { type: 'playbook', workflowId: state.details.playbookId })
    }
    case 'domains': {
      const d = state.details
      if (!d) return at(undefined)
      switch (d.type) {
        case 'record': return at(entityDomain(d.entity), { type: 'record', entity: d.entity, recordId: d.recordId })
        case 'entities': return at(d.domain, d.entity ? { type: 'records', entity: d.entity } : { type: 'settings' })
        case 'dashboard': return at(d.domain, { type: 'dashboard', domain: d.domain, pageId: d.pageId, ...(d.params ? { params: d.params } : {}) })
        case 'automations': return at(d.domain, { type: 'settings', tab: 'automations' })
        case 'domain': return at(d.domain, d.tab ? { type: 'settings', tab: d.tab } : undefined)
      }
      return null
    }
    case 'sessions': {
      // A chat opens in the chat column of the project's Home.
      return state.details ? at(undefined, { type: 'home', chatId: state.details.sessionId }) : at(undefined)
    }
    case 'plugins': {
      if (state.details?.type === 'records') return at(entityDomain(state.details.entity), { type: 'records', entity: state.details.entity })
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
