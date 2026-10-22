/**
 * The `mw` navigator: the project shell (docs/memwise/26-projects-and-pages.md §2). Every screen
 * belongs to one project and shows two columns, the chat about what's open on the left and the
 * page on the right; there is no middle list, the project sidebar is the navigator.
 *
 * Routes are `mw/{project}` (Home) or `mw/{project}/{type}[/{id}]`, where `id` is one URI-encoded
 * segment packing the detail's parts:
 *   home       `{chatId}`                (a chat asked from Home, shown in the left column)
 *   waiting    `{inboxItemId}`           (none: the Waiting for you page)
 *   page       `{pageId}`                (a written page)
 *   change     `{changeId}`              (a page's answer change, for review or to read)
 *   dashboard  `{domain}:{pageId}` plus `?{params}`
 *   playbook   `{workflowId}`
 *   run        `{caseId}`
 *   record     `{entity}:{recordId}`     (entity keys never hold a colon)
 *   records    `{entity}`
 *   settings   `{tab}`                   (none: the first tab)
 *   cr         `{crId}`                  (Stage 5: a change request, by id or label `CR-014`)
 *   audit      `{entity}:{recordId}`     (Stage 5: the audit trail; none: the whole project's)
 *   tmf        `{zone}`                  (Stage 5: the TMF index; a zone's sub-page)
 * `*` as the project is "all projects" (Waiting for you across every project).
 */

export const ALL_PROJECTS = '*'

export type ProjectDetails =
  | { type: 'home'; chatId?: string }
  | { type: 'waiting'; itemId?: string }
  | { type: 'page'; pageId: string }
  | { type: 'change'; changeId: string }
  | { type: 'dashboard'; domain: string; pageId: string; params?: Record<string, string> }
  | { type: 'playbook'; workflowId: string }
  | { type: 'run'; caseId: string }
  | { type: 'record'; entity: string; recordId: string }
  | { type: 'records'; entity: string }
  | { type: 'settings'; tab?: string }
  | { type: 'cr'; crId: string }
  | { type: 'audit'; entity?: string; recordId?: string }
  | { type: 'tmf'; zone?: string }

export const PROJECT_DETAIL_TYPES = ['home', 'waiting', 'page', 'change', 'dashboard', 'playbook', 'run', 'record', 'records', 'settings', 'cr', 'audit', 'tmf'] as const

/** Types whose id may be left out. */
const OPTIONAL_ID: readonly string[] = ['home', 'waiting', 'settings', 'audit', 'tmf']

export interface ProjectView {
  projectId: string
  details: ProjectDetails
}

function splitFirst(value: string, sep: string): [string, string | undefined] {
  const i = value.indexOf(sep)
  return i < 0 ? [value, undefined] : [value.slice(0, i), value.slice(i + sep.length)]
}

/** The packed id of a detail (not yet URI-encoded); empty when it has none. */
export function packProjectDetail(d: ProjectDetails): string {
  switch (d.type) {
    case 'home': return d.chatId ?? ''
    case 'waiting': return d.itemId ?? ''
    case 'page': return d.pageId
    case 'change': return d.changeId
    case 'dashboard': {
      const params = d.params && Object.keys(d.params).length
        ? `?${new URLSearchParams(Object.entries(d.params).sort(([a], [b]) => a.localeCompare(b))).toString()}`
        : ''
      return `${d.domain}:${d.pageId}${params}`
    }
    case 'playbook': return d.workflowId
    case 'run': return d.caseId
    case 'record': return `${d.entity}:${d.recordId}`
    case 'records': return d.entity
    case 'settings': return d.tab ?? ''
    case 'cr': return d.crId
    case 'audit': return d.entity && d.recordId ? `${d.entity}:${d.recordId}` : ''
    case 'tmf': return d.zone ?? ''
  }
}

/** The detail a type and packed id name, or null when malformed. */
export function unpackProjectDetail(type: string, id: string): ProjectDetails | null {
  if (!id && !OPTIONAL_ID.includes(type)) return null
  switch (type) {
    case 'home': return id ? { type: 'home', chatId: id } : { type: 'home' }
    case 'waiting': return id ? { type: 'waiting', itemId: id } : { type: 'waiting' }
    case 'page': return { type: 'page', pageId: id }
    case 'change': return { type: 'change', changeId: id }
    case 'dashboard': {
      const [head, query] = splitFirst(id, '?')
      const [domain, pageId] = splitFirst(head, ':')
      if (!domain || !pageId) return null
      const params = query ? Object.fromEntries(new URLSearchParams(query)) : undefined
      return { type: 'dashboard', domain, pageId, ...(params && Object.keys(params).length ? { params } : {}) }
    }
    case 'playbook': return { type: 'playbook', workflowId: id }
    case 'run': return { type: 'run', caseId: id }
    case 'record': {
      const [entity, recordId] = splitFirst(id, ':')
      return entity && recordId ? { type: 'record', entity, recordId } : null
    }
    case 'records': return { type: 'records', entity: id }
    case 'settings': return id ? { type: 'settings', tab: id } : { type: 'settings' }
    case 'cr': return { type: 'cr', crId: id }
    case 'audit': {
      if (!id) return { type: 'audit' }
      const [entity, recordId] = splitFirst(id, ':')
      return entity && recordId ? { type: 'audit', entity, recordId } : null
    }
    case 'tmf': return id ? { type: 'tmf', zone: id } : { type: 'tmf' }
    default: return null
  }
}

/** The route of a project screen. */
export function projectRoute(projectId: string, details?: ProjectDetails | null): string {
  const p = encodeURIComponent(projectId)
  if (!details || (details.type === 'home' && !details.chatId)) return `mw/${p}`
  const id = packProjectDetail(details)
  return id ? `mw/${p}/${details.type}/${encodeURIComponent(id)}` : `mw/${p}/${details.type}`
}

function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s) } catch { return null }
}

/** Parses `mw/...` segments (the first being `mw`); null when malformed. */
export function parseProjectSegments(segments: string[]): ProjectView | null {
  if (segments[0] !== 'mw' || segments.length < 2 || segments.length > 4) return null
  const projectId = safeDecode(segments[1])
  if (!projectId) return null
  if (segments.length === 2) return { projectId, details: { type: 'home' } }
  const type = segments[2]
  if (!(PROJECT_DETAIL_TYPES as readonly string[]).includes(type)) return null
  const id = segments.length === 4 ? safeDecode(segments[3]) : ''
  if (id === null) return null
  const details = unpackProjectDetail(type, id)
  return details ? { projectId, details } : null
}

/**
 * The compound form used by the route parser: `type` is the detail type and `id` packs the project
 * with the detail's id (`{project}|{id}`; project ids never hold a `|`).
 */
export function toCompoundDetails(view: ProjectView): { type: string; id: string } {
  return { type: view.details.type, id: `${view.projectId}|${packProjectDetail(view.details)}` }
}

export function fromCompoundDetails(details: { type: string; id: string } | null): ProjectView | null {
  if (!details) return null
  const [projectId, rest] = splitFirst(details.id, '|')
  if (!projectId) return null
  const d = unpackProjectDetail(details.type, rest ?? '')
  return d ? { projectId, details: d } : null
}
