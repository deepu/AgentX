/**
 * Stage 5 screens rendered from the sample data with the real English strings: a change request
 * (open, with QA, live), the audit trail (an AI entry naming its model and quote; verify ok and
 * tampered), inspector access (a new link, the list, questions), the TMF index and a zone, the
 * Stage 5 inbox items, the regulated domain's links, and the display helpers.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { ChangeRequestView, AuditTrailView, InspectorSetupView, TmfIndexView } = await import('../regulated')
const { RegulatedDomainLinksView, keepsTmf } = await import('../regulated/RegulatedDomainLinks')
const { InboxItemView } = await import('../InboxItemView')
type InboxActions = import('../InboxItemView').InboxActions
const M = await import('../regulated/regulated-model')
const S = await import('../regulated/sample-regulated')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const count = (html: string, needle: string) => html.split(needle).length - 1
const t = i18n.t.bind(i18n) as unknown as import('i18next').TFunction
const noop = async () => ({})

describe('change request (EChange)', () => {
  const actions = {
    saveReason: noop, validate: async () => S.sampleChangeRequest.validations[1]!, sign: async () => ({ applied: true, status: 'applied' }),
    withdraw: noop, openChat: () => {}, openCase: () => {},
  }

  test('open: what changes with strikeouts, the reason, two validation runs, the sign-offs, Send to QA', () => {
    const html = render(<ChangeRequestView cr={S.sampleChangeRequest} actions={actions} signer={{ name: 'Anika Rao', role: 'Study manager' }} />)
    expect(html).toContain('data-change-request="CR-014"')
    expect(html).toContain('Change request CR-014')
    expect(html).toContain('Playbooks › File a document › Change request CR-014')
    expect(html).toContain('regulated project (Part 11)')
    expect(html).toContain('drafted from chat')
    // The diff: removed text struck out, added text underlined
    expect(html).toContain('<del class="text-tertiary line-through" data-diff="removed">QC by the TMF lead</del>')
    expect(html).toContain('data-diff="added">, and for CVs, signed and dated</ins>')
    expect(html).toContain('AI check added: A CV is signed and dated')
    expect(count(html, 'data-step=')).toBe(3)
    expect(html).toContain('data-change="same"')
    expect(html).toContain('TMF lead')
    expect(html).toContain('Agent')
    // The reason is editable while open
    expect(html).toContain('QC of CVs repeats the AI check')
    expect(html).toContain('<textarea')
    // Validation: the first run 41 of 42, the second 42 of 42 (each named), the mismatch of the latest run none
    expect(html).toContain('Validation run, on 42 CVs filed in September')
    expect(html).toContain('First run')
    expect(html).toContain('Second run')
    expect(html).toContain('41 of 42 match QC by the TMF lead<')
    expect(html).toContain('42 of 42 match QC by the TMF lead<')
    expect(html).toContain('on an earlier draft')
    expect(html).not.toContain('data-mismatch=')
    expect(html).toContain('Ready to send to QA')
    // Sign-off: Anika (study manager, raised the change) waiting; Grace (QA) not yet
    expect(html).toContain('Anika Rao · study manager · raised the change')
    expect(html).toContain('Grace Lee · QA')
    expect(html).toContain('data-signoff="raiser" data-status="waiting"')
    // Footer: goes live as v3, v2 keeps running, its open cases finish on it
    expect(html).toContain('Goes live as version 3 once QA signs. Version 2 keeps running until then.')
    expect(html).toContain('5 cases running on version 2 finish on it.')
    expect(html).toContain('data-action="send"')
    expect(html).toContain('Send to QA')
    expect(html).toContain('data-action="withdraw"')
    expect(html).toContain('data-action="chat"')
    expect(html).not.toContain('data-action="approve"')
  })

  test('a failed run lists the case that differs and why', () => {
    const failed = { ...S.sampleChangeRequest, validations: [S.sampleChangeRequest.validations[0]!], validation: { passed: 41, total: 42, status: 'failed' as const, current: false } }
    const html = render(<ChangeRequestView cr={failed} actions={actions} />)
    expect(html).toContain('data-mismatch="case_cv_109"')
    expect(html).toContain('CV · Dr Okafor · site 109')
    expect(html).toContain('the AI checks passed it, but Tom Okafor chose “sent back”')
    expect(html).toContain('“Not signed”')
    expect(html).not.toContain('Ready to send to QA')
    expect(html).toContain('Run again')
  })

  test('with QA: read-only, Approve and make live; published: closed note, no actions', () => {
    const qa = render(<ChangeRequestView cr={S.sampleChangeRequestForQa} actions={actions} />)
    expect(qa).toContain('With QA')
    expect(qa).toContain('data-action="approve"')
    expect(qa).toContain('Approve and make live')
    expect(qa).not.toContain('data-action="send"')
    expect(qa).not.toContain('<textarea')
    expect(qa).not.toContain('data-action="validate"')
    expect(qa).toMatch(/data-signoff="raiser" data-status="signed".*Signed Oct 21, 2026/)

    const live = render(<ChangeRequestView cr={S.samplePublishedChangeRequest} actions={actions} />)
    expect(live).toContain('data-closed="published"')
    expect(live).toContain('Live as version 3 since Oct 21, 2026, signed by Grace Lee.')
    expect(live).not.toContain('data-action=')
    expect(live).not.toContain('data-goes-live')
  })

  test("a sign result maps to the signing form's codes", () => {
    expect(M.signResultForForm({ applied: false, status: 'signature-failed' })).toEqual({ applied: false, code: 'submit.signature-failed' })
    expect(M.signResultForForm({ applied: false, status: 'locked', retryAfter: '2026-10-21T12:15:00Z' })).toEqual({ applied: false, code: 'submit.locked', retryAfter: '2026-10-21T12:15:00Z' })
    expect(M.signResultForForm({ applied: false, status: 'not-validated', message: 'x' })).toEqual({ applied: false, code: 'change.not-validated', message: 'x' })
    expect(M.signResultForForm({ applied: true, status: 'applied' })).toEqual({ applied: true })
    expect(t('memwise.result.change.not-validated')).toBe('Run the validation on the draft as it is now first.')
  })
})

describe('audit trail (EAudit)', () => {
  test('one record: its chip, people and AI, the AI entry with model and quote, export and verify', () => {
    const html = render(
      <AuditTrailView
        projectName="Study MW-301"
        log={S.sampleAuditLog}
        scope={{ label: 'Protocol signature page, site 101', onClear: () => {} }}
        peopleAndAi
        onPeopleAndAi={() => {}}
        onExport={noop}
        onVerify={async () => S.sampleVerifyOk}
      />,
    )
    expect(html).toContain('data-audit-trail')
    expect(html).toContain('Study MW-301 › Project settings › Audit trail')
    expect(html).toContain('Every change in Study MW-301, by people and AI · append-only, each entry chained to the one before')
    expect(html).toContain('data-scope')
    expect(html).toContain('Protocol signature page, site 101')
    expect(html).toContain('aria-pressed="true"')
    expect(count(html, 'data-entry=')).toBe(6)
    // The AI entry: its badge, its model, the rule it flagged and the sentence it relied on
    expect(html).toContain('data-ai')
    expect(html).toContain('AI check · Sonnet 5.5')
    expect(html).toContain('Flagged at AI checks: Protocol version matches: “Protocol version 2.0”')
    // A person's step with its reason; an upload by link; a signature; the export
    expect(html).toContain('QC: sent back · reason: signed against protocol 2.0')
    expect(html).toContain('Site coordinator, 101')
    expect(html).toContain('Created v1')
    expect(html).toContain('Changed file (v2)')
    expect(html).toContain('Signed · approved for filing · Part 11')
    expect(html).toContain('Exported this trail (9 entries)')
    expect(html).toContain('data-action="export"')
    expect(html).toContain('Export for inspectors')
    expect(html).toContain('data-action="verify"')
    expect(html).toContain('Entries can&#x27;t be edited or deleted.')
  })

  test('verify: ok, and a tampered export names the entry', () => {
    const ok = render(<AuditTrailView projectName="Study MW-301" log={S.sampleAuditLog} peopleAndAi={false} initialVerify={S.sampleVerifyOk} />)
    expect(ok).toContain('data-verify="ok"')
    expect(ok).toContain('The chain holds: 9 entries, none changed or missing.')
    expect(ok).toContain('aria-pressed="false"')
    const bad = render(<AuditTrailView projectName="Study MW-301" log={{ ...S.sampleAuditLog, chain: { ok: false } }} peopleAndAi={false} initialVerify={S.sampleVerifyTampered} />)
    expect(bad).toContain('data-verify="failed"')
    expect(bad).toContain('Entry 4 was changed after it was written.')
    expect(bad).toContain('data-chain-broken')
  })

  test('the whole project names each entry\'s record; an empty trail says so', () => {
    const html = render(<AuditTrailView projectName="Study MW-301" log={S.sampleAuditLog} peopleAndAi={false} openRecord={() => {}} />)
    expect(html).not.toContain('data-scope')
    expect(count(html, '>Protocol signature page, site 101</button>')).toBe(5)
    const empty = render(<AuditTrailView projectName="Study MW-301" log={{ entries: [], chain: { ok: true } }} peopleAndAi={false} />)
    expect(empty).toContain('Nothing in the trail yet.')
  })
})

describe('inspector access', () => {
  test('the list: views, downloads, status, extend and revoke; questions open first with an answer box', () => {
    const html = render(
      <InspectorSetupView
        projectName="Study MW-301"
        links={S.sampleInspectorLinks}
        questions={S.sampleInspectorQuestions}
        actions={{ create: async () => ({ link: S.sampleInspectorLinks[0]!, token: 'mwi_x' }), revoke: noop, extend: noop, answer: noop }}
        now={S.SAMPLE_NOW}
      />,
    )
    expect(html).toContain('Inspector access')
    expect(html).toContain('never drafts, chats or AI suggestions')
    expect(html).toContain('data-link="il_1" data-status="active"')
    expect(html).toContain('GCP inspector, MHRA; Dr J. Patel, MHRA')
    expect(html).toContain('12 views · 3 downloads')
    expect(html).toContain('data-link="il_0" data-status="revoked"')
    expect(html).toContain('Access ended')
    expect(count(html, 'data-action="revoke"')).toBe(1)
    expect(count(html, 'data-action="extend"')).toBe(1)
    expect(html).toContain('data-action="new-link"')
    expect(html).not.toContain('data-link-form')
    // Questions: the open one first, with its record and an answer box; the answered one with its answer
    expect(html.indexOf('data-question="iq_2"')).toBeLessThan(html.indexOf('data-question="iq_1"'))
    expect(html).toContain('Why was version 1 of the signature page sent back?')
    expect(html).toContain('data-action="answer"')
    expect(html).toContain('Filed in zone 05 on 12 Oct')
    expect(html).toContain('data-answered="true"')
  })

  test('a new link: the form (name, inspectors, end date); the link shown once', () => {
    const form = render(<InspectorSetupView projectName="Study MW-301" links={[]} questions={[]} actions={{ create: async () => ({ link: S.sampleInspectorLinks[0]!, token: 'mwi_x' }) }} suggestedName="MHRA inspection" now={S.SAMPLE_NOW} />)
    expect(form).toContain('data-link-form')
    expect(form).toContain('value="MHRA inspection"')
    expect(form).toContain('data-field="inspectors"')
    expect(form).toContain('type="date"')
    expect(form).toContain('value="2026-11-04"')
    expect(form).toContain('No inspector has access yet.')

    const made = render(
      <InspectorSetupView
        projectName="Study MW-301"
        links={S.sampleInspectorLinks}
        questions={[]}
        actions={{ copy: async () => {} }}
        initialCreated={{ link: S.sampleInspectorLinks[0]!, token: 'mwi_abc', url: 'https://ws.example.com/v/mwi_abc' }}
        now={S.SAMPLE_NOW}
      />,
    )
    expect(made).toContain('data-created="il_1"')
    expect(made).toContain('The link for MHRA inspection is ready')
    expect(made).toContain('https://ws.example.com/v/mwi_abc')
    expect(made).toContain('It is shown only now.')
    const noAddress = render(<InspectorSetupView projectName="x" links={[]} questions={[]} initialCreated={{ link: S.sampleInspectorLinks[0]!, token: 'mwi_abc' }} now={S.SAMPLE_NOW} />)
    expect(noAddress).toContain('mwi_abc')
    expect(noAddress).toContain('no public address yet')
  })

  test('parsing the inspectors and the end date', () => {
    expect(M.parseInspectors('GCP inspector, MHRA\n\nJane Doe <jane@mhra.gov.uk>, MHRA\nSolo')).toEqual([
      { name: 'GCP inspector', organisation: 'MHRA' },
      { name: 'Jane Doe', email: 'jane@mhra.gov.uk', organisation: 'MHRA' },
      { name: 'Solo' },
    ])
    expect(M.endOfDayIso('2026-11-18')).toBe(new Date(2026, 10, 18, 23, 59).toISOString())
    expect(M.endOfDayIso('18/11/2026')).toBeNull()
  })
})

describe('TMF index (EIndex)', () => {
  test('the index: four numbers and the 11 zones, each a sub-page', () => {
    const html = render(<TmfIndexView index={S.sampleTmfIndex} onZone={() => {}} />)
    expect(html).toContain('Pages › TMF index')
    expect(html).toContain('data-live')
    expect(html).toContain('Built from the TMF Reference Model · expected documents come from the plan of Study MW-301')
    expect(html).toMatch(/data-kpi="Filed".*1,809.*of 1,840 expected/)
    expect(html).toMatch(/data-kpi="Missing".*23.*all requested/)
    expect(html).toMatch(/data-kpi="Waiting for QC".*8.*oldest 4 days/)
    expect(html).toMatch(/data-kpi="Filed late".*31.*over 30 days after final/)
    expect(count(html, 'data-zone=')).toBe(11)
    expect(html).toContain('05 · Site management')
    expect(html).toContain('04 · IRB/IEC and other approvals')
    expect(html).toContain('Zone (each is a sub-page)')
    expect(html).not.toContain('data-unplaced')
  })

  test('a zone: its sites, what is missing, its documents (late, in QC); unplaced artifacts', () => {
    const html = render(<TmfIndexView index={S.sampleTmfZone} onZone={() => {}} openRecord={() => {}} />)
    expect(html).toContain('data-tmf-zone="site-management"')
    expect(html).toContain('Pages › TMF index › 05 · Site management')
    expect(count(html, 'data-site=')).toBe(3)
    expect(html).toContain('data-missing-item="exp_109_cv"')
    expect(count(html, 'data-document=')).toBe(3)
    expect(html).toContain('data-filed-late')
    expect(html).toContain('in QC 4 days')
    expect(html).toContain('data-action="back"')
    const index = render(<TmfIndexView index={{ ...S.sampleTmfIndex, unplaced: ['Site visit photo'] }} />)
    expect(index).toContain('1 artifact has no zone yet')
    expect(index).toContain('Site visit photo')
  })

  test('zone names are translated by id, with the model\'s name otherwise', () => {
    expect(M.zoneName({ id: 'site-management', name: 'Site Management' }, t)).toBe('Site management')
    expect(M.zoneName({ id: 'unknown-zone', name: 'Unknown Zone' }, t)).toBe('Unknown Zone')
  })
})

describe('inbox items and the domain page', () => {
  const actions: InboxActions = {
    submitStep: async () => ({ applied: true }), decideApproval: async () => ({ applied: true }), sendEvent: async () => ({ applied: true }),
    openCase: () => {}, openChangeRequest: () => {}, answerInspectorQuestion: noop, openRecord: () => {},
  }

  test('a change request waiting for QA', () => {
    const html = render(<InboxItemView item={S.sampleChangeRequestItem} actions={actions} now={S.SAMPLE_NOW} />)
    expect(html).toContain('Change request')
    expect(html).toContain('data-change-request-item="CR-014"')
    expect(html).toContain('data-signoff="qa"')
    expect(html).toContain('42 of 42 match')
    expect(html).toContain('Your QA signature makes this change live as the next version.')
    expect(html).toContain('data-action="open-change-request"')
  })

  test("an inspector's question, answered from the inbox", () => {
    const html = render(<InboxItemView item={S.sampleInspectorQuestionItem} actions={actions} now={S.SAMPLE_NOW} />)
    expect(html).toContain("Inspector&#x27;s question")
    expect(html).toContain('Asked through the MHRA inspection link.')
    expect(html).toContain('Why was version 1 of the signature page sent back?')
    expect(html).toContain('data-action="answer"')
  })

  test("a regulated domain's links: TMF index, audit trail, inspector access, its change requests", () => {
    const domain = {
      id: 'etmf', name: 'eTMF', regulated: true, flags: 0, workflows: [], pages: [], views: [],
      entities: [{ key: 'etmf.Document', entity: 'etmf.Document', title: 'Documents', count: 4 }, { key: 'etmf.ExpectedDocument', entity: 'etmf.ExpectedDocument', title: 'Expected', count: 5 }],
    }
    expect(keepsTmf(domain)).toBe(true)
    expect(keepsTmf({ entities: [domain.entities[0]!] })).toBe(false)
    const html = render(<RegulatedDomainLinksView domain={domain} changeRequests={[S.sampleChangeRequestItem.changeRequest]} navigation={{}} />)
    expect(html).toContain('data-open="tmf"')
    expect(html).toContain('data-open="audit"')
    expect(html).toContain('data-open="inspectors"')
    expect(html).toContain('CR-014 · Stop the QC step for CVs that pass every AI check')
    expect(html).toContain('With QA')
  })
})
