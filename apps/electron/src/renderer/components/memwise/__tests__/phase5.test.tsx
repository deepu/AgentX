/**
 * Phase 5 screens: the case's client link panel, the provenance of what the client typed or a
 * document said, the invite approval's message preview, reading documents into the staff form,
 * and Settings → Public address. Models are tested as they are; screens render from sample data
 * with the real translations.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import type { MwExternalLink, MwExtractSuggestion, MwField } from '@memwise/shared/protocol'
import {
  sampleCaseFields, sampleChannels, sampleClientCase, sampleExtractInput, sampleInviteApproval, sampleNotify, samplePeople,
  sampleRelayStatus, sampleSuggestions,
} from '../sample-data'
import {
  canSendAgain, clientLinkGroups, linkEvents, linkState, openClientLink, participantFor, participantLine, resendVia,
} from '../client-link-model'
import {
  activeSource, applySuggestions, documentIds, formValueEquals, mergeSuggestions, offersFor, submitSources,
} from '../extract-model'
import { messageShape } from '../MessagePreview'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { InboxItemView } = await import('../InboxItemView')
type InboxActions = import('../InboxItemView').InboxActions
const { ClientLinkPanel } = await import('../ClientLinkPanel')
type ClientLinkActions = import('../ClientLinkPanel').ClientLinkActions
const { CaseView } = await import('../CaseView')
const { PublicAddressView, normalizeWhatsapp, validRelayUrl } = await import('../PublicAddress')
const { peopleById, provenanceBadge } = await import('../format')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const t = ((key: string, opts?: Record<string, unknown>) => i18n.t(key, opts)) as Parameters<typeof provenanceBadge>[1]
const NOW = Date.parse('2026-10-20T12:00:00Z')
const people = peopleById(samplePeople)
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const ok = async () => ({ applied: true })
const linkActions: ClientLinkActions = {
  issue: async () => ({ linkId: 'lnk_3', url: 'https://k7q2m4x6p3r5s2t6.relay.memwise.app/f/mwl_x', expiresAt: '2026-10-27T00:00:00Z' }) as never,
  previewResend: async () => ({ message: 'not yet' }),
  resend: ok,
  revoke: ok,
}
const lnk = (over: Partial<MwExternalLink> = {}): MwExternalLink => ({ ...sampleClientCase.links![0]!, ...over })

describe('client link model', () => {
  test('an open link past its time reads as expired', () => {
    expect(linkState(lnk(), NOW)).toBe('open')
    expect(linkState(lnk({ expiresAt: '2026-10-20T11:00:00Z' }), NOW)).toBe('expired')
    expect(linkState(lnk({ status: 'used' }), NOW)).toBe('used')
  })

  test('events tell the story oldest first, ending with how long it works', () => {
    const keys = linkEvents(lnk(), sampleClientCase.deliveries, NOW).map(e => e.key.split('.').pop())
    expect(keys).toEqual(['sent', 'note', 'opened', 'draftSaved', 'worksUntil'])
    const used = linkEvents(sampleClientCase.links![1]!, sampleClientCase.deliveries, NOW).map(e => e.key.split('.').pop())
    expect(used).toEqual(['sent', 'read', 'opened', 'submitted'])
  })

  test('a copied link that was never opened says so', () => {
    const keys = linkEvents(lnk({ via: 'copy', firstOpenedAt: undefined, lastOpenedAt: undefined, draftSavedAt: undefined, note: undefined }), [], NOW)
      .map(e => e.key.split('.').pop())
    expect(keys).toEqual(['copied', 'notOpened', 'worksUntil'])
  })

  test('a failed message is shown as failed, a second one as sent again', () => {
    const events = linkEvents(lnk({ note: undefined }), [
      { id: 'd1', channel: 'email', to: 'a@b.example', purpose: 'invite', linkId: 'lnk_2', status: 'failed', error: 'Mailbox full', at: '2026-10-20T04:42:00Z' },
      { id: 'd2', channel: 'whatsapp', to: '+919845012345', purpose: 'invite', linkId: 'lnk_2', status: 'sent', at: '2026-10-20T05:00:00Z' },
    ], NOW)
    expect(events[0]).toMatchObject({ key: 'memwise.clientLink.event.failed', tone: 'destructive', params: { error: 'Mailbox full' } })
    expect(events[1]!.key).toBe('memwise.clientLink.event.sentAgain')
  })

  test('groups by step, newest link first; the open link is the one the case waits on', () => {
    const groups = clientLinkGroups(sampleClientCase)
    expect(groups.map(g => g.stepId)).toEqual(['fill'])
    expect(groups[0]!.links.map(l => l.id)).toEqual(['lnk_2', 'lnk_1'])
    expect(groups[0]!.waiting?.stepRunId).toBe('sr_fill_22')
    expect(openClientLink(sampleClientCase, NOW)?.id).toBe('lnk_2')
    expect(openClientLink({ ...sampleClientCase, status: 'done' }, NOW)).toBeUndefined()
  })

  test('who a new link is for, and how "Send again" sends', () => {
    expect(participantLine({ name: 'Asha Rao', email: 'asha@raotraders.example' })).toBe('Asha Rao · asha@raotraders.example')
    expect(participantFor(sampleClientCase, { links: [] })).toEqual({ name: 'Asha Rao', email: 'asha@raotraders.example', phone: '+919845012345' })
    expect(resendVia(lnk({ via: 'copy' }))).toBe('email')
    expect(resendVia(lnk({ via: 'copy', participant: { phone: '+91' } }))).toBe('whatsapp')
    expect(canSendAgain(lnk({ via: 'copy', participant: {} }), NOW)).toBe(false)
    expect(canSendAgain(lnk({ status: 'used' }), NOW)).toBe(false)
  })
})

describe('reading documents into a form', () => {
  const fields = sampleCaseFields.filter(f => ['pan', 'gstin', 'client_name', 'documents'].includes(f.name))
  const pan = fields.find(f => f.name === 'pan') as MwField

  test('a confident suggestion fills an empty field; a doubtful one is only offered', () => {
    const next = applySuggestions(fields, { values: {}, sources: {} }, sampleSuggestions)
    expect(next.filled).toEqual(['pan'])
    expect(next.values.pan).toBe('AAACR1234A')
    expect(next.sources).toEqual({ pan: 'sg_1' })
    const gstin = fields.find(f => f.name === 'gstin')!
    expect(offersFor(gstin, next.values.gstin, sampleSuggestions).map(s => s.id)).toEqual(['sg_2'])
    expect(offersFor(pan, next.values.pan, sampleSuggestions)).toEqual([])
  })

  test('never overwrites what someone typed, but replaces an earlier suggestion', () => {
    const typed = applySuggestions(fields, { values: { pan: 'AAACM9999Z' }, sources: {} }, sampleSuggestions)
    expect(typed.filled).toEqual([])
    expect(typed.values.pan).toBe('AAACM9999Z')
    expect(offersFor(pan, typed.values.pan, sampleSuggestions).map(s => s.id)).toEqual(['sg_1'])

    const newer: MwExtractSuggestion = { ...sampleSuggestions[0]!, id: 'sg_3', value: 'AAACR5678B', confidence: 0.97 }
    const all = mergeSuggestions(sampleSuggestions, [newer])
    const again = applySuggestions(fields, { values: { pan: 'AAACR1234A' }, sources: { pan: 'sg_1' } }, [newer], all)
    expect(again.values.pan).toBe('AAACR5678B')
    expect(again.sources.pan).toBe('sg_3')
  })

  test('sources name only values still as read (case and spacing aside for identifiers)', () => {
    expect(formValueEquals({ name: 'pan', label: 'PAN', kind: 'identifier', required: true } as never, ' aaacr 1234a ', 'AAACR1234A')).toBe(true)
    const sources = { pan: 'sg_1', gstin: 'sg_2' }
    expect(submitSources(fields, { pan: 'AAACR1234A', gstin: '29AAACR0000A1Z5' }, sources, sampleSuggestions)).toEqual({ pan: 'sg_1' })
    expect(activeSource(pan, 'AAACR1234A', sources, sampleSuggestions)?.document).toBe('pan-card.pdf')
    expect(activeSource(pan, 'AAACM9999Z', sources, sampleSuggestions)).toBeUndefined()
  })

  test('document ids come only from uploaded files', () => {
    expect(documentIds({ documents: [{ id: 'file_pan', name: 'pan-card.pdf' }, { name: 'local.pdf' }] } as never, 'documents')).toEqual(['file_pan'])
    expect(documentIds({}, 'documents')).toEqual([])
  })
})

describe('provenance badges (Phase 5)', () => {
  test('what the client typed says so', () => {
    const b = provenanceBadge(sampleClientCase.values.gstin!, t, people)
    expect(b).toMatchObject({ tone: 'external', text: 'Typed by the client' })
    expect(b.detail).toContain('Asha Rao')
  })

  test('a value read from a document names it and how sure the reading was', () => {
    const b = provenanceBadge(sampleClientCase.values.pan!, t, people)
    expect(b).toMatchObject({ tone: 'tainted', text: 'From pan-card.pdf · 93%' })
    expect(b.detail).toContain('Read from pan-card.pdf')
  })
})

describe('message previews', () => {
  test('an invite, an email and a WhatsApp message are messages to someone', () => {
    expect(messageShape('external.invite', sampleInviteApproval.kind === 'approval' ? sampleInviteApproval.preview.detail : null))
      .toMatchObject({ channel: 'email', to: 'Asha Rao <asha@raotraders.example>', subject: 'Acme & Co. needs a few details from you' })
    expect(messageShape('whatsapp.send', { to: '+919845012345', text: 'Hello' })).toMatchObject({ channel: 'whatsapp', body: 'Hello' })
    expect(messageShape('crm.update', { id: 1 })).toBeNull()
  })
})

describe('public address helpers', () => {
  test('WhatsApp numbers become E.164', () => {
    expect(normalizeWhatsapp('+91 98450-12345')).toBe('+919845012345')
    expect(normalizeWhatsapp('98450 12345')).toBeNull()
    expect(normalizeWhatsapp('+0123')).toBeNull()
  })

  test('relay addresses are http(s) without a sign-in', () => {
    expect(validRelayUrl('https://relay.memwise.app')).toBe(true)
    expect(validRelayUrl('http://localhost:8787')).toBe(true)
    expect(validRelayUrl('ftp://relay.example')).toBe(false)
    expect(validRelayUrl('https://me:pw@relay.example')).toBe(false)
    expect(validRelayUrl('relay.example')).toBe(false)
  })
})

describe('Phase 5 screens render', () => {
  test('client link panel: each link, its story, and what can be done', () => {
    const html = render(<ClientLinkPanel kase={sampleClientCase} actions={linkActions} people={people} now={NOW} />)
    expect(html).toContain('data-client-links="fill"')
    expect(html).toContain('data-link="lnk_2"')
    expect(html).toContain('data-link-state="open"')
    // the used link is folded under "1 earlier link"
    expect(html).not.toContain('data-link-state="used"')
    expect(html).toContain('1 earlier link')
    expect(html).toContain('Copy link')
    expect(html).toContain('data-action="send-again"')
    expect(html).toContain('data-action="revoke"')
    expect(html).toContain('Asha Rao · asha@raotraders.example')
    expect(html).toContain('Please upload a clearer GST certificate.')
  })

  test('client link panel is read-only without actions, and absent with no external steps', () => {
    const html = render(<ClientLinkPanel kase={sampleClientCase} people={people} now={NOW} />)
    expect(html).not.toContain('data-action="revoke"')
    expect(render(<ClientLinkPanel kase={{ ...sampleClientCase, links: [], timeline: [] }} now={NOW} />)).toBe('')
  })

  test('the case view shows the panel and badges for the client’s values', () => {
    const html = render(<CaseView kase={sampleClientCase} people={people} now={NOW} linkActions={linkActions} />)
    expect(html).toContain('data-client-links="fill"')
    expect(html).toContain('Typed by the client')
    expect(html).toContain('From pan-card.pdf · 93%')
  })

  test('invite approval: the exact message and who gets it', () => {
    const actions: InboxActions = { submitStep: ok, decideApproval: ok, sendEvent: ok, openCase: () => {} }
    const html = render(<InboxItemView item={sampleInviteApproval} actions={actions} people={people} now={NOW} />)
    expect(html).toContain('data-preview="message"')
    expect(html).toContain('data-channel="email"')
    expect(html).toContain('Send the form link to Asha Rao &lt;asha@raotraders.example&gt;?')
    expect(html).toContain('Acme &amp; Co. needs a few details from you')
  })

  test('staff form: "Read the documents" when the step can, and not otherwise', () => {
    const extract = async () => ({ suggestions: sampleSuggestions, read: ['file_pan'] }) as never
    const base: InboxActions = { submitStep: ok, decideApproval: ok, sendEvent: ok, openCase: () => {} }
    const html = render(<InboxItemView item={sampleExtractInput} actions={{ ...base, extract }} people={people} now={NOW} />)
    expect(html).toContain('data-extract')
    expect(html).toContain('data-action="read-documents"')
    expect(render(<InboxItemView item={sampleExtractInput} actions={base} people={people} now={NOW} />)).not.toContain('data-action="read-documents"')
  })

  test('public address: relay state, channels and notifications', () => {
    const html = render(<PublicAddressView relay={sampleRelayStatus} channels={sampleChannels} notify={sampleNotify} personName="Priya Shah" onConfigure={async () => sampleRelayStatus} onSetNotify={async s => s} />)
    expect(html).toContain('data-relay-state="connected"')
    expect(html).toContain('https://k7q2m4x6p3r5s2t6.relay.memwise.app')
    expect(html).toContain('data-channel="email" data-bound="yes"')
    expect(html).toContain('data-channel="whatsapp" data-bound="no"')
    expect(html).toContain('data-notify-whatsapp')
  })

  test('public address on an older server says so', () => {
    expect(render(<PublicAddressView relay={null} channels={null} notify={null} unsupported />)).toContain('data-public-address="unsupported"')
  })
})
