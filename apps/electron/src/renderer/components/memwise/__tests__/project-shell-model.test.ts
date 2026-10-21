/**
 * The project shell's model (doc 26 §2, Stage 1): projects from domains with their waiting counts,
 * the switcher's grouping, playbook start tags, chat anchors per page, and the rewriter that opens
 * the older routes inside a project.
 */

import { describe, expect, test } from 'bun:test'
import type { MwCaseSummary, MwDomain, MwInboxItem, MwPlaybookSummary, MwTrigger } from '@memwise/shared/protocol'
import {
  anchorKeyOf, chatAnchorFor, groupByApp, initials, pickProject, playbookStartTag, pluralTitle, projectPlaybooks, shellProjects, sortWaiting, waitingIn,
} from '../project/project-model'
import { shellRouteFor, type ShellRouteData } from '../project/shell-routes'
import { parseRouteToNavigationState } from '../../../../shared/route-parser'
import { routes } from '../../../../shared/routes'

const domain = (id: string, name: string, extra: Partial<MwDomain> = {}): MwDomain => ({
  id, name, regulated: false, workflows: [], entities: [], pages: [], flags: 0, ...extra,
} as unknown as MwDomain)

const domains = [
  domain('domain', 'Main'),
  domain('etmf', 'eTMF', { regulated: true, workflows: ['activate-site'], entities: [{ key: 'etmf.Site', title: 'Site', count: 3 }] as MwDomain['entities'] }),
  domain('edc', 'EDC', { entities: [{ key: 'edc.Site', title: 'Site', count: 3 }] as MwDomain['entities'] }),
]
const playbooks = [
  { id: 'activate-site', title: 'Activate a site', domain: 'etmf' },
  { id: 'route-message', title: 'Sort an incoming message', domain: 'etmf' },
  { id: 'create-playbook', title: 'Build a playbook', domain: 'domain' },
] as MwPlaybookSummary[]
const item = (id: string, workflowId: string, since: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'decision', id, stepRunId: `sr_${id}`, caseId: `case_${id}`, runId: 'r', caseTitle: id, workflowId, stepTitle: 'Approve', outcomes: [], since, ...extra }) as unknown as MwInboxItem
const inbox = [item('a', 'activate-site', '2026-10-20T10:00:00Z'), item('b', 'activate-site', '2026-10-15T10:00:00Z'), item('c', 'unknown-wf', '2026-10-19T10:00:00Z')]

describe('projects from domains', () => {
  test('each domain is a project in an app of its own; the empty default domain is left out', () => {
    const projects = shellProjects(domains, inbox.slice(0, 2), playbooks)
    expect(projects.map(p => p.id)).toEqual(['etmf', 'edc'])
    expect(projects.find(p => p.id === 'etmf')).toMatchObject({ name: 'eTMF', appId: 'etmf', regulated: true, waiting: 2 })
    expect(groupByApp(projects).map(a => [a.id, a.projects.length])).toEqual([['etmf', 1], ['edc', 1]])
  })

  test('the default domain shows while something waits in it (a playbook being built)', () => {
    const projects = shellProjects(domains, inbox, playbooks, 'Northlight')
    expect(projects.map(p => p.id)).toEqual(['etmf', 'edc', 'domain'])
    expect(projects[2]).toMatchObject({ name: 'Northlight', waiting: 1 })
    expect(pickProject(projects, null, null)?.id).toBe('etmf')
  })

  test('the default domain shows, under the workspace name, when it is the only one', () => {
    expect(shellProjects([domain('domain', 'Main')], [], [], 'Northlight')).toMatchObject([{ id: 'domain', name: 'Northlight' }])
  })

  test('picking the project to open', () => {
    const projects = shellProjects(domains, inbox, playbooks)
    expect(pickProject(projects, 'edc', 'etmf')?.id).toBe('edc')
    expect(pickProject(projects, 'gone', 'edc')?.id).toBe('edc')
    expect(pickProject(projects, null, null)?.id).toBe('etmf')
    expect(pickProject([], 'x', 'y')).toBeNull()
  })

  test('waiting items per project, longest waiting first', () => {
    expect(waitingIn('etmf', inbox, { playbooks, domains }).map(i => i.id)).toEqual(['a', 'b'])
    expect(waitingIn('*', inbox, { playbooks, domains })).toHaveLength(3)
    expect(sortWaiting(inbox).map(i => i.id)).toEqual(['b', 'c', 'a'])
    const due = item('d', 'activate-site', '2026-10-21T10:00:00Z', { dueAt: '2026-10-22T10:00:00Z' })
    expect(sortWaiting([...inbox, due])[0]!.id).toBe('d')
  })

  test('the sidebar leaves the meta playbooks out and tags how each playbook starts', () => {
    expect(projectPlaybooks('etmf', playbooks).map(p => p.id)).toEqual(['activate-site', 'route-message'])
    const triggers = [
      { workflowId: 'route-message', kind: 'message', description: 'When an email arrives' },
      { workflowId: 'digest', kind: 'every', description: 'Every week on Friday' },
      { workflowId: 'monthly', kind: 'every', description: 'On the 1st of every month' },
      { workflowId: 'activate-site', kind: 'entered', description: 'When a Site enters Activating' },
    ] as unknown as MwTrigger[]
    expect(playbookStartTag('route-message', triggers)).toBe('email')
    expect(playbookStartTag('digest', triggers)).toBe('Fri')
    expect(playbookStartTag('monthly', triggers)).toBe('1st')
    expect(playbookStartTag('activate-site', triggers)).toBeUndefined()
  })

  test('words', () => {
    expect(pluralTitle('Site')).toBe('Sites')
    expect(pluralTitle('Study')).toBe('Studies')
    expect(pluralTitle('Papers')).toBe('Papers')
    expect(initials('Anika Rao')).toBe('AR')
    expect(initials('root')).toBe('RO')
  })
})

describe('the chat beside each page', () => {
  test('anchors', () => {
    expect(chatAnchorFor('etmf', { type: 'home' })).toEqual({ kind: 'project', id: 'etmf' })
    expect(chatAnchorFor('etmf', { type: 'waiting' })).toEqual({ kind: 'waiting', id: 'etmf' })
    expect(chatAnchorFor('etmf', { type: 'waiting', itemId: 'a' }, inbox[0])).toEqual({ kind: 'step', id: 'sr_a' })
    expect(chatAnchorFor('etmf', { type: 'dashboard', domain: 'etmf', pageId: 'tmf-health' })).toEqual({ kind: 'dashboard', domain: 'etmf', id: 'tmf-health' })
    expect(chatAnchorFor('etmf', { type: 'playbook', workflowId: 'activate-site' })).toEqual({ kind: 'workflow', id: 'activate-site' })
    expect(chatAnchorFor('etmf', { type: 'run', caseId: 'c1' })).toEqual({ kind: 'case', id: 'c1' })
    expect(chatAnchorFor('etmf', { type: 'record', entity: 'etmf.Site', recordId: 's1' })).toEqual({ kind: 'record', entity: 'etmf.Site', id: 's1' })
    expect(anchorKeyOf({ kind: 'record', entity: 'etmf.Site', id: 's1' })).toBe('record:etmf.Site:s1')
  })
})

describe('older routes open inside a project', () => {
  const data: ShellRouteData = {
    currentProject: 'edc',
    workflowDomain: id => playbooks.find(p => p.id === id)?.domain,
    entityDomain: key => key.split('.')[0],
    inbox,
    cases: [{ caseId: 'k1', workflowId: 'activate-site', domain: 'etmf' }] as MwCaseSummary[],
    hasProject: id => ['etmf', 'edc'].includes(id),
  }
  const to = (route: string) => shellRouteFor(parseRouteToNavigationState(route)!, data)

  test('inbox, cases, playbooks, records, dashboards and chats', () => {
    expect(to(routes.view.inbox('a'))).toBe('mw/etmf/waiting/a')
    expect(to(routes.view.inbox())).toBe('mw/edc/waiting')
    expect(to(routes.view.cases('k1'))).toBe('mw/etmf/run/k1')
    expect(to(routes.view.playbooks('activate-site'))).toBe('mw/etmf/playbook/activate-site')
    expect(to(routes.view.record('etmf.Site', 's1'))).toBe('mw/etmf/record/etmf.Site%3As1')
    expect(to(routes.view.domains({ type: 'entities', domain: 'etmf', entity: 'etmf.Site' }))).toBe('mw/etmf/records/etmf.Site')
    expect(to(routes.view.domains({ type: 'dashboard', domain: 'etmf', pageId: 'tmf-health', params: { study: 's' } }))).toBe('mw/etmf/dashboard/etmf%3Atmf-health%3Fstudy%3Ds')
    expect(to(routes.view.domains({ type: 'domain', domain: 'etmf' }))).toBe('mw/etmf')
    expect(to(routes.view.allSessions('chat1'))).toBe('mw/edc/home/chat1')
    expect(to(routes.view.allSessions())).toBe('mw/edc')
  })

  test('settings and the other app screens keep their own layout', () => {
    expect(to('settings')).toBeNull()
    expect(to(routes.view.draft('d1'))).toBeNull()
    expect(to('mw/etmf')).toBeNull()
  })
})
