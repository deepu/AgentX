/**
 * Sample Stage 5 data for render tests and previews, following the mocks: CR-014 on "File a
 * document" (EChange), the trail of a protocol signature page (EAudit), the MHRA inspection's link
 * (EInspector), and the TMF index of Study MW-301 (EIndex).
 */

import type {
  MwAuditEntry, MwAuditLog, MwAuditVerifyResult, MwChangeRequest, MwChangeValidation, MwInboxItem, MwInspectorLink,
  MwInspectorQuestion, MwTmfIndex, MwTmfZoneRow,
} from '@memwise/shared/protocol'

export const SAMPLE_NOW = Date.parse('2026-10-21T12:00:00Z')

const anika = { id: 'p_anika', name: 'Anika Rao' }
const grace = { id: 'p_grace', name: 'Grace Lee' }

const run = (n: 1 | 2, passed: number): MwChangeValidation => ({
  id: `val_${n}`,
  draftHash: n === 1 ? 'sha256:aaa' : 'sha256:bbb',
  current: n === 2,
  setLabel: '42 CVs filed in September',
  total: 42,
  passed,
  checkErrors: 0,
  status: passed === 42 ? 'passed' : 'failed',
  results: n === 1
    ? [{
        caseId: 'case_cv_109', title: 'CV · Dr Okafor · site 109', accepted: false, ai: 'pass', matches: false,
        decided: { stepId: 'qc', outcome: 'sent_back', by: 'Tom Okafor', comment: 'Not signed' },
      }]
    : [{ caseId: 'case_cv_109', title: 'CV · Dr Okafor · site 109', accepted: false, ai: 'fail', matches: true, decided: { stepId: 'qc', outcome: 'sent_back', by: 'Tom Okafor' } }],
  by: anika.id,
  byName: anika.name,
  at: n === 1 ? '2026-10-21T09:10:00Z' : '2026-10-21T09:40:00Z',
})

export const sampleChangeRequest: MwChangeRequest = {
  id: 'cr_014',
  number: 14,
  label: 'CR-014',
  project: 'etmf',
  workflowId: 'file-document',
  playbookTitle: 'File a document',
  title: 'Stop the QC step for CVs that pass every AI check',
  status: 'open',
  raisedBy: anika,
  raisedAt: '2026-10-21T09:00:00Z',
  updatedAt: '2026-10-21T09:40:00Z',
  validation: { passed: 42, total: 42, status: 'passed', current: true },
  draftId: 'draft_cr014',
  draftHash: 'sha256:bbb',
  reason: 'QC of CVs repeats the AI check and holds up site activation. CVs that fail any AI check still go to QC.',
  regulated: true,
  liveVersion: 2,
  nextVersion: 3,
  openCasesOnLive: 5,
  steps: [
    {
      n: 2, stepId: 'ai_checks', change: 'changed', who: { performer: 'agent' }, instructionsChanged: true, outcomesChanged: false,
      title: [{ kind: 'same', text: 'AI checks: right document type, site, version, expiry' }, { kind: 'added', text: ', and for CVs, signed and dated' }],
      rules: [{ kind: 'same', text: 'The site matches' }, { kind: 'added', text: 'A CV is signed and dated' }],
    },
    {
      n: 3, stepId: 'qc', change: 'changed', who: { performer: 'person', role: 'tmf_lead', roleTitle: 'TMF lead' }, instructionsChanged: true, outcomesChanged: false,
      title: [{ kind: 'removed', text: 'QC by the TMF lead' }, { kind: 'added', text: 'QC by the TMF lead, except CVs that pass every AI check' }],
      rules: [],
    },
    {
      n: 4, stepId: 'approve', change: 'same', who: { performer: 'person', role: 'tmf_lead', roleTitle: 'TMF lead' }, instructionsChanged: false, outcomesChanged: false,
      title: [{ kind: 'same', text: 'Approve for filing (Part 11 signature)' }], rules: [],
    },
  ],
  files: [{
    path: 'domains/etmf/workflows/file-document/steps/qc.md', kind: 'step', status: 'modified',
    lines: [{ kind: 'removed', text: 'when: always' }, { kind: 'added', text: "when: artifact != 'Investigator CV' or not checks.passed" }],
  }],
  checks: { errors: 0, warnings: 0, messages: [] },
  validationSet: { label: '42 CVs filed in September' },
  validations: [run(1, 41), run(2, 42)],
  signoffs: [
    { role: 'raiser', roleTitle: 'study manager', person: anika, status: 'waiting', meaning: 'I raised this change and its validation is complete' },
    { role: 'qa', roleId: 'qa', roleTitle: 'QA', person: grace, status: 'not-yet', meaning: 'Approved as the next version of the playbook' },
  ],
  sessionId: 'session_cr014',
  can: { edit: true, validate: true, send: true, approve: false, withdraw: true },
}

/** The same request after Anika signed it: waiting for QA, seen by QA. */
export const sampleChangeRequestForQa: MwChangeRequest = {
  ...sampleChangeRequest,
  status: 'in_review',
  signoffs: [
    { ...sampleChangeRequest.signoffs[0]!, status: 'signed', signedAt: '2026-10-21T10:00:00Z', signatureId: 'sig_1' },
    { ...sampleChangeRequest.signoffs[1]!, status: 'waiting' },
  ],
  can: { edit: false, validate: false, send: false, approve: true, withdraw: false },
}

export const samplePublishedChangeRequest: MwChangeRequest = {
  ...sampleChangeRequestForQa,
  status: 'published',
  toVersion: 3,
  closedAt: '2026-10-21T11:00:00Z',
  closedBy: grace,
  signoffs: [sampleChangeRequestForQa.signoffs[0]!, { ...sampleChangeRequestForQa.signoffs[1]!, status: 'signed', signedAt: '2026-10-21T11:00:00Z' }],
  can: { edit: false, validate: false, send: false, approve: false, withdraw: false },
}

let seq = 0
const entry = (e: Partial<MwAuditEntry> & Pick<MwAuditEntry, 'at' | 'actorKind' | 'actor' | 'action'>): MwAuditEntry => {
  seq += 1
  return {
    seq, id: `ae_${seq}`, project: 'etmf', actorLabel: null, entity: 'etmf.Document', recordId: 'doc_101_sig',
    caseId: null, data: {}, prevHash: `h${seq - 1}`, hash: `h${seq}`, recordTitle: 'Protocol signature page, site 101', ...e,
  }
}

export const sampleAuditLog: MwAuditLog = {
  chain: { ok: true },
  entries: [
    entry({ at: '2026-09-29T11:02:00Z', actorKind: 'external', actor: 'link:site101', actorLabel: 'Site coordinator, 101', action: 'record.created', data: { version: 1 } }),
    entry({
      at: '2026-09-29T11:03:00Z', actorKind: 'ai', actor: 'agent', action: 'step.completed', stepTitle: 'AI checks',
      data: { model: 'Sonnet 5.5', outcome: 'flagged', checkpoint: { failed: ['Protocol version matches'] }, quote: 'Protocol version 2.0', version: 1 },
    }),
    entry({ at: '2026-10-02T09:15:00Z', actorKind: 'person', actor: 'p_tom', actorLabel: 'Tom Okafor', action: 'step.completed', stepTitle: 'QC', data: { outcome: 'sent_back', reason: 'signed against protocol 2.0' } }),
    entry({ at: '2026-10-03T14:40:00Z', actorKind: 'external', actor: 'link:site101', actorLabel: 'Site coordinator, 101', action: 'record.changed', data: { version: 2, changed: ['file'] } }),
    entry({ at: '2026-10-06T10:42:00Z', actorKind: 'person', actor: 'p_tom', actorLabel: 'Tom Okafor', action: 'signature.signed', data: { meaning: 'approved for filing', version: 2 } }),
    entry({ at: '2026-10-21T09:05:00Z', actorKind: 'person', actor: 'p_anika', actorLabel: 'Anika Rao', action: 'audit.exported', entity: null, recordId: null, data: { entries: 9 } }),
  ],
}

export const sampleVerifyOk: MwAuditVerifyResult = { ok: true, entries: 9, chain: { ok: true }, signature: { ok: true, publicKey: 'ed25519:abc' }, message: 'ok' }
export const sampleVerifyTampered: MwAuditVerifyResult = { ok: false, entries: 9, chain: { ok: false, brokenAt: { seq: 4, id: 'ae_4', reason: 'hash' } }, message: 'entry 4 changed' }

export const sampleInspectorLinks: MwInspectorLink[] = [{
  id: 'il_1', project: 'etmf', name: 'MHRA inspection', inspectors: [{ name: 'GCP inspector', organisation: 'MHRA' }, { name: 'Dr J. Patel', organisation: 'MHRA' }],
  expiresAt: '2026-11-18T23:59:00Z', createdBy: anika, createdAt: '2026-10-20T10:00:00Z', firstOpenedAt: '2026-10-21T08:00:00Z', lastOpenedAt: '2026-10-21T10:00:00Z',
  status: 'active', views: 12, downloads: 3, questions: { open: 1, answered: 1 },
}, {
  id: 'il_0', project: 'etmf', name: 'Mock inspection', inspectors: [{ name: 'Priya Shah' }],
  expiresAt: '2026-10-10T23:59:00Z', createdBy: anika, createdAt: '2026-10-01T10:00:00Z', revokedAt: '2026-10-09T10:00:00Z',
  status: 'revoked', views: 4, downloads: 0, questions: { open: 0, answered: 0 },
}]

export const sampleInspectorQuestions: MwInspectorQuestion[] = [{
  id: 'iq_2', linkId: 'il_1', linkName: 'MHRA inspection', project: 'etmf', askedBy: 'GCP inspector',
  record: { entity: 'etmf.Document', id: 'doc_101_sig', title: 'Protocol signature page, site 101' },
  question: 'Why was version 1 of the signature page sent back?', askedAt: '2026-10-21T10:30:00Z',
}, {
  id: 'iq_1', linkId: 'il_1', linkName: 'MHRA inspection', project: 'etmf', askedBy: 'GCP inspector',
  question: 'Where is the delegation log for site 104?', askedAt: '2026-10-21T08:30:00Z',
  answer: 'Filed in zone 05 on 12 Oct; see the site 104 documents.', answeredBy: anika, answeredAt: '2026-10-21T09:00:00Z',
}]

const zone = (number: string, id: string, name: string, expected: number, filed: number, missing: number, inQc: number, filedLate = 0): MwTmfZoneRow =>
  ({ number, id, name, expected, filed, missing, inQc, filedLate })

export const sampleTmfIndex: MwTmfIndex = {
  project: 'etmf',
  study: { id: 'study_mw301', label: 'Study MW-301' },
  kpis: { expected: 1840, filed: 1809, missing: 23, inQc: 8, oldestInQcDays: 4, filedLate: 31, lateAfterDays: 30 },
  zones: [
    zone('01', 'trial-management', 'Trial Management', 142, 142, 0, 0),
    zone('02', 'central-trial-documents', 'Central Trial Documents', 96, 96, 0, 0),
    zone('03', 'regulatory', 'Regulatory', 61, 60, 1, 0),
    zone('04', 'irb-iec-approvals', 'IRB or IEC and other Approvals', 118, 112, 4, 2),
    zone('05', 'site-management', 'Site Management', 702, 682, 14, 6, 31),
    zone('06', 'ip-trial-supplies', 'IP and Trial Supplies', 188, 188, 0, 0),
    zone('07', 'safety-reporting', 'Safety Reporting', 214, 214, 0, 0),
    zone('08', 'central-local-testing', 'Central and Local Testing', 97, 96, 1, 0),
    zone('09', 'third-parties', 'Third Parties', 41, 41, 0, 0),
    zone('10', 'data-management', 'Data Management', 77, 74, 3, 0),
    zone('11', 'statistics', 'Statistics', 104, 104, 0, 0),
  ],
  unplaced: [],
}

export const sampleTmfZone: MwTmfIndex = {
  ...sampleTmfIndex,
  zone: {
    row: sampleTmfIndex.zones[4]!,
    sites: [
      { siteId: 'site_101', label: 'Site 101', expected: 240, filed: 238, missing: 2, inQc: 1 },
      { siteId: 'site_104', label: 'Site 104', expected: 230, filed: 222, missing: 6, inQc: 2 },
      { siteId: 'site_109', label: 'Site 109', expected: 232, filed: 222, missing: 6, inQc: 3 },
    ],
    documents: [
      { entity: 'etmf.Document', id: 'doc_101_sig', title: 'Protocol signature page, site 101', artifact: 'Protocol signature page', site: 'Site 101', status: 'filed', filedLate: false },
      { entity: 'etmf.Document', id: 'doc_104_cv', title: 'CV · Dr Mensah', artifact: 'Investigator CV', site: 'Site 104', status: 'in_qc', filedLate: false, inQcDays: 4 },
      { entity: 'etmf.Document', id: 'doc_109_log', title: 'Delegation log, site 109', artifact: 'Delegation log', site: 'Site 109', status: 'filed', filedLate: true },
    ],
    missing: [{ id: 'exp_109_cv', artifact: 'Investigator CV', site: 'Site 109', dueDate: '2026-10-30' }],
  },
  unplaced: ['Site visit photo'],
}

export const sampleChangeRequestItem: Extract<MwInboxItem, { kind: 'change-request' }> = {
  kind: 'change-request', id: 'cr:cr_014:qa', workflowId: 'file-document', caseTitle: 'CR-014 · Stop the QC step for CVs that pass every AI check',
  stepTitle: 'File a document', signoff: 'qa', since: '2026-10-21T10:00:00Z',
  changeRequest: {
    id: 'cr_014', number: 14, label: 'CR-014', project: 'etmf', workflowId: 'file-document', playbookTitle: 'File a document',
    title: 'Stop the QC step for CVs that pass every AI check', status: 'in_review', raisedBy: anika, raisedAt: '2026-10-21T09:00:00Z',
    updatedAt: '2026-10-21T10:00:00Z', validation: { passed: 42, total: 42, status: 'passed', current: true },
  },
}

export const sampleInspectorQuestionItem: Extract<MwInboxItem, { kind: 'inspector-question' }> = {
  kind: 'inspector-question', id: 'iq:iq_2', caseTitle: sampleInspectorQuestions[0]!.question, stepTitle: 'MHRA inspection',
  question: sampleInspectorQuestions[0]!, since: '2026-10-21T10:30:00Z',
}
