/**
 * Render smoke tests: the inbox detail (each kind), the case view and the step record render
 * from sample data with the real translations, and show what a person needs to act.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import type { MwInboxItem } from '@memwise/shared/protocol'
import {
  sampleCase,
  sampleExplanation,
  sampleInbox,
  samplePeople,
  samplePlaybook,
  sampleRoles,
  sampleStepRecord,
} from '../sample-data'

// The markdown renderer pulls in the PDF block: pdf.js needs a browser and its worker is a Vite asset.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { InboxItemView } = await import('../InboxItemView')
type InboxActions = import('../InboxItemView').InboxActions
const { CaseView } = await import('../CaseView')
const { StepRecordView } = await import('../StepRecordView')
const { ActingAsSwitcherView } = await import('../MemwiseStatus')
const { peopleById } = await import('../format')
const { startFields } = await import('../StartCaseDialog')

beforeAll(() => {
  setupI18n([initReactI18next])
  void i18n.changeLanguage('en')
})

const NOW = Date.parse('2026-10-20T12:00:00Z')
const people = peopleById(samplePeople)
const ok = async () => ({ applied: true })
const actions: InboxActions = { submitStep: ok, decideApproval: ok, sendEvent: ok, openCase: () => {}, uploadFile: async f => ({ id: 'x', name: f.name, mime: f.type, size: f.size, sha256: '' }) }

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const item = (kind: MwInboxItem['kind']) => sampleInbox.find(i => i.kind === kind)!

describe('inbox item', () => {
  test('input: a generated form with prefill and a submit button', () => {
    const html = render(<InboxItemView item={item('input')} actions={actions} people={people} now={NOW} />)
    expect(html).toContain('Client fills in the intake form')
    expect(html).toContain('data-kind="identifier"')
    expect(html).toContain('placeholder="ABCDE1234F"')
    expect(html).toContain('data-kind="money"')
    expect(html).toContain('data-kind="documents"')
    expect(html).toContain('value="Acme Traders"')
    expect(html).toContain('Choose files')
    expect(html).toContain('>Submit<')
  })

  test('decision: instructions, context with provenance, approve and send back', () => {
    const html = render(<InboxItemView item={item('decision')} actions={actions} people={people} roles={sampleRoles} now={NOW} />)
    expect(html).toContain('>approve</strong>')
    expect(html).toContain('Typed by Priya Shah')
    expect(html).toContain('From a document')
    expect(html).toContain('data-outcome="approved"')
    expect(html).toContain('Send back')
    expect(html).toContain('For Manager')
  })

  test('approval: the email preview and the reason', () => {
    const html = render(<InboxItemView item={item('approval')} actions={actions} now={NOW} />)
    expect(html).toContain('data-preview="email"')
    expect(html).toContain('One detail in your intake form')
    expect(html).toContain('Outbound needs approval (domain policy)')
    expect(html).toContain('>Approve<')
    expect(html).toContain('>Reject<')
  })

  test('attention and reminder', () => {
    const attention = render(<InboxItemView item={item('attention')} actions={actions} now={NOW} />)
    expect(attention).toContain('The GST lookup did not answer three times.')
    expect(attention).toContain('Mark as resolved')
    const reminder = render(<InboxItemView item={item('reminder')} actions={actions} now={NOW} />)
    expect(reminder).toContain('has not finished the intake form')
    expect(reminder).toContain('Open case')
  })
})

describe('case view', () => {
  test('header, fields with provenance, map path and timeline', () => {
    const html = render(<CaseView kase={sampleCase} playbook={samplePlaybook} people={people} roles={sampleRoles} onOpenStep={() => {}} now={NOW} />)
    expect(html).toContain('Ravi Menon')
    expect(html).toContain('Now: Manager approves onboarding')
    expect(html).toContain('Waiting on Manager')
    expect(html).toContain('data-provenance="person"')
    expect(html).toContain('data-provenance="tool"')
    expect(html).toContain('data-provenance="tainted"')
    expect(html).toContain('data-provenance="hidden"')
    expect(html).toContain('pan-card.pdf')
    expect(html).toContain('data-step-run="sr_check_2"')
    expect(html).toContain('<svg')
  })

  test('without the playbook the map falls back to the path', () => {
    const html = render(<CaseView kase={sampleCase} now={NOW} />)
    expect(html).toContain('data-map-placeholder')
    expect(html).toContain('fill → check → verify')
  })
})

describe('step record', () => {
  test('outcome, outputs, checks, usage and an answer with citations', () => {
    const html = render(<StepRecordView record={sampleStepRecord} people={people} explanations={[sampleExplanation]} onAsk={() => {}} onOpenChat={() => {}} />)
    expect(html).toContain('This step read uploaded documents')
    expect(html).toContain('every flag names the document it came from')
    expect(html).toContain('Tools used')
    expect(html).toContain('Why was this flagged?')
    expect(html).toContain('Read fields from pan-card.pdf')
    expect(html).toContain('Open in chat')
  })

  test('suggestion chip before anything is asked', () => {
    const html = render(<StepRecordView record={sampleStepRecord} onAsk={() => {}} />)
    expect(html).toContain('Why was this flagged?')
  })
})

describe('acting as', () => {
  test('shows the current person', () => {
    const html = render(<ActingAsSwitcherView me={samplePeople[1]} people={samplePeople} roles={sampleRoles} onSelect={() => {}} />)
    expect(html).toContain('Acting as')
    expect(html).toContain('Arjun Rao')
  })
})

describe('start a case', () => {
  test('offers the fields people enter, not the ones steps write', () => {
    expect(startFields(samplePlaybook).map(f => f.name)).toEqual(['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents', 'status'])
    expect(startFields(samplePlaybook).every(f => !f.required)).toBe(true)
  })
})
