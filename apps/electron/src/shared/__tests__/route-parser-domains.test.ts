/**
 * Phase 6 domains routes: record pages, entities, dashboards, automations and domain pages, each
 * route string ⇄ NavigationState ⇄ panel key.
 */

import { describe, test, expect } from 'bun:test'
import { isCompoundRoute, parseRouteToNavigationState, buildRouteFromNavigationState } from '../route-parser'
import { getNavigationStateKey, parseNavigationStateKey, isDomainsNavigation } from '../types'
import { routes } from '../routes'
import { domainsRoute, packDomainsDetail, unpackDomainsDetail, type DomainsDetails } from '../domains-route'

const CASES: DomainsDetails[] = [
  { type: 'record', entity: 'etmf.site', recordId: 'site_us012' },
  { type: 'record', entity: 'etmf.document', recordId: 'doc:with/slash' },
  { type: 'entities', domain: 'etmf' },
  { type: 'entities', domain: 'etmf', entity: 'etmf.site' },
  { type: 'dashboard', domain: 'etmf', pageId: 'tmf-health', params: { study: 'study_ast301' } },
  { type: 'dashboard', domain: 'etmf', pageId: 'inspection-prep' },
  { type: 'automations' },
  { type: 'automations', domain: 'etmf' },
  { type: 'domain', domain: 'etmf' },
  { type: 'domain', domain: 'etmf', tab: 'rules' },
]

describe('domains routes', () => {
  test('the builders', () => {
    expect(routes.view.domains()).toBe('domains')
    expect(routes.view.record('etmf.site', 'site_us012')).toBe('domains/record/etmf.site%3Asite_us012')
    expect(isCompoundRoute('domains')).toBe(true)
    expect(isCompoundRoute(routes.view.record('etmf.site', 's'))).toBe(true)
  })

  test('pack and unpack every detail', () => {
    for (const d of CASES) {
      const { type, id } = packDomainsDetail(d)
      expect(unpackDomainsDetail(type, id)).toEqual(d)
    }
    expect(unpackDomainsDetail('nope', 'x')).toBeNull()
  })

  test('route ⇄ navigation state ⇄ panel key', () => {
    for (const d of [null, ...CASES]) {
      const route = domainsRoute(d)
      const state = parseRouteToNavigationState(route)
      expect(state && isDomainsNavigation(state)).toBe(true)
      expect(state).toMatchObject({ navigator: 'domains', details: d })
      expect(buildRouteFromNavigationState(state!)).toBe(route)
      const key = getNavigationStateKey(state!)
      expect(parseNavigationStateKey(key)).toMatchObject({ navigator: 'domains', details: d })
    }
  })
})
