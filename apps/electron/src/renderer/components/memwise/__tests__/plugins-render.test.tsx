/**
 * Render smoke tests for the Plugins screens: the list with binding badges, the Install dialog's
 * choices, the plugin overview, the binding review in the inbox (edit and review), the identity
 * match card, and a record with its links, from sample data with the real translations.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import {
  sampleBindingInbox, sampleBindingReviewInbox, sampleBindingView, sampleEntityRecord, sampleEntityRows, sampleEntityTypes,
  sampleIdentityInbox, samplePluginDetail, samplePlugins,
} from '../plugins/sample-plugins'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { InboxItemView } = await import('../InboxItemView')
type InboxActions = import('../InboxItemView').InboxActions
const { PluginsList } = await import('../plugins/PluginsList')
const { PluginHero, PluginOverview } = await import('../plugins/PluginView')
const { BindingReview } = await import('../plugins/BindingReview')
const { RecordsTable, RecordView } = await import('../plugins/RecordsView')
const { versionOrigin } = await import('../playbook/VersionLine')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const NOW = Date.parse('2026-10-20T12:00:00Z')
const ok = async () => ({ applied: true })
const actions: InboxActions = {
  submitStep: ok, decideApproval: ok, sendEvent: ok, openCase: () => {}, openPlugin: () => {}, decideIdentity: ok,
  writeDraft: async () => ({ applied: true, diagnostics: [] }),
}
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)

describe('plugins list', () => {
  test('binding badges, the upgrade first, records under the plugins', () => {
    const html = render(<PluginsList plugins={samplePlugins} entityTypes={sampleEntityTypes} onSelect={() => {}} onSelectEntity={() => {}} onInstall={() => {}} />)
    expect(html).toContain('Being bound')
    expect(html).toContain('Newer version available')
    expect(html).toContain('Not bound')
    expect(html).toContain('provides crm.contacts')
    expect(html).toContain('data-list-group="records"')
    expect(html).toContain('data-entity="Customer"')
    expect(html).toContain('data-action="install-plugin"')
    // Being bound, then the upgrade, then unbound
    expect(html.indexOf('memwise/sample-crm')).toBeLessThan(html.indexOf('memwise/client-intake'))
    expect(html.indexOf('memwise/client-intake')).toBeLessThan(html.indexOf('claude/notes'))
  })
})

describe('plugin page', () => {
  test('tools with their class and where it came from', () => {
    const html = render(<PluginOverview plugin={samplePluginDetail} now={NOW} />)
    expect(html).toContain('data-class-from="annotations"')
    expect(html).toContain('from the MCP hints')
    expect(html).toContain('chosen by the binder agent')
    expect(html).toContain('not classified: treated as irreversible')
    expect(html).toContain('CRM follow-up')
    expect(html).toContain('Not bound yet.')
  })

  test('the hash reads as a hash, and a binding shows the date it was frozen, not "2 hours ago"', () => {
    const digits = { ...samplePluginDetail, hash: '1401404584580dd8f39409c88eeadde1403ed8d944fd771dd78343e1ac4890a8' }
    const html = render(<PluginOverview plugin={digits} now={NOW} />)
    expect(html).toContain('1401404584580dd8…')
    expect(html).toContain(`title="${digits.hash}"`)
    const hero = render(<PluginHero plugin={{ ...samplePluginDetail, binding: { status: 'bound', version: 1, pluginVersion: '1.0.0', frozenAt: '2026-10-21T09:00:00Z' } }} now={Date.parse('2026-10-21T11:00:00Z')} />)
    expect(hero).toContain('bound Oct 21, 2026')
    expect(hero).not.toContain('ago')
  })
})

describe('binding review', () => {
  test('edit mode in the inbox: gaps, mapping with before and after, Done', () => {
    const html = render(<InboxItemView item={sampleBindingInbox} actions={actions} bindingView={sampleBindingView} now={NOW} />)
    expect(html).toContain('data-binding-mode="edit"')
    expect(html).toContain('Finish binding Sample CRM')
    expect(html).toContain('2 things to settle before binding')
    expect(html).toContain('data-mapping-table')
    expect(html).toContain('Acme Traders')
    expect(html).toContain('29abcde1234f1z5')
    expect(html).toContain('data-outcome="done"')
    expect(html).toContain('data-binding-actions')
  })

  test('review mode: read-only, Approve and Ask for changes', () => {
    const html = render(<InboxItemView item={sampleBindingReviewInbox} actions={actions} bindingView={{ ...sampleBindingView, editable: false }} now={NOW} />)
    expect(html).toContain('data-binding-mode="review"')
    expect(html).toContain('data-outcome="approved"')
    expect(html).toContain('Ask for changes')
    expect(html).not.toContain('data-choice=')
  })

  test('fix after "Ask for changes": the reviewer\'s comment shows above the binding', () => {
    const fix = {
      ...sampleBindingReviewInbox, id: 'in_bind_fix2', stepRunId: 'sr_bind_fix2', stepTitle: 'Fix the binding', outcomes: ['done'],
      binding: { ...sampleBindingReviewInbox.binding!, mode: 'edit' as const },
      returned: { stepTitle: 'Review the binding', outcome: 'changes_requested', text: 'Keep outbound mail on approval.' },
    }
    const html = render(<InboxItemView item={fix} actions={actions} bindingView={sampleBindingView} now={NOW} />)
    expect(html).toContain('data-returned')
    expect(html).toContain('Keep outbound mail on approval.')
    expect(html).toContain('data-binding-mode="edit"')
  })

  test('a plugin playbook\'s version line names the binding', () => {
    const t = i18n.t.bind(i18n)
    const origin = { kind: 'plugin' as const, plugin: 'memwise/client-intake', pluginTitle: 'Client intake', pluginVersion: '1.0.0', bindingVersion: 2 }
    const v = { version: 1, hash: 'h', publishedAt: '2026-10-20T08:00:00Z', source: 'files' as const, openCases: 0, live: true }
    expect(versionOrigin({ ...v, origin }, t)).toBe('from Client intake 1.0.0 · binding 2')
    expect(versionOrigin(v, t, 'en', NOW)).toBe('changed in the files Oct 20')
  })

  test('loading, before the binding arrives', () => {
    const html = render(<InboxItemView item={sampleBindingInbox} actions={actions} bindingView={null} now={NOW} />)
    expect(html).toContain('Loading the binding...')
  })

  test('the plugin page shows the live binding read-only', () => {
    const html = render(<BindingReview view={{ ...sampleBindingView, editable: false, draftId: undefined }} mode="view" now={NOW} />)
    expect(html).toContain('Sample records')
    expect(html).not.toContain('data-choice=')
  })
})

describe('identity match', () => {
  test('side by side, with the fields that differ marked', () => {
    const html = render(<InboxItemView item={sampleIdentityInbox} actions={actions} now={NOW} />)
    expect(html).toContain('Same customer?')
    expect(html).toContain('Is this the same customer as in Sample CRM?')
    expect(html).toContain('82%')
    expect(html).toContain('data-same="true"')
    expect(html).toContain('data-same="false"')
    expect(html).toContain('data-same="unknown"')
    expect(html).toContain('data-decision="confirm"')
    expect(html).toContain('data-decision="reject"')
  })
})

describe('records', () => {
  test('rows carry source badges; a record shows read-through values and links', () => {
    const rows = render(<RecordsTable entity="Customer" rows={sampleEntityRows} fields={sampleEntityTypes[0]!.fields} onOpen={() => {}} />)
    expect(rows).toContain('Sample CRM · contact')
    const detail = render(<RecordView record={sampleEntityRecord} now={NOW} />)
    expect(detail).toContain('data-read-through="email"')
    expect(detail).toContain('ops@acme.example')
    expect(detail).toContain('Matched on a key')
    expect(detail).toContain('c-101')
  })
})
