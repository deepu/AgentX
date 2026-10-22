/**
 * The project shell's routes (doc 26 §2): `mw/{project}[/{type}[/{id}]]`, each route string ⇄
 * NavigationState ⇄ panel key.
 */

import { describe, test, expect } from 'bun:test'
import { isCompoundRoute, parseRouteToNavigationState, buildRouteFromNavigationState } from '../route-parser'
import { getNavigationStateKey, parseNavigationStateKey, isProjectShellNavigation } from '../types'
import { routes } from '../routes'
import { ALL_PROJECTS, packProjectDetail, projectRoute, unpackProjectDetail, type ProjectDetails } from '../project-route'

const CASES: ProjectDetails[] = [
  { type: 'home' },
  { type: 'home', chatId: '261021-apt-marble' },
  { type: 'waiting' },
  { type: 'waiting', itemId: 'step:sr_01|x' },
  { type: 'page', pageId: 'page_01' },
  { type: 'dashboard', domain: 'etmf', pageId: 'tmf-health', params: { study: 'study_mw301' } },
  { type: 'dashboard', domain: 'etmf', pageId: 'tmf-health' },
  { type: 'playbook', workflowId: 'activate-site' },
  { type: 'run', caseId: 'case_01' },
  { type: 'record', entity: 'etmf.Site', recordId: 'rec:with/slash' },
  { type: 'records', entity: 'etmf.Site' },
  { type: 'settings' },
  { type: 'settings', tab: 'advanced' },
  // Stage 5
  { type: 'cr', crId: 'CR-014' },
  { type: 'audit' },
  { type: 'audit', entity: 'etmf.Document', recordId: 'doc:101' },
  { type: 'tmf' },
  { type: 'tmf', zone: 'site-management' },
  { type: 'settings', tab: 'inspectors' },
]

describe('project shell routes', () => {
  test('the builders', () => {
    expect(routes.view.project('etmf')).toBe('mw/etmf')
    expect(routes.view.project('etmf', { type: 'home' })).toBe('mw/etmf')
    expect(routes.view.project('etmf', { type: 'waiting' })).toBe('mw/etmf/waiting')
    expect(routes.view.project('etmf', { type: 'record', entity: 'etmf.Site', recordId: 's1' })).toBe('mw/etmf/record/etmf.Site%3As1')
    expect(routes.view.project(ALL_PROJECTS, { type: 'waiting' })).toBe('mw/*/waiting')
    expect(isCompoundRoute('mw/etmf')).toBe(true)
  })

  test('pack and unpack every detail', () => {
    for (const d of CASES) expect(unpackProjectDetail(d.type, packProjectDetail(d))).toEqual(d)
    expect(unpackProjectDetail('record', 'no-colon')).toBeNull()
    expect(unpackProjectDetail('playbook', '')).toBeNull()
    expect(unpackProjectDetail('nope', 'x')).toBeNull()
  })

  test('route ⇄ navigation state ⇄ panel key, in a project and across all projects', () => {
    for (const projectId of ['etmf', 'my project', ALL_PROJECTS]) {
      for (const d of CASES) {
        const route = projectRoute(projectId, d)
        const state = parseRouteToNavigationState(route)
        expect(state && isProjectShellNavigation(state)).toBe(true)
        expect(state).toMatchObject({ navigator: 'mw', view: { projectId, details: d } })
        expect(buildRouteFromNavigationState(state!)).toBe(route)
        const key = getNavigationStateKey(state!)
        expect(parseNavigationStateKey(key)).toMatchObject({ navigator: 'mw', view: { projectId, details: d } })
      }
    }
  })

  test('malformed routes parse to nothing', () => {
    for (const bad of ['mw', 'mw/etmf/nope', 'mw/etmf/record', 'mw/etmf/record/x', 'mw/etmf/a/b/c', 'mw/%E0%A4%A']) {
      expect(parseRouteToNavigationState(bad)).toBeNull()
    }
  })
})
