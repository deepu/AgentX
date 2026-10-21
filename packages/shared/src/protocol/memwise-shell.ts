/**
 * Small rules the project shell (docs/memwise/26-projects-and-pages.md §2) shares between the
 * app and the server: which project an inbox item belongs to, and how a chat words it. Until
 * projects are stored (Stage 3) a project is a domain, so these resolve domains.
 */
import type { MwInboxItem } from './memwise'

export interface ProjectLookups {
  /** A playbook's domain. */
  workflowDomain(workflowId: string): string | undefined
  /** An entity key's domain. */
  entityDomain(entity: string): string | undefined
}

/** The project (domain) an inbox item is in; `domain` (the default domain) when nothing says. */
export function inboxItemProject(item: MwInboxItem, lookups: ProjectLookups): string {
  if ('domain' in item && typeof item.domain === 'string' && item.domain) return item.domain
  if (item.kind === 'identity') return lookups.entityDomain(item.entity) ?? 'domain'
  if (item.workflowId) return lookups.workflowDomain(item.workflowId) ?? 'domain'
  return 'domain'
}

/** One line about an item for a chat's context: what, about what, from where, since when. */
export function inboxItemLine(item: MwInboxItem, playbookTitle: (workflowId: string) => string | undefined): string {
  const from = item.workflowId ? playbookTitle(item.workflowId) ?? item.workflowId : undefined
  const due = 'dueAt' in item && item.dueAt ? `, due ${item.dueAt.slice(0, 10)}` : ''
  const what = 'stepTitle' in item ? item.stepTitle : item.reason
  return `${what} · ${item.caseTitle}${from ? ` · from ${from}` : ''} · waiting since ${item.since.slice(0, 10)}${due}`
}
