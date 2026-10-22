import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InspectorPageDocument, InspectorPageIndex, InspectorTrailEntry } from '@memwise/defs/external'
import { parseRoute } from '../route'
import { inspectorApi, isInspectorRefusal } from '../api'
import { documentLine, trailWhat, trailWho } from '../inspector-model'
import { InspectorRefusalPage, InspectorView } from '../InspectorPage'

const index: InspectorPageIndex = {
  session: { linkId: 'insp_1', project: 'etmf', projectName: 'eTMF', name: 'MHRA inspection', inspector: 'Inspector, MHRA', expiresAt: '2026-11-18T18:00:00Z' },
  zones: [
    { id: 'trial-management', number: '01', name: 'Trial Management', filed: 0 },
    { id: 'site-management', number: '05', name: 'Site Management', filed: 4 },
  ],
  sites: [{ id: 's101', label: '101' }, { id: 's104', label: '104' }],
}

const doc: InspectorPageDocument = {
  entity: 'etmf.Document', id: 'docu_1', title: 'Protocol signature page, site 101', zone: '05', site: { id: 's101', label: '101' },
  artifact: 'Protocol signature page', status: 'filed', version: 2, filedAt: '2026-10-06T10:42:00Z',
  signatures: [{ name: 'Tom Okafor', meaning: 'Reviewed and approved for filing', at: '2026-10-06T10:42:00Z', changedSince: false }],
  file: { id: 'file_1', name: 'protocol-signature-101.pdf', mime: 'application/pdf', size: 52_000, sha256: 'ab'.repeat(32) },
  values: [{ field: 'artifact', label: 'Artifact', value: 'Protocol signature page' }],
}

const entry = (over: Partial<InspectorTrailEntry>): InspectorTrailEntry => ({
  seq: 1, id: 'aud_1', at: '2026-09-29T11:03:00Z', actorKind: 'person', actor: 'p1', actorLabel: 'Tom Okafor', action: 'record.created',
  entity: 'etmf.Document', recordId: 'docu_1', caseId: null, data: {}, prevHash: '0', hash: '1', ...over,
})

describe('an inspector\'s view (Stage 5)', () => {
  test('the route: /v/<token> under any base', () => {
    expect(parseRoute('/v/mwi_abc')).toEqual({ kind: 'inspector', token: 'mwi_abc', api: '/v/mwi_abc/api' })
    expect(parseRoute('/x/abcdefghijklmnop/v/mwi_abc/')).toMatchObject({ kind: 'inspector', api: '/x/abcdefghijklmnop/v/mwi_abc/api' })
    expect(parseRoute('/f/mwl_1')).toMatchObject({ kind: 'form' })
  })

  test('the API: plain GETs with their filters, the download a plain link', () => {
    const api = inspectorApi('/v/t/api')
    expect(api.downloadUrl('etmf.Document', 'docu 1')).toBe('/v/t/api/download?entity=etmf.Document&id=docu+1')
    expect(isInspectorRefusal({ refused: 'expired' })).toBe(true)
    expect(isInspectorRefusal({ documents: [] })).toBe(false)
  })

  test('trail entries in words: the AI names its model and the words it relied on', () => {
    const ai = entry({ actorKind: 'ai', actor: 'step', actorLabel: null, action: 'step.completed', stepTitle: 'Classify and index it',
      data: { step: 'classify', outcome: 'classified', model: 'claude-sonnet-5-5', quote: 'Protocol version 2.0' } })
    expect(trailWho(ai)).toEqual({ text: 'AI check · claude-sonnet-5-5', ai: true })
    expect(trailWhat(ai)).toBe('Classify and index it: classified · relied on “Protocol version 2.0”')
    expect(trailWhat(entry({ action: 'record.changed', data: { version: 2, changed: ['document_date'], reason: 'signed copy' } })))
      .toBe('Changed document date · v2 · reason: signed copy')
    expect(trailWhat(entry({ action: 'signature.signed', data: { meaning: 'Reviewed and approved for filing' } }))).toBe('Signed · Reviewed and approved for filing')
    expect(trailWho(entry({ actorKind: 'system', actor: 'system', actorLabel: null }))).toEqual({ text: 'System', ai: false })
    expect(documentLine(doc)).toBe('Site 101 · v2 · signed 6 Oct')
  })

  test('renders the zones, the zone\'s documents, the document and its signature; says what is not shown', () => {
    const html = renderToStaticMarkup(
      <InspectorView index={index} api={inspectorApi('/v/t/api')} onRefused={() => {}} initial={{ zone: '05', documents: [doc], total: 61, selected: doc, requests: [
        { id: 'q1', question: 'Training records for the site 104 coordinator', askedAt: '2026-10-20T09:00:00Z', answer: 'Attached to the site file.', answeredBy: { id: 'p', name: 'Tom Okafor' }, answeredAt: '2026-10-20T10:20:00Z' },
        { id: 'q2', question: 'Why was the site 109 ethics letter filed late?', askedAt: '2026-10-21T09:00:00Z' },
      ] }} />,
    )
    expect(html).toContain('eTMF · Trial master file')
    expect(html).toContain('Read only · every view and download is logged')
    expect(html).toContain('Inspector, MHRA · access ends')
    expect(html).toContain('05 · Site Management')
    expect(html).toContain('Protocol signature page, site 101')
    expect(html).toContain('Showing 1 of 61')
    expect(html).toContain('Signed by Tom Okafor')
    expect(html).toContain('Part 11 signature · version 2 locked')
    expect(html).toContain('href="/v/t/api/download?entity=etmf.Document&amp;id=docu_1"')
    expect(html).toContain('Ask the study team')
    expect(html).toContain('answered by Tom Okafor')
    expect(html).toContain('with the study team')
    expect(html).toContain('Drafts, chats and AI suggestions are not shown.')
  })

  test('renders the audit trail tab with the chain\'s state', () => {
    const html = renderToStaticMarkup(
      <InspectorView index={index} api={inspectorApi('/v/t/api')} onRefused={() => {}} initial={{ zone: '05', documents: [doc], selected: doc, requests: [],
        trail: [entry({}), entry({ id: 'aud_2', seq: 2, actorKind: 'ai', actorLabel: null, action: 'step.completed', data: { step: 'classify', outcome: 'classified', model: 'm-1', quote: 'Protocol' } })] }} />,
    )
    expect(html).toContain('data-trail')
    expect(html).toContain('AI check · m-1')
    expect(html).toContain('relied on “Protocol”')
    expect(html).toContain('data-chain="ok"')
  })

  test('a link that ended, was turned off, or is unknown', () => {
    expect(renderToStaticMarkup(<InspectorRefusalPage refusal={{ refused: 'expired' }} />)).toContain('This inspection link has ended')
    expect(renderToStaticMarkup(<InspectorRefusalPage refusal={{ refused: 'revoked' }} />)).toContain('turned off')
    expect(renderToStaticMarkup(<InspectorRefusalPage refusal={{ refused: 'unknown' }} />)).toContain('We couldn’t find this inspection')
  })
})
