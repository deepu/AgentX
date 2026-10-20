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
const { PluginOverview } = await import('../plugins/PluginView')
const { BindingReview } = await import('../plugins/BindingReview')
const { RecordsTable, RecordView } = await import('../plugins/RecordsView')

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
