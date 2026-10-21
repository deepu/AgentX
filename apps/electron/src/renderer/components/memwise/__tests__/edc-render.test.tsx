/**
 * Stage 6 screens (docs/memwise/26-projects-and-pages.md §9) rendered with the real English
 * strings: the EDC study home (XEdcHome), "Also in other apps", and site 104's facts, each with the
 * app that owns it and a jump to the other app (XSite).
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import type { MwEdcHome, MwLinkedRecord, MwRecordField, MwRecordPage, MwStudyApps } from '@memwise/shared/protocol'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { EdcHomeView, AlsoInOtherAppsView } = await import('../edc/EdcHomeView')
const { RecordFactsByAppView, OwnerTag, OpenInAppButton } = await import('../edc/OwnerTags')
const { factsByApp, otherApps, ownerTone, barWidth } = await import('../edc/edc-model')
const { isEdcApp, queriesPageId } = await import('../edc/EdcProjectHome')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const NOW = Date.parse('2026-10-21T09:06:00Z')
const RAVE = 'memwise/medidata-rave'

const site = (n: string, randomised: number, target: number, old = 0) => ({
  site: { entity: 'edc.Site', id: `edcs_${n}`, title: `${n} · Site ${n}` }, number: n, randomised, target,
  percent: Math.round((randomised / target) * 100), openQueries: old + 3, oldQueries: old,
})

const home: MwEdcHome = {
  domain: 'edc',
  study: { key: 'MW-301', name: 'Meriglutide once weekly (phase 3)', record: { entity: 'edc.Study', id: 'edcst_1', title: 'MW-301 · Meriglutide' } },
  source: { plugin: RAVE, title: 'Medidata Rave', at: '2026-10-21T09:00:00Z', nextDue: '2026-10-21T09:15:00Z' },
  randomised: { value: 186, target: 300, plannedByNow: 190 },
  queries: { open: 142, old: 23, olderThanDays: 14 },
  pagesVerified: 91,
  waiting: { total: 1, items: [{ kind: 'approval', caseId: 'case_1', workflowId: 'chase-old-queries', workflowTitle: 'Chase old queries', count: 5, since: '2026-10-21T08:00:00Z' }] },
  sites: [site('104', 7, 12, 9), site('109', 10, 14, 8), site('102', 21, 25, 3), site('101', 24, 25)],
}

const apps: MwStudyApps = {
  study: { key: 'MW-301' },
  apps: [{
    domain: 'etmf', domainName: 'eTMF', record: { entity: 'etmf.Study', id: 'stud_1', title: 'MW-301 · Meriglutide' },
    facts: [{ name: 'tmf_complete', label: 'Tmf complete', type: 'Percentage', value: 98 }], shares: ['Sites'],
  }],
}

const field = (name: string, label: string, value: unknown, source: MwRecordField['source'], extra: Partial<MwRecordField> = {}): MwRecordField =>
  ({ name, label, type: 'Text', value, source, editable: false, ...extra })

const edcSite: Pick<MwRecordPage, 'domain' | 'domainName' | 'entity' | 'id' | 'fields'> = {
  domain: 'edc', domainName: 'EDC', entity: 'edc.Site', id: 'edcs_104',
  fields: [
    field('principal_investigator', 'Principal investigator', 'Dr Jonas Weber', { kind: 'plugin', plugin: RAVE, title: 'Medidata Rave', asOf: '2026-10-21T09:00:00Z' }),
    field('coordinator', 'Coordinator', 'Lena Hoffmann', { kind: 'plugin', plugin: RAVE, title: 'Medidata Rave' }),
    field('randomised', 'Randomised', 7, { kind: 'calculated' }, { type: 'Number', calculated: true }),
    field('old_queries', 'Old queries', 9, { kind: 'calculated' }, { type: 'Number', calculated: true }),
    field('pi_email', 'Pi email', null, { kind: 'plugin', plugin: RAVE }),
  ],
}

const etmfSite: MwLinkedRecord = {
  domain: 'etmf', domainName: 'eTMF', entity: 'etmf.Site', id: 'site_104', title: '104 · Kliniken am Stadtpark', status: 'open',
  fields: [
    field('start_up_pack_complete', 'Start up pack complete', 61, { kind: 'calculated' }, { type: 'Percentage', calculated: true }),
    field('activated_on', 'Activated on', '2026-03-02', { kind: 'person', personId: 'tom', name: 'Tom Ellis' }, { type: 'Date' }),
  ],
}

describe('the EDC study home', () => {
  test('Rave read only and when it was read; randomised against plan, queries, pages verified', () => {
    const html = render(<EdcHomeView home={home} apps={apps} now={NOW} onOpenRecord={() => {}} onOpenCase={() => {}} />)
    expect(html).toContain('data-edc-home="MW-301"')
    expect(html).toContain('Study MW-301')
    expect(html).toContain('EDC · connected to Medidata Rave, read only · synced 6 minutes ago')
    expect(html).toContain('of 300 · plan was 190 by now')
    expect(html).toContain('23 older than 14 days')
    expect(html).toContain('91%')
    expect(html).toContain('Data entry stays in Medidata Rave. MemWise reads it and chases it.')
  })

  test('what waits, grouped by case, and randomised by site with the bar to scale', () => {
    const html = render(<EdcHomeView home={home} apps={apps} now={NOW} onOpenRecord={() => {}} onOpenCase={() => {}} />)
    expect(html).toContain('Waiting for you')
    expect(html).toContain('Chase old queries')
    expect(html).toContain('5 to approve')
    expect(html).toContain('Randomised against target, by site')
    expect(html).toContain('data-site="104"')
    expect(html).toContain('7 of 12')
    expect(html).toContain('width:58%')
    expect(html).toContain('Also in other apps')
  })

  test('a failed read says so; no connector says so; nothing waiting says so', () => {
    const failed = render(<EdcHomeView home={{ ...home, source: { ...home.source!, error: 'Medidata Rave refused the sign-in', errorAt: '2026-10-21T09:05:00Z' } }} apps={null} now={NOW} onOpenRecord={() => {}} onOpenCase={() => {}} />)
    expect(failed).toContain('data-sync-error')
    expect(failed).toContain('Medidata Rave refused the sign-in')
    const none = render(<EdcHomeView home={{ ...home, source: null, waiting: { total: 0, items: [] } }} apps={null} now={NOW} onOpenRecord={() => {}} onOpenCase={() => {}} />)
    expect(none).toContain('EDC · no connector reads this study yet')
    expect(none).toContain('Nothing is waiting for you.')
    expect(none).not.toContain('Also in other apps')
  })
})

describe('Also in other apps', () => {
  test('the same study in eTMF, with its headline and what the apps share', () => {
    const html = render(<AlsoInOtherAppsView apps={apps} onOpenRecord={() => {}} />)
    expect(html).toContain('data-other-app="etmf"')
    expect(html).toContain('Same study in eTMF')
    expect(html).toContain('98%')
    expect(html).toContain('Shares sites with this project')
    expect(render(<AlsoInOtherAppsView apps={{ study: { key: 'MW-301' }, apps: [] }} onOpenRecord={() => {}} />)).toContain('MW-301 is not in another app yet.')
  })
})

describe('one site in two apps', () => {
  test('each fact tagged with the app that owns it; the other app\'s read only with a jump', () => {
    const facts = factsByApp(edcSite, [etmfSite])
    expect(facts.map((f) => `${f.name}:${f.owner.name}:${f.elsewhere}`)).toEqual([
      'principal_investigator:EDC:false', 'coordinator:EDC:false', 'randomised:EDC:false', 'old_queries:EDC:false',
      'start_up_pack_complete:eTMF:true', 'activated_on:eTMF:true',
    ])
    expect(facts.find((f) => f.name === 'start_up_pack_complete')!.open).toEqual({ entity: 'etmf.Site', id: 'site_104' })
    expect(otherApps(edcSite, [etmfSite])).toEqual([{ domain: 'etmf', name: 'eTMF', entity: 'etmf.Site', id: 'site_104' }])

    const html = render(<RecordFactsByAppView page={edcSite} linked={[etmfSite]} onOpenRecord={() => {}} />)
    expect(html).toContain('One record, each fact owned by one app')
    expect(html).toContain('Open in eTMF')
    expect(html).toContain('data-fact-owner="edc"')
    expect(html).toContain('data-fact-owner="etmf"')
    expect(html).toContain('data-elsewhere="true"')
    expect(html).not.toContain('data-fact="pi_email"') // empty values are left out
  })

  test('from eTMF: the followed facts are EDC\'s, with "Open in EDC"', () => {
    const page = {
      domain: 'etmf', domainName: 'eTMF', entity: 'etmf.Site', id: 'site_104',
      fields: [
        field('coordinator', 'Coordinator', 'Lena Hoffmann', { kind: 'link', domain: 'edc', domainName: 'EDC', entity: 'edc.Site', recordId: 'edcs_104' }, { followed: true }),
        field('start_up_pack_complete', 'Start up pack complete', 61, { kind: 'calculated' }, { type: 'Percentage', calculated: true }),
      ],
    }
    const facts = factsByApp(page, [])
    expect(facts.find((f) => f.name === 'coordinator')).toMatchObject({ owner: { domain: 'edc', name: 'EDC' }, elsewhere: true, open: { entity: 'edc.Site', id: 'edcs_104' } })
    const html = render(<RecordFactsByAppView page={page} linked={[]} onOpenRecord={() => {}} />)
    expect(html).toContain('Open in EDC')
    // A record in one app only shows nothing extra.
    expect(render(<RecordFactsByAppView page={{ ...page, fields: [page.fields[1]!] }} linked={[]} onOpenRecord={() => {}} />)).toBe('')
  })

  test('the tag and the button on their own', () => {
    expect(render(<OwnerTag app={{ domain: 'edc', name: 'EDC' }} />)).toContain('Owned by EDC')
    expect(render(<OpenInAppButton app={{ domain: 'etmf', name: 'eTMF' }} onOpen={() => {}} />)).toContain('Open in eTMF')
    expect(ownerTone('edc')).toBe(ownerTone('edc'))
    expect([barWidth(undefined), barWidth(58), barWidth(130)]).toEqual([0, 58, 100])
  })
})

describe('the EDC app in the project shell', () => {
  const ent = (key: string) => ({ key, entity: key, title: key.split('.')[1]!, count: 1 })
  const domain = (id: string, entities: string[], pages: string[] = []) => ({
    id, name: id.toUpperCase(), regulated: false, entities: entities.map(ent), workflows: [], views: [], flags: 0,
    pages: pages.map(p => ({ id: p, title: p })),
  })

  test('an app with a Study, Sites and Queries gets the study home; others keep the plain one', () => {
    expect(isEdcApp(domain('edc', ['edc.Study', 'edc.Site', 'edc.Query', 'edc.Subject']))).toBe(true)
    expect(isEdcApp(domain('etmf', ['etmf.Study', 'etmf.Site', 'etmf.Document']))).toBe(false)
    expect(isEdcApp(null)).toBe(false)
  })

  test('the queries page (XQueries) is the one for old queries, else any queries page', () => {
    expect(queriesPageId(domain('edc', [], ['enrolment', 'old-queries']))).toBe('old-queries')
    expect(queriesPageId(domain('edc', [], ['enrolment', 'open-queries']))).toBe('open-queries')
    expect(queriesPageId(domain('edc', [], ['enrolment']))).toBeUndefined()
  })
})
