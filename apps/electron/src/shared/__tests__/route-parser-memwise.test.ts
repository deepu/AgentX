/**
 * MemWise route round-trips (inbox, cases, playbooks): route string ⇄ NavigationState ⇄ panel key.
 * Mirrors route-parser-pages.test.ts: prefix list, parse, build, convert, key serialization, guards.
 */

import { describe, test, expect } from 'bun:test'
import {
  isCompoundRoute,
  parseCompoundRoute,
  buildCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import {
  getNavigationStateKey,
  parseNavigationStateKey,
  isInboxNavigation,
  isCasesNavigation,
  isPlaybooksNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('memwise route builders', () => {
  test('emit the section prefixes', () => {
    expect(routes.view.inbox()).toBe('inbox')
    expect(routes.view.inbox('inb_1')).toBe('inbox/item/inb_1')
    expect(routes.view.cases()).toBe('cases')
    expect(routes.view.cases('case_1')).toBe('cases/case/case_1')
    expect(routes.view.playbooks()).toBe('playbooks')
    expect(routes.view.playbooks('client-intake')).toBe('playbooks/playbook/client-intake')
  })

  test('encode ids with reserved characters', () => {
    expect(routes.view.inbox('approval:apr/1')).toBe('inbox/item/approval%3Aapr%2F1')
  })

  test('are compound route prefixes', () => {
    for (const r of ['inbox', 'inbox/item/x', 'cases', 'cases/case/x', 'playbooks', 'playbooks/playbook/x']) {
      expect(isCompoundRoute(r)).toBe(true)
    }
  })
})

describe('memwise route parsing', () => {
  test('bare sections have no detail', () => {
    expect(parseCompoundRoute('inbox')).toEqual({ navigator: 'inbox', details: null })
    expect(parseRouteToNavigationState('inbox')).toEqual({ navigator: 'inbox', details: null })
    expect(parseRouteToNavigationState('cases')).toEqual({ navigator: 'cases', details: null })
    expect(parseRouteToNavigationState('playbooks')).toEqual({ navigator: 'playbooks', details: null })
  })

  test('detail routes', () => {
    expect(parseCompoundRoute('inbox/item/inb_1')).toEqual({
      navigator: 'inbox',
      details: { type: 'item', id: 'inb_1' },
    })
    const inbox = parseRouteToNavigationState('inbox/item/inb_1')
    expect(inbox).toEqual({ navigator: 'inbox', details: { type: 'inboxItem', itemId: 'inb_1' } })
    expect(inbox && isInboxNavigation(inbox)).toBe(true)

    const kase = parseRouteToNavigationState('cases/case/case_9')
    expect(kase).toEqual({ navigator: 'cases', details: { type: 'case', caseId: 'case_9' } })
    expect(kase && isCasesNavigation(kase)).toBe(true)

    const pb = parseRouteToNavigationState('playbooks/playbook/client-intake')
    expect(pb).toEqual({ navigator: 'playbooks', details: { type: 'playbook', playbookId: 'client-intake' } })
    expect(pb && isPlaybooksNavigation(pb)).toBe(true)
  })

  test('decodes encoded ids', () => {
    expect(parseRouteToNavigationState(routes.view.inbox('approval:apr/1'))).toEqual({
      navigator: 'inbox',
      details: { type: 'inboxItem', itemId: 'approval:apr/1' },
    })
  })

  test('rejects malformed routes', () => {
    expect(parseCompoundRoute('inbox/unknown')).toBeNull()
    expect(parseCompoundRoute('inbox/item')).toBeNull()
    expect(parseCompoundRoute('cases/item/x')).toBeNull()
    expect(parseCompoundRoute('playbooks/playbook/x/extra')).toBeNull()
    expect(parseCompoundRoute('cases/case/%E0%A4%A')).toBeNull()
  })

  test('parseRoute gives view routes', () => {
    expect(parseRoute('inbox')).toEqual({ type: 'view', name: 'inbox', params: {} })
    expect(parseRoute('cases/case/c1')).toEqual({ type: 'view', name: 'cases-info', id: 'c1', params: {} })
  })

  test('query tails never leak into ids', () => {
    expect(parseRouteToNavigationState('cases/case/c1?x=y')).toEqual({
      navigator: 'cases',
      details: { type: 'case', caseId: 'c1' },
    })
  })
})

describe('memwise round trips', () => {
  const samples = [
    'inbox',
    'inbox/item/inb_1',
    routes.view.inbox('approval:apr/1'),
    'cases',
    'cases/case/case_9',
    'playbooks',
    'playbooks/playbook/client-intake',
  ]

  test('route ⇄ navigation state', () => {
    for (const route of samples) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('buildCompoundRoute', () => {
    expect(buildCompoundRoute({ navigator: 'inbox', details: null })).toBe('inbox')
    expect(buildCompoundRoute({ navigator: 'cases', details: { type: 'case', id: 'a b' } })).toBe('cases/case/a%20b')
  })

  test('navigation state ⇄ panel key', () => {
    const states: NavigationState[] = [
      { navigator: 'inbox', details: null },
      { navigator: 'inbox', details: { type: 'inboxItem', itemId: 'approval:apr_1' } },
      { navigator: 'cases', details: null },
      { navigator: 'cases', details: { type: 'case', caseId: 'case_9' } },
      { navigator: 'playbooks', details: null },
      { navigator: 'playbooks', details: { type: 'playbook', playbookId: 'client-intake' } },
    ]
    for (const state of states) {
      expect(parseNavigationStateKey(getNavigationStateKey(state))).toEqual(state)
    }
    expect(getNavigationStateKey(states[3]!)).toBe('cases/case/case_9')
  })
})
