/**
 * Phase 6 kernel shapes → the app API (24 §13): labels in plain words, retention in days, the
 * names behind each field's source, review mode, dashboards, triggers, the audit trail, and the
 * entity definition the Entities page draws.
 */
import { describe, expect, it } from 'bun:test'
import type { AuditTrail, DashboardData, DomainSummary, RecordPage, TriggerSummary } from '@memwise/runtime'
import {
  auditFileName, caseTitle, entityLabel, retentionDays, toAuditTrail, toDashboard, toDomain, toEntityDefinition, toEntityType, toFlagInboxItem,
  toRecordPage, toTrigger, toTriggerHoldInboxItem, toView, toWaiting, triggerDescription, versionByLabel, waitingOn, withRefTitles,
} from '../dto'

const DAY = 24 * 3600_000
const text = { type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text' }

const project = {
  workflows: {
    'file-document': { id: 'file-document', title: 'File a TMF document', domain: 'etmf', caseType: { fields: { document: { type: {}, typeSource: 'Ref<Document>' } } }, steps: {}, states: {}, startsOn: [] },
    'activate-site': { id: 'activate-site', title: 'Activate a site', domain: 'etmf', caseType: { fields: { site: { type: {}, typeSource: 'Ref<Site>' } } }, steps: {}, states: {}, startsOn: [{ kind: 'entered', entity: 'Site', state: 'activating', with: {} }] },
  },
  entities: {},
  plugins: { 'memwise/veeva-ctms': { manifest: { title: 'Veeva CTMS' } } },
  domains: {
    etmf: { id: 'etmf', name: 'eTMF', regulated: true, owner: 'study_manager', acceptsFrom: ['intake'], intake: { address: 'etmf' }, policy: { effects: { outbound: 'approve' } }, dir: 'domains/etmf', entities: [], workflows: [], pages: {}, views: {} },
    edc: { id: 'edc', name: 'EDC', dir: 'domains/edc', entities: [], workflows: [], pages: {}, views: {} },
  },
  workspace: { name: 'Northlight CRO', policy: { effects: { irreversible: 'deny' } } },
} as never

const names = new Map([['person_priya', 'Priya Shah']])

describe('domains', () => {
  it('days of retention, entity titles, house rules', () => {
    const s: DomainSummary = {
      id: 'etmf', name: 'eTMF', regulated: true, owner: 'study_manager', retentionMs: 25 * 365 * DAY,
      entities: [{ key: 'etmf.Site', entity: 'Site', count: 7, parent: 'study', lifecycle: ['selected', 'activating'] }, { key: 'etmf.ExpectedDocument', entity: 'ExpectedDocument', count: 70 }],
      workflows: ['file-document'], pages: [{ id: 'tmf-health', title: 'TMF health', under: { entity: 'Study' } }], views: [], flags: 2,
    }
    const d = toDomain({ project }, s)
    expect(d.retentionDays).toBe(9125)
    expect(d.entities.map((e) => e.title)).toEqual(['Site', 'Expected document'])
    expect(d.detail?.houseRules).toEqual([{ subject: 'outbound', value: 'needs approval' }])
    expect(d.detail?.workspaceRules[0]?.subject).toBe('irreversible')
    expect(d.detail).toMatchObject({ acceptsFrom: ['intake'], intake: 'etmf' })
    expect(retentionDays(undefined)).toBeUndefined()
    expect(entityLabel('etmf.ExpectedDocument')).toBe('Expected document')
  })
})

const page: RecordPage = {
  entity: 'etmf.Site', domain: 'etmf', entityName: 'Site', regulated: true, id: 'site_us012', title: 'US-012 · Harbor Oncology, Boston', status: 'activating',
  layout: { layout: 'sidebar', header: ['status', 'study'], areas: { main: [{ kind: 'cases' }, { kind: 'related', relationships: ['expected_documents'] }], side: [{ kind: 'fields', fields: ['site_number', 'name'] }, { kind: 'details' }] } },
  fields: [
    { name: 'site_number', type: 'Text', value: 'US-012', source: { kind: 'domain' }, editable: true, controlled: true },
    { name: 'name', type: 'Text', value: 'Harbor Oncology, Boston', source: { kind: 'link', domain: 'edc', entity: 'edc.Site', recordId: 'edc_site_1' }, editable: false, followed: true },
    { name: 'start_up_pack_complete', type: 'Percentage', value: 90, source: { kind: 'calculated' }, editable: false, calculated: true },
    { name: 'activated_on', type: 'Date', value: null, source: { kind: 'step', stepRunId: 'sr_1', workflowId: 'activate-site' }, editable: true },
    { name: 'sponsor_approved', type: 'Boolean', value: false, source: { kind: 'person', personId: 'person_priya' }, editable: true },
    { name: 'study', type: 'Ref<Study>', value: 'study_ast301', ref: { entity: 'etmf.Study', id: 'study_ast301', title: 'AST-301' }, source: { kind: 'plugin', plugin: 'memwise/veeva-ctms' }, editable: false },
    { name: 'budget', type: 'Money', value: { amount: 1, currency: 'USD' }, hidden: true, source: { kind: 'domain' }, editable: true },
  ],
  parents: [{ entity: 'etmf.Sponsor', id: 'spon_1', title: 'Aster Bio' }, { entity: 'etmf.Study', id: 'study_ast301', title: 'AST-301' }],
  related: { expected_documents: { entity: 'etmf.ExpectedDocument', total: 10, rows: [{ entity: 'etmf.ExpectedDocument', id: 'exp_1', title: 'PI CV', status: 'missing', values: {} }] } },
  cases: [{ caseId: 'case_1', runId: 'run_1', workflowId: 'activate-site', title: '', state: 'collect_pack', status: 'active', updatedAt: 't', waitingOn: 'person_priya' }],
  lifecycle: { states: ['selected', 'activating', 'open'], current: 'activating', transitions: [{ name: 'approved', to: 'open', allowed: false, reason: 'Needs the start-up pack', guard: { condition: 'start_up_pack_complete = 100%', holds: false } }] },
  flags: [], signatures: [], mentions: [], start: [{ workflowId: 'activate-site', title: '' }], documents: {},
  history: [{ version: 2, at: 't2', by: 'person_priya', reason: 'Picked', changed: ['status'], hash: 'h2' }, { version: 1, at: 't1', by: 'source:domain:edc', changed: [], hash: 'h1' }],
  notes: { body: 'Ask about the IRB', version: 3, by: 'person_priya', at: 't' },
}

describe('record pages', () => {
  it('labels, sources with their names, hidden values nulled, transitions and history', () => {
    const p = toRecordPage({ project }, page, names)
    expect(p.domainName).toBe('eTMF')
    expect(p.fields.find((f) => f.name === 'start_up_pack_complete')?.label).toBe('Start up pack complete')
    expect(p.fields.find((f) => f.name === 'name')?.source).toEqual({ kind: 'link', domain: 'edc', domainName: 'EDC', entity: 'edc.Site', recordId: 'edc_site_1' })
    expect(p.fields.find((f) => f.name === 'activated_on')?.source).toMatchObject({ kind: 'step', label: 'Activate a site' })
    expect(p.fields.find((f) => f.name === 'sponsor_approved')?.source).toEqual({ kind: 'person', personId: 'person_priya', name: 'Priya Shah' })
    expect(p.fields.find((f) => f.name === 'study')?.source).toEqual({ kind: 'plugin', plugin: 'memwise/veeva-ctms', title: 'Veeva CTMS' })
    const hidden = p.fields.find((f) => f.name === 'budget')!
    expect(hidden).toMatchObject({ hidden: true, value: null, editable: false })
    expect(p.lifecycle?.transitions[0]).toEqual({ name: 'approved', label: 'Approved', to: 'open', allowed: false, reason: 'Needs the start-up pack', guard: { condition: 'start_up_pack_complete = 100%', holds: false } })
    expect(p.related.expected_documents?.label).toBe('Expected documents')
    expect(p.cases[0]).toMatchObject({ title: 'Activate a site', state: 'Collect pack', waitingOn: 'Priya Shah' })
    expect(p.start[0]?.title).toBe('Activate a site')
    expect(p.history.map((v) => v.byLabel)).toEqual(['Priya Shah', 'EDC'])
    expect(p.notes?.by).toBe('Priya Shah')
    expect(p.layout.areas.side?.[0]).toEqual({ kind: 'fields', fields: ['site_number', 'name'] })
  })

  it('review mode: proposed values with their quote and page; checks as pass or flag; the signature', () => {
    const p = toRecordPage({ project }, {
      ...page, entity: 'etmf.Document', review: {
        stepRunId: 'sr_qc', runId: 'run_9', caseId: 'case_9', workflowId: 'file-document', stepId: 'qc', title: '',
        proposed: [{ field: 'document_date', type: 'Date', value: '2026-03-14', confidence: 0.94, page: 2, quote: '14 Mar 2026', provenance: { kind: 'tool', at: 't', stepRunId: 'sr_ix', tool: 'quarantine.extract', callId: 'c1', document: 'vogel-cv.pdf', confidence: 0.94 } }],
        checks: [{ rule: 'Signed and dated', kind: 'verifier', passed: true, stepRunId: 'sr_chk' }, { rule: 'Name matches the delegation log', kind: 'verifier', passed: false, reason: 'Log says Dr. L. Vogel-Hartmann', stepRunId: 'sr_chk' }],
        outcomes: ['approved', 'sent_back'],
        sign: { meaning: 'Reviewed and approved for filing', as: { personId: 'person_priya', name: 'Priya Shah', roles: ['tmf_specialist'] } },
      },
    }, names)
    expect(p.review?.title).toBe('Qc')
    expect(p.review?.proposed[0]).toMatchObject({ label: 'Document date', page: 2, quote: '14 Mar 2026', confidence: 0.94 })
    expect(p.review?.checks.map((c) => c.verdict)).toEqual(['pass', 'flag'])
    expect(p.review?.checks[1]?.note).toContain('Vogel-Hartmann')
    expect(p.review?.sign?.as.name).toBe('Priya Shah')
  })

  it('version authors in words', () => {
    expect(versionByLabel('system', names)).toBe('MemWise')
    expect(versionByLabel('step:sr_1', names)).toBe('A playbook step')
    expect(versionByLabel('x', names, 'Given')).toBe('Given')
  })
})

describe('dashboards, views and automations', () => {
  it('dashboard blocks keep their numbers and rows', () => {
    const d: DashboardData = {
      pageId: 'tmf-health', title: 'TMF health', params: { study: 'study_ast301' }, computedAt: '2026-10-20T06:00:00Z',
      blocks: [
        { kind: 'kpi', label: 'Complete', value: 87, target: 95, format: 'percent' },
        { kind: 'heatmap', columns: ['Start-up', 'Ethics'], rows: [{ record: { entity: 'etmf.Site', id: 's1', title: 'US-012' }, values: [70, null] }] },
        { kind: 'table', title: 'Missing', result: { entity: 'etmf.ExpectedDocument', columns: [{ name: 'status', type: 'Lifecycle' }], rows: [], total: 0 } },
      ],
    }
    const m = toDashboard('etmf', d)
    expect(m.domain).toBe('etmf')
    expect(m.blocks[0]).toEqual({ kind: 'kpi', label: 'Complete', value: 87, target: 95, format: 'percent' })
    expect(m.blocks[1]).toMatchObject({ kind: 'heatmap', rows: [{ values: [70, null] }] })
    expect(m.blocks[2]).toMatchObject({ kind: 'table', result: { columns: [{ name: 'status', label: 'Status' }] } })
  })

  it('views drop their file; a personal view stays personal', () => {
    expect(toView({ id: 'v', title: 'Activating', entity: 'Site', filter: "status = 'activating'", layout: 'board', file: 'x.yaml', personal: true, domain: 'etmf' }))
      .toEqual({ id: 'v', title: 'Activating', domain: 'etmf', entity: 'Site', filter: "status = 'activating'", layout: 'board', personal: true })
  })

  it('triggers: the playbook title and a plain description when the kernel sends none', () => {
    const t: TriggerSummary = {
      id: 'activate-site#0', workflowId: 'activate-site', domain: 'etmf', def: { kind: 'entered', entity: 'Site', state: 'activating', with: {} },
      description: '', firings: 3, held: 0, nextDue: { at: '2026-11-01T00:00:00Z', record: { entity: 'etmf.Person', id: 'p1', title: 'Dr. Lena Vogel' } },
    }
    expect(toTrigger(project, t)).toMatchObject({ workflowTitle: 'Activate a site', description: 'When a site moves to Activating', nextDue: { record: { title: 'Dr. Lena Vogel' } } })
    expect(triggerDescription({ kind: 'date', entity: 'Person', field: 'cv_expires', direction: 'before', offsetMs: 30 * DAY, with: {} })).toBe("30 days before a person's cv expires")
    expect(triggerDescription({ kind: 'every', everyMs: 14 * DAY, with: {} })).toBe('Every 2 weeks')
    expect(triggerDescription({ kind: 'message', address: 'etmf', with: {} })).toBe('When an email arrives at etmf')
  })
})

describe('audit and inbox', () => {
  it('the audit trail in days, with names', () => {
    const a: AuditTrail = {
      entity: 'etmf.Document', id: 'doc_1', title: 'vogel-cv.pdf', domain: 'etmf', regulated: true, retentionMs: 365 * DAY, values: {},
      versions: [{ version: 1, at: 't', by: 'person_priya', changed: [], hash: 'h', values: {}, prevHash: '0'.repeat(64) }],
      chain: { ok: true }, signatures: [], cases: [{ caseId: 'c', workflowId: 'file-document', title: '', stepRuns: [{ stepRunId: 's', stepId: 'qc', performer: 'person', decidedBy: 'person_priya', at: 't' }] }], flags: [], exportedAt: 't',
    }
    const m = toAuditTrail(project, a, names)
    expect(m.retentionDays).toBe(365)
    expect(m.versions[0]?.byLabel).toBe('Priya Shah')
    expect(m.cases[0]).toMatchObject({ title: 'File a TMF document', stepRuns: [{ decidedBy: 'Priya Shah' }] })
    expect(auditFileName('etmf.Document', 'doc_1', 'pdf')).toBe('document-doc_1-audit.pdf')
  })

  it('flag and held-trigger items', () => {
    const flag = toFlagInboxItem(project, { kind: 'flag', id: 'flag:1', domain: 'etmf', title: 'US-012', since: 't', flag: { id: 'f1', entity: 'etmf.Site', recordId: 's1', invariant: 'status = open implies activated_on is set', message: 'Open without an activation date', raisedAt: 't' } })
    expect(flag).toMatchObject({ kind: 'flag', caseTitle: 'US-012', stepTitle: 'Open without an activation date' })
    const hold = toTriggerHoldInboxItem(project, { kind: 'trigger-hold', id: 'hold:1', triggerId: 'activate-site#0', workflowId: 'activate-site', held: 300, description: 'When a site moves to Activating', since: 't' })
    expect(hold).toMatchObject({ caseTitle: 'Activate a site', stepTitle: '300 cases would start', held: 300 })
  })
})

describe('entity definitions', () => {
  it('sources per field, parent, calculated, links, lifecycle, rules and the playbooks that use it', () => {
    const site = {
      entity: 'Site', domain: 'etmf', file: 'x', hash: 'h', title: '{site_number} · {name}', parent: 'study',
      fields: { site_number: text, study: { type: {}, typeSource: 'Ref<Study>' }, enrolment: text },
      ownership: { enrolment: 'memwise/veeva-ctms' },
      relationships: { study: { cardinality: 'one', target: 'Study' }, documents: { cardinality: 'many', target: 'Document', via: 'site' } },
      calculated: { start_up_pack_complete: { kind: 'rollup', rollup: 'percent', of: 'expected_documents', where: "status = 'filed'" }, days_activating: { kind: 'formula', formula: 'days_since(activated_on)' } },
      links: { 'edc.Site': { target: 'edc.Site', match: { site_number: 'site_number' }, follow: ['name'] } },
      lifecycleChart: {
        initial: 'selected',
        states: { selected: { name: 'selected', on: { picked: 'activating' } }, activating: { name: 'activating', on: { approved: 'open' }, after: [{ afterMs: 60 * DAY, remind: 'study_manager' }] }, open: { name: 'open', on: {} } },
        transitions: { picked: { name: 'picked', by: [{ kind: 'role', role: 'study_manager' }, { kind: 'source', source: 'domain:edc' }] }, approved: { name: 'approved', by: [{ kind: 'step' }], guard: 'start_up_pack_complete = 100%', signed: true } },
      },
      invariants: ["status = 'open' implies activated_on is set"],
    } as never
    const d = toEntityDefinition(project, 'etmf.Site', site)
    expect(d.parent).toEqual({ relationship: 'study', entity: 'Study' })
    expect(d.sources.enrolment).toEqual({ kind: 'plugin', plugin: 'memwise/veeva-ctms', title: 'Veeva CTMS' })
    expect(d.sources.site_number).toEqual({ kind: 'domain' })
    expect(d.sources.start_up_pack_complete).toEqual({ kind: 'calculated' })
    expect(d.sources.name).toMatchObject({ kind: 'link', domainName: 'EDC' })
    expect(d.calculated[0]?.summary).toBe("Percent of expected documents where status = 'filed'")
    expect(d.lifecycle?.states[1]?.timers).toEqual(['After 60d: remind study manager'])
    expect(d.lifecycle?.transitions[0]?.by).toEqual(['Study manager', 'EDC'])
    expect(d.lifecycle?.transitions[1]).toMatchObject({ by: ['A playbook step'], guard: 'start_up_pack_complete = 100%', signed: true })
    expect(d.usedBy.map((u) => u.workflowId)).toEqual(['activate-site'])
    const type = toEntityType({ project, diagnostics: [], tools: new Map(), jsonSchema: () => ({}) } as never, site, 'etmf.Site')
    expect(type).toMatchObject({ name: 'Site', key: 'etmf.Site', domain: 'etmf' })
  })
})

describe('cases about records', () => {
  const siteRef = { site: { type: { kind: 'ref', entity: 'Site' }, typeSource: 'Ref<Site>' } }
  const caseType = { fields: siteRef } as never

  it('a case with nothing typed of its own is named after its record, and shows it by title', () => {
    expect(caseTitle({ site: 'site_1' }, 'case_01ABCDEF3F9K2A', caseType)).toBe('New case 3F9K2A')
    expect(caseTitle({ site: 'site_1' }, 'case_01ABCDEF3F9K2A', caseType, undefined, 'US-012 · Harbor Oncology, Boston')).toBe('US-012 · Harbor Oncology, Boston')
    const values = withRefTitles({ site: { value: 'site_1', provenance: { kind: 'system', at: 't' } } as never }, caseType, new Map([['site_1', 'US-012 · Harbor Oncology, Boston']]))
    expect(values.site).toMatchObject({ value: 'site_1', refTitle: 'US-012 · Harbor Oncology, Boston' })
  })

  it('a case is named by its first text in field order, or an email by its subject', () => {
    const textField = { type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text' }
    const doc = { fields: { artifact: textField, version: textField } } as never
    // Values come back in any order; the case type's order decides.
    expect(caseTitle({ version: '2026-03', artifact: 'Investigator CV' }, 'case_1', doc)).toBe('Investigator CV')
    const message = { fields: { subject: textField, body: textField } } as never
    expect(caseTitle({ body: 'Please find attached…', subject: 'AST-301 US-012: PI CV' }, 'case_2', message)).toBe('AST-301 US-012: PI CV')
  })

  it('a wait_until waits on a condition, not on the owner; its values keep their types', () => {
    const wf = { id: 'activate-site', owner: 'study_manager', steps: {}, states: { collect_pack: { name: 'collect_pack', on: { met: 'approve' }, block: { kind: 'wait_until' } } } } as never
    expect(waitingOn(wf, 'collect_pack', 'active')).toEqual({ kind: 'condition' })
    const entities = { 'etmf.Site': { entity: 'Site', fields: { site_number: text }, calculated: { start_up_pack_complete: { kind: 'rollup', rollup: 'percent' } } } }
    const w = toWaiting(
      { record: { entity: 'etmf.Site', id: 'site_1', title: 'US-012' }, condition: 'start_up_pack_complete = 100%', holds: false, values: { start_up_pack_complete: 90 } },
      { entities } as never, new Map([['site_1', 'US-012 · Harbor Oncology, Boston']]),
    )
    expect(w).toMatchObject({ record: { title: 'US-012 · Harbor Oncology, Boston' }, values: { start_up_pack_complete: 90 }, types: { start_up_pack_complete: 'Percentage' } })
  })
})
