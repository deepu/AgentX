/**
 * Sample Phase 6 data for the playground and render tests, modelled on the eTMF example
 * (Northlight CRO keeps Aster Bio's Trial Master File for study AST-301). Plain data, no API.
 *
 * Sites US-012 Boston ("Harbor Oncology, Boston", activating, start-up pack 90%), DE-104 Berlin
 * and FR-201 Lyon; the document vogel-cv.pdf (an investigator CV for Dr. Lena Vogel) under QC;
 * the TMF health dashboard; the entities, views and automations of the eTMF domain.
 */

import type {
  MwAuditTrail,
  MwCase,
  MwCaseLink,
  MwDashboard,
  MwDomain,
  MwEntityType,
  MwInboxItem,
  MwRecordField,
  MwRecordPage,
  MwRecordQueryResult,
  MwRecordReview,
  MwTreeNode,
  MwTrigger,
  MwView,
  MwWaitingCondition,
} from '@memwise/shared/protocol'

export const SAMPLE_NOW = Date.parse('2026-10-20T10:00:00.000Z')
const T = (iso: string) => `${iso}.000Z`

const veeva = { kind: 'plugin', plugin: 'veeva-ctms', title: 'Veeva CTMS' } as const
const memwiseOwned = { kind: 'domain' } as const
const calculated = { kind: 'calculated' } as const
const priya = { kind: 'person', personId: 'per_priya', name: 'Priya Shah' } as const

// ---------------------------------------------------------------- domains

export const sampleDomains: MwDomain[] = [
  {
    id: 'etmf',
    name: 'eTMF',
    description: "The Trial Master File Northlight keeps for each sponsor's studies.",
    regulated: true,
    owner: 'tmf_lead',
    retentionDays: 25 * 365,
    entities: [
      { key: 'etmf.sponsor', entity: 'Sponsor', title: 'Sponsors', count: 2 },
      { key: 'etmf.study', entity: 'Study', title: 'Studies', count: 4, parent: 'Sponsor' },
      { key: 'etmf.country', entity: 'Country', title: 'Countries', count: 9, parent: 'Study' },
      { key: 'etmf.site', entity: 'Site', title: 'Sites', count: 31, parent: 'Study', lifecycle: ['selected', 'activating', 'open', 'closing', 'closed'] },
      { key: 'etmf.person', entity: 'Person', title: 'People', count: 214 },
      { key: 'etmf.document', entity: 'Document', title: 'Documents', count: 6480, lifecycle: ['received', 'in_qc', 'filed', 'superseded'] },
      { key: 'etmf.expected_document', entity: 'ExpectedDocument', title: 'Expected documents', count: 7210 },
      { key: 'etmf.artifact', entity: 'Artifact', title: 'TMF artifacts', count: 250 },
      { key: 'etmf.monitoring_visit', entity: 'MonitoringVisit', title: 'Monitoring visits', count: 96 },
    ],
    workflows: ['file-document', 'fix-rejected', 'activate-site', 'chase-missing', 'watch-expiries', 'tmf-health-check'],
    pages: [
      { id: 'tmf-health', title: 'TMF health', under: { entity: 'etmf.study' } },
      { id: 'inspection-prep', title: 'Inspection prep', under: { entity: 'etmf.study' } },
      { id: 'tmf-mapping', title: 'TMF mapping', under: { entity: 'etmf.sponsor' } },
    ],
    views: [
      { id: 'all-sites', title: 'All sites', entity: 'etmf.site' },
      { id: 'sites-by-status', title: 'By status', entity: 'etmf.site' },
      { id: 'activating', title: 'Activating', entity: 'etmf.site' },
    ],
    flags: 1,
    detail: {
      houseRules: [
        { subject: 'Filing', value: "Nothing is filed without a TMF specialist's signature" },
        { subject: 'Unblinded documents', value: 'Only go to the restricted area' },
        { subject: 'Original files', value: 'Are never changed' },
        { subject: 'outbound', value: 'needs approval' },
      ],
      workspaceRules: [{ subject: 'tokens', value: '2,000,000 per day' }],
      acceptsFrom: ['edc'],
      intake: 'etmf',
    },
  },
  {
    id: 'onboarding',
    name: 'Client onboarding',
    regulated: false,
    entities: [{ key: 'onboarding.client', entity: 'Client', title: 'Clients', count: 12 }],
    workflows: ['client-intake'],
    pages: [],
    views: [],
    flags: 0,
  },
  {
    id: 'safety',
    name: 'Safety reporting',
    regulated: true,
    retentionDays: 15 * 365,
    entities: [{ key: 'safety.case_report', entity: 'CaseReport', title: 'Case reports', count: 41 }],
    workflows: [],
    pages: [],
    views: [],
    flags: 0,
  },
]

/** A project that never split into domains: everything lives in the default one. */
export const sampleDefaultDomains: MwDomain[] = [
  {
    id: 'domain',
    name: 'Main',
    regulated: false,
    entities: [{ key: 'customer', entity: 'Customer', title: 'Customers', count: 18 }],
    workflows: ['client-intake'],
    pages: [],
    views: [],
    flags: 0,
  },
]

// ---------------------------------------------------------------- page tree

export const sampleTreeTop: MwTreeNode[] = [
  { kind: 'record', entity: 'etmf.sponsor', id: 'sponsor_aster', title: 'Aster Bio', hasChildren: true },
  { kind: 'record', entity: 'etmf.sponsor', id: 'sponsor_corvel', title: 'Corvel Therapeutics', hasChildren: true },
  { kind: 'group', entity: 'etmf.person', title: 'People', count: 214, viewFilter: '' },
]

export const sampleTreeChildren: Record<string, MwTreeNode[]> = {
  'etmf.sponsor:sponsor_aster': [
    { kind: 'page', pageId: 'tmf-mapping', title: 'TMF mapping', params: { sponsor: 'sponsor_aster' } },
    { kind: 'group', entity: 'etmf.study', parent: { entity: 'etmf.sponsor', id: 'sponsor_aster' }, title: 'Studies', count: 2 },
    { kind: 'record', entity: 'etmf.study', id: 'study_ast301', title: 'AST-301', status: 'active', hasChildren: true },
    { kind: 'record', entity: 'etmf.study', id: 'study_ast205', title: 'AST-205', status: 'closing', hasChildren: true },
  ],
  'etmf.study:study_ast301': [
    { kind: 'page', pageId: 'tmf-health', title: 'TMF health', params: { study: 'study_ast301' } },
    { kind: 'page', pageId: 'inspection-prep', title: 'Inspection prep', params: { study: 'study_ast301' } },
    { kind: 'group', entity: 'etmf.site', parent: { entity: 'etmf.study', id: 'study_ast301' }, title: 'Sites', count: 7 },
    { kind: 'record', entity: 'etmf.site', id: 'site_de104', title: 'DE-104 · Berlin', status: 'open', hasChildren: true },
    { kind: 'record', entity: 'etmf.site', id: 'site_de107', title: 'DE-107 · Munich', status: 'open', hasChildren: true },
    { kind: 'record', entity: 'etmf.site', id: 'site_fr201', title: 'FR-201 · Lyon', status: 'open', hasChildren: true },
    { kind: 'record', entity: 'etmf.site', id: 'site_fr203', title: 'FR-203 · Lyon', status: 'activating', hasChildren: true },
    { kind: 'record', entity: 'etmf.site', id: 'site_es301', title: 'ES-301 · Madrid', status: 'activating', hasChildren: true },
    { kind: 'record', entity: 'etmf.site', id: 'site_uk401', title: 'UK-401 · Leeds', status: 'open', hasChildren: true },
    { kind: 'record', entity: 'etmf.site', id: 'site_us012', title: 'US-012 · Harbor Oncology, Boston', status: 'activating', hasChildren: true },
    { kind: 'group', entity: 'etmf.document', parent: { entity: 'etmf.study', id: 'study_ast301' }, title: 'Documents', count: 1240, viewFilter: "study = 'study_ast301'" },
  ],
}

// ---------------------------------------------------------------- record pages

function field(f: Partial<MwRecordField> & Pick<MwRecordField, 'name' | 'type' | 'value' | 'source'>): MwRecordField {
  return { label: f.name.charAt(0).toUpperCase() + f.name.slice(1).replace(/_/g, ' '), editable: false, ...f }
}

const siteRef = { entity: 'etmf.site', id: 'site_us012', title: 'US-012 · Harbor Oncology, Boston', status: 'activating' }
const studyRef = { entity: 'etmf.study', id: 'study_ast301', title: 'AST-301', status: 'active' }
const sponsorRef = { entity: 'etmf.sponsor', id: 'sponsor_aster', title: 'Aster Bio' }
const meiChen = { entity: 'etmf.person', id: 'per_chen', title: 'Dr. Mei Chen' }

export const sampleSitePage: MwRecordPage = {
  entity: 'etmf.site',
  domain: 'etmf',
  domainName: 'eTMF',
  entityName: 'Site',
  regulated: true,
  id: 'site_us012',
  title: 'US-012 · Harbor Oncology, Boston',
  status: 'activating',
  layout: {
    layout: 'sidebar',
    header: ['title', 'status', 'principal_investigator', 'target_open_date'],
    areas: {
      main: [{ kind: 'cases' }, { kind: 'related', relationships: ['expected_documents'] }, { kind: 'lifecycle' }],
      side: [
        { kind: 'fields', fields: ['site_number', 'name', 'study', 'country', 'principal_investigator', 'target_open_date', 'start_up_pack', 'tmf_complete'] },
        { kind: 'chart', chart: 'bar', of: 'expected_documents', by: 'status' },
        { kind: 'start' },
      ],
      below: [{ kind: 'notes' }, { kind: 'mentions' }, { kind: 'history' }],
    },
  },
  fields: [
    field({ name: 'site_number', label: 'Site number', type: 'Text', value: 'US-012', source: veeva, required: true }),
    field({ name: 'name', type: 'Text', value: 'Harbor Oncology, Boston', source: veeva, required: true }),
    field({ name: 'study', type: 'Ref<Study>', value: 'study_ast301', ref: studyRef, source: veeva, required: true }),
    field({ name: 'country', type: 'Ref<Country>', value: 'country_us', ref: { entity: 'etmf.country', id: 'country_us', title: 'United States' }, source: veeva }),
    field({ name: 'principal_investigator', label: 'Principal investigator', type: 'Ref<Person>', value: 'per_chen', ref: meiChen, source: { kind: 'step', stepRunId: 'sr_pi', workflowId: 'activate-site', label: 'Activate a site' } }),
    field({ name: 'status', label: 'Status', type: 'Lifecycle', value: 'activating', source: memwiseOwned, controlled: true }),
    field({ name: 'target_open_date', label: 'Target open date', type: 'Date', value: '2026-11-14', source: priya, editable: true, controlled: true }),
    field({ name: 'start_up_pack', label: 'Start-up pack', type: 'Percentage', value: 90, source: calculated, calculated: true, description: 'Percent of start-up documents filed' }),
    field({ name: 'tmf_complete', label: 'TMF complete', type: 'Percentage', value: 52, source: calculated, calculated: true }),
    field({ name: 'address', type: 'Address', value: { street: '450 Brookline Ave', city: 'Boston', country: 'US' }, source: { kind: 'link', domain: 'edc', domainName: 'EDC', entity: 'edc.site', recordId: 'edc_site_us012' }, followed: true }),
    field({ name: 'site_payments', label: 'Site payments to date', type: 'Money', value: null, hidden: true, source: { kind: 'plugin', plugin: 'finance', title: 'Finance system' } }),
  ],
  parents: [sponsorRef, studyRef],
  related: {
    expected_documents: {
      entity: 'etmf.expected_document',
      label: 'Start-up pack',
      total: 10,
      rows: [
        { entity: 'etmf.expected_document', id: 'exp_1', title: 'Protocol signature page', status: 'filed', values: { status: 'filed', filed_on: '2026-10-02' } },
        { entity: 'etmf.expected_document', id: 'exp_2', title: 'FDA Form 1572', status: 'filed', values: { status: 'filed', filed_on: '2026-10-03' } },
        { entity: 'etmf.expected_document', id: 'exp_3', title: 'Principal investigator CV', status: 'sent_back', values: { status: 'sent_back', filed_on: null } },
        { entity: 'etmf.expected_document', id: 'exp_4', title: 'IRB approval', status: 'missing', values: { status: 'missing', filed_on: null } },
        { entity: 'etmf.expected_document', id: 'exp_5', title: 'Lab certification (CLIA or CAP)', status: 'missing', values: { status: 'missing', filed_on: null } },
      ],
      types: { filed_on: 'Date' },
    },
  },
  cases: [
    { caseId: 'case_act', runId: 'run_act', workflowId: 'activate-site', title: 'Activate a site', state: 'Collect the start-up pack', status: 'active', updatedAt: T('2026-10-19T16:00:00'), waitingOn: 'Site' },
    { caseId: 'case_clia', runId: 'run_clia', workflowId: 'file-document', title: 'File a TMF document: clia-cert-2026.pdf', state: 'QC and sign', status: 'active', updatedAt: T('2026-10-20T08:00:00'), waitingOn: 'Priya Shah' },
    { caseId: 'case_fix', runId: 'run_fix', workflowId: 'fix-rejected', title: 'Fix a rejected document: PI CV', state: 'Wait for the site', status: 'active', updatedAt: T('2026-10-16T12:00:00'), waitingOn: 'Site' },
  ],
  lifecycle: {
    states: ['selected', 'activating', 'open', 'closing', 'closed'],
    current: 'activating',
    transitions: [
      { name: 'approved', label: 'Approved', to: 'open', allowed: false, reason: "The start-up pack isn't complete yet.", guard: { condition: 'start_up_pack = 100 and sponsor_approved', holds: false }, signed: true },
      { name: 'withdrawn', label: 'Withdrawn', to: 'closed', allowed: true },
    ],
  },
  flags: [],
  signatures: [],
  notes: { body: 'The site coordinator **Ana Ruiz** changed in September; send chases to her.', version: 3, by: 'Priya Shah', at: T('2026-10-12T09:30:00') },
  mentions: [
    { sourceKind: 'chat', sourceId: 'ses_1', label: 'Chat: why is US-012 late?', at: T('2026-10-18T14:00:00') },
    { sourceKind: 'step', sourceId: 'sr_chase', label: 'Chase missing documents: Lab certification', at: T('2026-10-15T09:00:00'), caseId: 'case_chase' },
  ],
  start: [{ workflowId: 'chase-missing', title: 'Chase missing documents' }, { workflowId: 'file-document', title: 'File a TMF document' }],
  documents: {},
  history: [
    { version: 4, at: T('2026-10-12T09:30:00'), by: 'per_priya', byLabel: 'Priya Shah', reason: 'Sponsor moved the date', changed: ['target_open_date'], hash: 'c41e…' },
    { version: 3, at: T('2026-10-01T08:00:00'), by: 'step:sr_open', byLabel: 'A playbook step', via: 'Activate a site', changed: ['status'], hash: '9a02…' },
    { version: 2, at: T('2026-09-28T13:00:00'), by: 'source:veeva-ctms', byLabel: 'Veeva CTMS', changed: ['name', 'principal_investigator'], hash: '51bd…' },
    { version: 1, at: T('2026-09-20T10:00:00'), by: 'source:veeva-ctms', byLabel: 'Veeva CTMS', changed: ['site_number', 'name', 'study', 'country'], hash: '07aa…' },
  ],
}

export const sampleStudyPage: MwRecordPage = {
  entity: 'etmf.study',
  domain: 'etmf',
  domainName: 'eTMF',
  entityName: 'Study',
  regulated: true,
  id: 'study_ast301',
  title: 'AST-301',
  status: 'active',
  layout: {
    layout: 'single',
    header: ['title', 'status'],
    isDefault: true,
    areas: {
      main: [
        { kind: 'details' },
        { kind: 'related', relationships: ['sites'] },
        { kind: 'chart', chart: 'donut', of: 'sites', by: 'status' },
        { kind: 'cases' },
      ],
      below: [{ kind: 'notes' }, { kind: 'mentions' }, { kind: 'history' }],
    },
  },
  fields: [
    field({ name: 'code', type: 'Text', value: 'AST-301', source: veeva, required: true }),
    field({ name: 'title', type: 'Text', value: 'A phase 3 study of asterumab in advanced gastric cancer', source: veeva }),
    field({ name: 'sponsor', type: 'Ref<Sponsor>', value: 'sponsor_aster', ref: sponsorRef, source: veeva }),
    field({ name: 'phase', type: 'Enum', value: '3', source: veeva }),
    field({ name: 'tmf_complete', label: 'TMF complete', type: 'Percentage', value: 87, source: calculated, calculated: true }),
    field({ name: 'first_patient_in', label: 'First patient in', type: 'Date', value: '2026-02-10', source: veeva }),
  ],
  parents: [sponsorRef],
  related: {
    sites: {
      entity: 'etmf.site',
      label: 'Sites',
      total: 7,
      rows: [
        { entity: 'etmf.site', id: 'site_de104', title: 'DE-104 · Berlin', status: 'open', values: { status: 'open', tmf_complete: 96 } },
        { entity: 'etmf.site', id: 'site_fr201', title: 'FR-201 · Lyon', status: 'open', values: { status: 'open', tmf_complete: 87 } },
        { entity: 'etmf.site', id: 'site_us012', title: 'US-012 · Harbor Oncology, Boston', status: 'activating', values: { status: 'activating', tmf_complete: 52 } },
        { entity: 'etmf.site', id: 'site_es301', title: 'ES-301 · Madrid', status: 'activating', values: { status: 'activating', tmf_complete: 64 } },
        { entity: 'etmf.site', id: 'site_uk401', title: 'UK-401 · Leeds', status: 'open', values: { status: 'open', tmf_complete: 86 } },
      ],
    },
  },
  cases: [],
  flags: [],
  signatures: [],
  mentions: [],
  start: [],
  documents: {},
  history: [{ version: 1, at: T('2026-01-05T10:00:00'), by: 'source:veeva-ctms', byLabel: 'Veeva CTMS', changed: ['code', 'title', 'sponsor', 'phase'], hash: '33fe…' }],
}

const vogelCv = { id: 'file_vogel_cv', name: 'vogel-cv.pdf', mime: 'application/pdf', size: 184_220, sha256: 'b7c1e2' }
const indexStep = { kind: 'step', stepRunId: 'sr_index', workflowId: 'file-document', label: 'File a TMF document' } as const

export const sampleDocumentPage: MwRecordPage = {
  entity: 'etmf.document',
  domain: 'etmf',
  domainName: 'eTMF',
  entityName: 'Document',
  regulated: true,
  id: 'doc_vogel_cv',
  title: 'Investigator CV · Dr. Lena Vogel',
  status: 'in_qc',
  layout: {
    layout: 'split',
    header: ['title', 'artifact', 'status', 'site'],
    areas: {
      left: [{ kind: 'viewer', field: 'file' }],
      right: [
        { kind: 'fields', fields: ['artifact', 'study', 'site', 'about', 'document_date', 'version', 'unblinded'] },
        { kind: 'checks' },
        { kind: 'details' },
        // As the eTMF example writes it: the record's versions and signatures.
        { kind: 'related', relationships: ['versions', 'signatures'] },
      ],
      below: [{ kind: 'mentions' }, { kind: 'notes' }],
    },
  },
  fields: [
    field({ name: 'file', type: 'Document', value: vogelCv, source: { kind: 'source', source: 'email' } }),
    field({ name: 'artifact', type: 'Ref<Artifact>', value: 'art_05_02_01', ref: { entity: 'etmf.artifact', id: 'art_05_02_01', title: 'Curriculum vitae' }, source: indexStep }),
    field({ name: 'study', type: 'Ref<Study>', value: 'study_ast301', ref: studyRef, source: indexStep }),
    field({ name: 'site', type: 'Ref<Site>', value: 'site_de104', ref: { entity: 'etmf.site', id: 'site_de104', title: 'DE-104 · Berlin', status: 'open' }, source: indexStep }),
    field({ name: 'about', type: 'Ref<Person>', value: 'per_vogel', ref: { entity: 'etmf.person', id: 'per_vogel', title: 'Dr. Lena Vogel' }, source: indexStep }),
    field({ name: 'document_date', label: 'Document date', type: 'Date', value: '2026-03-14', source: indexStep }),
    field({ name: 'version', type: 'Text', value: '2026', source: indexStep }),
    field({ name: 'unblinded', type: 'Boolean', value: false, source: indexStep }),
    field({ name: 'status', type: 'Lifecycle', value: 'in_qc', source: memwiseOwned }),
    field({ name: 'received_at', label: 'Received at', type: 'DateTime', value: '2026-10-20T08:02:00.000Z', source: { kind: 'source', source: 'email' } }),
  ],
  parents: [sponsorRef, studyRef, { entity: 'etmf.site', id: 'site_de104', title: 'DE-104 · Berlin', status: 'open' }],
  related: {},
  cases: [{ caseId: 'case_vogel', runId: 'run_vogel', workflowId: 'file-document', title: 'File a TMF document: vogel-cv.pdf', state: 'QC and sign', status: 'active', updatedAt: T('2026-10-20T08:10:00'), waitingOn: 'Priya Shah' }],
  lifecycle: { states: ['received', 'in_qc', 'filed', 'superseded'], current: 'in_qc', transitions: [] },
  flags: [{ id: 'flag_1', entity: 'etmf.document', recordId: 'doc_vogel_cv', invariant: 'about.name = site.delegation_log.name', message: 'Name differs from the delegation log, which says "Dr. L. Vogel-Hartmann".', raisedAt: T('2026-10-20T08:09:00') }],
  signatures: [
    { id: 'sig_old', stepRunId: 'sr_old', caseId: 'case_old', personId: 'per_tom', name: 'Tom Ellis', meaning: 'Reviewed and approved for filing', at: T('2023-05-02T10:00:00'), entity: 'etmf.document', recordId: 'doc_vogel_cv', contentHash: 'aa01', changedSince: true },
  ],
  notes: undefined,
  mentions: [],
  start: [],
  documents: { file: vogelCv },
  history: [
    { version: 2, at: T('2026-10-20T08:09:00'), by: 'step:sr_index', byLabel: 'A playbook step', via: 'File a TMF document', reason: 'Indexed by the agent', changed: ['artifact', 'study', 'site', 'about', 'document_date', 'version', 'unblinded'], hash: 'e19d…' },
    { version: 1, at: T('2026-10-20T08:02:00'), by: 'source:email', byLabel: 'Email', changed: ['file', 'received_at'], hash: '5c00…' },
  ],
}

export const sampleDocumentReview: MwRecordReview = {
  stepRunId: 'sr_qc',
  runId: 'run_vogel',
  caseId: 'case_vogel',
  workflowId: 'file-document',
  stepId: 'qc',
  title: 'QC and sign',
  instructions: 'Check the document against its index and the flags, then approve and sign, or send it back to the site with a note.',
  proposed: [
    { field: 'artifact', label: 'Artifact', type: 'Ref<Artifact>', value: 'Curriculum vitae', confidence: 0.97, page: 1, quote: 'Curriculum vitae', document: 'file_vogel_cv', required: true, provenance: { kind: 'tool', at: T('2026-10-20T08:09:00'), stepRunId: 'sr_index', tool: 'tmf.classify', callId: 'c1' } },
    { field: 'study', label: 'Study', type: 'Ref<Study>', value: 'stud_ast301', ref: { entity: 'etmf.study', id: 'stud_ast301', title: 'AST-301' }, confidence: 0.99, provenance: { kind: 'judgement', at: T('2026-10-20T08:09:00'), stepRunId: 'sr_index', rationale: 'From the email subject' } },
    { field: 'site', label: 'Site', type: 'Ref<Site>', value: 'site_de104', ref: { entity: 'etmf.site', id: 'site_de104', title: 'DE-104 · Berlin' }, confidence: 0.95, provenance: { kind: 'judgement', at: T('2026-10-20T08:09:00'), stepRunId: 'sr_index', rationale: "Sender's site" } },
    { field: 'about', label: 'About', type: 'Ref<Person>', value: 'pers_vogel', ref: { entity: 'etmf.person', id: 'pers_vogel', title: 'Dr. Lena Vogel' }, confidence: 0.93, page: 1, quote: 'Dr. med. Lena Vogel', document: 'file_vogel_cv' },
    { field: 'document_date', label: 'Document date', type: 'Date', value: '2026-03-14', confidence: 0.91, page: 2, quote: '14 Mar 2026', document: 'file_vogel_cv', required: true },
    { field: 'version', label: 'Version', type: 'Text', value: '2026', confidence: 0.62, page: 2, quote: 'Version 2026 rev. B', document: 'file_vogel_cv' },
    { field: 'unblinded', label: 'Unblinded', type: 'Boolean', value: false, confidence: 0.98 },
  ],
  checks: [
    // The engine's own checks on the agent's answer: they fold into one line.
    { rule: 'outcome is declared', verdict: 'pass', stepRunId: 'sr_index' },
    { rule: 'writes.site: Ref<Site>', verdict: 'pass', stepRunId: 'sr_index' },
    { rule: 'Signed and dated (page 2)', verdict: 'pass', stepRunId: 'sr_check' },
    { rule: 'Signed within the last 2 years', verdict: 'pass', stepRunId: 'sr_check' },
    { rule: 'Site DE-104 is active', verdict: 'pass', stepRunId: 'sr_check' },
    { rule: 'Not already filed', verdict: 'pass', note: 'Replaces the 2023 CV, which becomes superseded.', stepRunId: 'sr_check' },
    { rule: 'Legible and complete', verdict: 'pass', stepRunId: 'sr_check' },
    { rule: 'Names match the delegation log', verdict: 'flag', note: 'Name differs from the delegation log, which says "Dr. L. Vogel-Hartmann". Probably the same person.', stepRunId: 'sr_check' },
  ],
  outcomes: ['approved', 'sent_back'],
  sign: { meaning: 'Reviewed and approved for filing in the TMF', as: { personId: 'per_priya', name: 'Priya Shah', roles: ['tmf_specialist'] } },
}

export const sampleDocumentReviewPage: MwRecordPage = { ...sampleDocumentPage, review: sampleDocumentReview }

/** The document's PDF text, by page, as a text layer gives it (for quote-highlight tests and the playground). */
export const sampleDocumentText: string[][] = [
  ['Dr. med. Lena Vogel', 'Curriculum vitae · Principal Investigator', 'Clinical research experience', 'Charité Berlin, 2012–2026'],
  ['GCP training', 'L. Vogel', 'Signature', '14 Mar', ' 2026', 'Date'],
]

// ---------------------------------------------------------------- inbox items (Phase 6 kinds)

export const sampleDocumentReviewItem: Extract<MwInboxItem, { kind: 'decision' }> = {
  kind: 'decision',
  id: 'step:sr_qc',
  stepRunId: 'sr_qc',
  caseId: 'case_vogel',
  runId: 'run_vogel',
  caseTitle: 'Investigator CV · Dr. Lena Vogel',
  workflowId: 'file-document',
  stepTitle: 'QC and sign',
  instructions: sampleDocumentReview.instructions!,
  assignee: 'tmf_specialist',
  outcomes: ['approved', 'sent_back'],
  context: {},
  since: T('2026-10-20T08:10:00'),
  dueAt: T('2026-10-23T08:10:00'),
  domain: 'etmf',
  review: { kind: 'document', entity: 'etmf.document', recordId: 'doc_vogel_cv' },
  sign: { meaning: 'Reviewed and approved for filing in the TMF' },
}

export const sampleSecondReviewItem: Extract<MwInboxItem, { kind: 'decision' }> = {
  ...sampleDocumentReviewItem,
  id: 'step:sr_qc2',
  stepRunId: 'sr_qc2',
  caseId: 'case_irb',
  runId: 'run_irb',
  caseTitle: 'IRB approval · Site US-012',
  since: T('2026-10-20T07:40:00'),
  review: { kind: 'document', entity: 'etmf.document', recordId: 'doc_irb' },
}

export const sampleTableReviewItem: Extract<MwInboxItem, { kind: 'input' }> = {
  kind: 'input',
  id: 'step:sr_amend',
  stepRunId: 'sr_amend',
  caseId: 'case_amend',
  runId: 'run_amend',
  caseTitle: 'Protocol amendment 3',
  workflowId: 'apply-amendment',
  stepTitle: 'Approve the list of documents to update',
  fields: [{ name: 'documents_to_update', type: 'List<DocumentToUpdate>', schema: { type: 'array' } }],
  prefill: {
    documents_to_update: {
      value: [
        { document: 'Informed consent form v4', site: 'All sites', confidence: 0.96, why: 'The amendment changes the visit schedule the consent describes.' },
        { document: 'Investigator brochure', site: 'All sites', confidence: 0.91, why: 'New safety data in section 6.' },
        { document: 'Pharmacy manual', site: 'DE-104 · Berlin', confidence: 0.72, why: 'Dosing changed for the extension phase; only Berlin runs it.' },
        { document: 'Lab manual', site: 'All sites', confidence: 0.48, why: 'Mentions a new lab panel, but the panel may be optional.' },
      ],
      provenance: { kind: 'judgement', at: T('2026-10-19T12:00:00'), stepRunId: 'sr_plan', rationale: 'Compared the amendment with the current documents.' },
    },
  },
  outcomes: ['approved', 'sent_back'],
  context: {},
  since: T('2026-10-19T12:05:00'),
  domain: 'etmf',
  review: { kind: 'table', items: 'documents_to_update' },
}

export const sampleDiffReviewItem: Extract<MwInboxItem, { kind: 'decision' }> = {
  kind: 'decision',
  id: 'step:sr_diff',
  stepRunId: 'sr_diff',
  caseId: 'case_diff',
  runId: 'run_diff',
  caseTitle: 'Site DE-104 · change of principal investigator',
  workflowId: 'change-signed-record',
  stepTitle: 'Approve the change',
  instructions: 'The site record was signed. Compare the change before it is applied.',
  outcomes: ['approved', 'sent_back'],
  context: {
    principal_investigator: { value: 'Dr. Lena Vogel-Hartmann', provenance: { kind: 'judgement', at: T('2026-10-19T09:00:00'), stepRunId: 'sr_read' } },
    phone: { value: '+49 30 4505 1200', provenance: { kind: 'judgement', at: T('2026-10-19T09:00:00'), stepRunId: 'sr_read' } },
  },
  since: T('2026-10-19T09:05:00'),
  domain: 'etmf',
  review: { kind: 'diff' },
  sign: { meaning: 'Approved the change to a signed record' },
}

/** The current values the diff compares against (what the record says now). */
export const sampleDiffCurrent: Record<string, unknown> = {
  principal_investigator: 'Dr. Lena Vogel',
  phone: '+49 30 4505 1200',
}

export const sampleFlagItem: Extract<MwInboxItem, { kind: 'flag' }> = {
  kind: 'flag',
  id: 'flag:flag_1',
  caseTitle: 'Investigator CV · Dr. Lena Vogel',
  stepTitle: 'Name differs from the delegation log',
  domain: 'etmf',
  flag: sampleDocumentPage.flags[0]!,
  since: T('2026-10-20T08:09:00'),
}

export const sampleTriggerHoldItem: Extract<MwInboxItem, { kind: 'trigger-hold' }> = {
  kind: 'trigger-hold',
  id: 'trigger-hold:watch-expiries:0',
  caseTitle: 'Watch for expiries',
  stepTitle: '300 cases would start',
  triggerId: 'watch-expiries:0',
  workflowId: 'watch-expiries',
  held: 300,
  description: "30 days before a person's CV expires",
  since: T('2026-10-20T06:00:00'),
}

// ---------------------------------------------------------------- cases (Phase 6 additions)

export const sampleCaseLinks: MwCaseLink[] = [
  { kind: 'started_by', caseId: 'case_vogel', runId: 'run_vogel', workflowId: 'file-document', title: 'File a TMF document: vogel-cv.pdf', state: 'QC and sign', status: 'active' },
  { kind: 'called', caseId: 'case_chase', runId: 'run_chase', workflowId: 'chase-missing', title: 'Chase missing documents: Lab certification', state: 'Wait for a reply', status: 'active' },
  { kind: 'started', caseId: 'case_open', runId: 'run_open', workflowId: 'file-document', title: 'File a TMF document: clia-cert-2026.pdf', state: 'Filed', status: 'done' },
]

export const sampleWaiting: MwWaitingCondition = {
  record: siteRef,
  condition: 'start_up_pack = 100',
  holds: false,
  values: { start_up_pack: 90 },
}

export function withPhase6Case(kase: MwCase): MwCase {
  return { ...kase, caseLinks: sampleCaseLinks, waiting: sampleWaiting, domain: 'etmf' }
}

// ---------------------------------------------------------------- entities, views, query

export const sampleSiteType: MwEntityType = {
  name: 'Site',
  key: 'etmf.site',
  domain: 'etmf',
  lifecycle: ['selected', 'activating', 'open', 'closing', 'closed'],
  fields: [
    { name: 'site_number', type: 'Text', schema: { type: 'string', pattern: '^[A-Z]{2}-\\d{3}$' }, required: true, description: 'Like US-012' },
    { name: 'name', type: 'Text', schema: { type: 'string' }, required: true },
    { name: 'study', type: 'Ref<Study>', schema: { type: 'string' }, required: true },
    { name: 'country', type: 'Ref<Country>', schema: { type: 'string' }, required: true },
    { name: 'principal_investigator', type: 'Ref<Person>', schema: { type: 'string' }, required: true },
    { name: 'status', type: 'Lifecycle', schema: { type: 'string' }, required: true },
    { name: 'activated_on', type: 'Date', schema: { type: 'string', format: 'date' } },
    { name: 'site_payments', type: 'Money', schema: { type: 'object' }, access: ['finance'] },
    { name: 'unblinded_pharmacist', type: 'Ref<Person>', schema: { type: 'string' }, access: ['unblinded_team'] },
  ],
  definition: {
    title: '{site_number} · {name}',
    parent: { relationship: 'study', entity: 'etmf.study' },
    sources: {
      site_number: veeva,
      name: veeva,
      study: veeva,
      country: veeva,
      principal_investigator: { kind: 'step', stepRunId: '', workflowId: 'activate-site', label: 'Activate a site' },
      status: memwiseOwned,
      activated_on: { kind: 'step', stepRunId: '', workflowId: 'activate-site', label: 'Activate a site' },
      site_payments: { kind: 'plugin', plugin: 'finance', title: 'Finance system' },
      unblinded_pharmacist: { kind: 'step', stepRunId: '', workflowId: 'activate-site', label: 'Activate a site' },
      tmf_complete: calculated,
      start_up_pack: calculated,
    },
    relationships: [
      { name: 'study', cardinality: 'one', target: 'etmf.study' },
      { name: 'country', cardinality: 'one', target: 'etmf.country' },
      { name: 'people', cardinality: 'many', target: 'etmf.person', via: 'delegation log' },
      { name: 'documents', cardinality: 'many', target: 'etmf.document' },
      { name: 'expected_documents', cardinality: 'many', target: 'etmf.expected_document' },
      { name: 'monitoring_visits', cardinality: 'many', target: 'etmf.monitoring_visit' },
    ],
    calculated: [
      { name: 'tmf_complete', kind: 'rollup', summary: "Percent of expected documents where status = 'filed'" },
      { name: 'start_up_pack', kind: 'rollup', summary: "Percent of start-up documents where status = 'filed'", description: 'Drives the activation guard' },
    ],
    links: [{ target: 'edc.site', match: { study: 'study', site_number: 'site_number' }, follow: ['address'] }],
    lifecycle: {
      initial: 'selected',
      states: [
        { name: 'selected', label: 'Selected', on: [{ transition: 'picked', to: 'activating' }], timers: [] },
        { name: 'activating', label: 'Activating', on: [{ transition: 'approved', to: 'open' }, { transition: 'withdrawn', to: 'closed' }], timers: ['After 60d: remind study manager'] },
        { name: 'open', label: 'Open', on: [{ transition: 'last_visit', to: 'closing' }], timers: [] },
        { name: 'closing', label: 'Closing', on: [{ transition: 'archived', to: 'closed' }], timers: [] },
        { name: 'closed', label: 'Closed', on: [], timers: [] },
      ],
      transitions: [
        { name: 'picked', label: 'Picked', by: ['Study manager'] },
        { name: 'approved', label: 'Approved', by: ['A playbook step'], guard: 'start_up_pack = 100 and sponsor_approved', signed: true },
        { name: 'withdrawn', label: 'Withdrawn', by: ['Study manager'] },
        { name: 'last_visit', label: 'Last visit', by: ['Veeva CTMS'] },
        { name: 'archived', label: 'Archived', by: ['A playbook step'] },
      ],
    },
    invariants: [
      "A site can't move to Open until its start-up pack is complete and the sponsor has approved.",
      'A Closed site accepts no new documents except close-out documents.',
      'Every Open site has a principal investigator on its delegation log.',
    ],
    usedBy: [
      { workflowId: 'file-document', title: 'File a TMF document' },
      { workflowId: 'activate-site', title: 'Activate a site' },
      { workflowId: 'chase-missing', title: 'Chase missing documents' },
      { workflowId: 'watch-expiries', title: 'Watch for expiries' },
    ],
  },
}

export const sampleEntityTypes: MwEntityType[] = [
  { name: 'Sponsor', key: 'etmf.sponsor', domain: 'etmf', fields: [{ name: 'name', type: 'Text', schema: { type: 'string' }, required: true }], definition: { sources: { name: veeva }, relationships: [], calculated: [], links: [], invariants: [], usedBy: [] } },
  { name: 'Study', key: 'etmf.study', domain: 'etmf', fields: [{ name: 'code', type: 'Text', schema: { type: 'string' }, required: true }], definition: { parent: { relationship: 'sponsor', entity: 'etmf.sponsor' }, sources: { code: veeva }, relationships: [{ name: 'sponsor', cardinality: 'one', target: 'etmf.sponsor' }], calculated: [], links: [], invariants: [], usedBy: [] } },
  sampleSiteType,
  { name: 'Document', key: 'etmf.document', domain: 'etmf', lifecycle: ['received', 'in_qc', 'filed', 'superseded'], fields: [{ name: 'file', type: 'Document', schema: { type: 'object' }, required: true }] },
  { name: 'Customer', key: 'onboarding.client', domain: 'onboarding', fields: [] },
]

export const sampleSitesQuery: MwRecordQueryResult = {
  entity: 'etmf.site',
  columns: [
    { name: 'study', label: 'Study', type: 'Ref<Study>' },
    { name: 'country', label: 'Country', type: 'Ref<Country>' },
    { name: 'principal_investigator', label: 'Principal investigator', type: 'Ref<Person>' },
    { name: 'status', label: 'Status', type: 'Lifecycle' },
    { name: 'tmf_complete', label: 'TMF complete', type: 'Percentage', calculated: true },
    { name: 'open_cases', label: 'Open cases', type: 'Number', calculated: true },
  ],
  rows: [
    { entity: 'etmf.site', id: 'site_us012', title: 'US-012 · Harbor Oncology', status: 'activating', hidden: [], refs: { study: { entity: 'etmf.study', id: 'stud_ast301', title: 'AST-301' } }, values: { study: 'stud_ast301', country: 'United States', principal_investigator: 'Dr. Mei Chen', status: 'activating', tmf_complete: 52, open_cases: 4 } },
    { entity: 'etmf.site', id: 'site_es301', title: 'ES-301 · Madrid', status: 'activating', hidden: [], refs: { study: { entity: 'etmf.study', id: 'stud_ast301', title: 'AST-301' } }, values: { study: 'stud_ast301', country: 'Spain', principal_investigator: 'Dr. Lucía Ortega', status: 'activating', tmf_complete: 64, open_cases: 3 } },
    { entity: 'etmf.site', id: 'site_uk401', title: 'UK-401 · Leeds', status: 'open', hidden: [], refs: { study: { entity: 'etmf.study', id: 'stud_ast301', title: 'AST-301' } }, values: { study: 'stud_ast301', country: 'United Kingdom', principal_investigator: 'Dr. Sarah Whitfield', status: 'open', tmf_complete: 86, open_cases: 9 } },
    { entity: 'etmf.site', id: 'site_fr201', title: 'FR-201 · Lyon', status: 'open', hidden: [], refs: { study: { entity: 'etmf.study', id: 'stud_ast301', title: 'AST-301' } }, values: { study: 'stud_ast301', country: 'France', principal_investigator: 'Dr. Claire Martin', status: 'open', tmf_complete: 87, open_cases: 5 } },
    { entity: 'etmf.site', id: 'site_de104', title: 'DE-104 · Berlin', status: 'open', hidden: [], refs: { study: { entity: 'etmf.study', id: 'stud_ast301', title: 'AST-301' } }, values: { study: 'stud_ast301', country: 'Germany', principal_investigator: 'Dr. Lena Vogel', status: 'open', tmf_complete: 96, open_cases: 3 } },
    { entity: 'etmf.site', id: 'site_pl110', title: 'PL-110 · Warsaw', status: 'selected', hidden: ['principal_investigator'], refs: { study: { entity: 'etmf.study', id: 'stud_ast205', title: 'AST-205' } }, values: { study: 'stud_ast205', country: 'Poland', principal_investigator: null, status: 'selected', tmf_complete: null, open_cases: 0 } },
  ],
  total: 31,
  groups: [{ key: 'selected', count: 1 }, { key: 'activating', count: 3 }, { key: 'open', count: 25 }, { key: 'closing', count: 2 }],
}

export const sampleViews: MwView[] = [
  { id: 'all-sites', title: 'All sites', domain: 'etmf', entity: 'etmf.site', layout: 'table', personal: false, sort: [{ field: 'tmf_complete' }] },
  { id: 'sites-by-status', title: 'By status', domain: 'etmf', entity: 'etmf.site', layout: 'board', group: 'status', personal: false },
  { id: 'activating', title: 'Activating', domain: 'etmf', entity: 'etmf.site', layout: 'table', filter: "status = 'activating'", personal: false },
  { id: 'my-my-sites', title: 'My sites', domain: 'etmf', entity: 'etmf.site', layout: 'table', filter: "cra = me", personal: true },
]

// ---------------------------------------------------------------- dashboard

const heatColumns = ['Start-up', 'Ethics', 'Site mgmt', 'IP & supplies', 'Safety', 'Lab']
const heatRow = (id: string, title: string, values: (number | null)[]) => ({ record: { entity: 'etmf.site', id, title }, values })

export const sampleDashboard: MwDashboard = {
  pageId: 'tmf-health',
  domain: 'etmf',
  title: 'TMF health · AST-301',
  description: '7 sites in 4 countries',
  params: { study: 'study_ast301' },
  computedAt: T('2026-10-20T06:00:00'),
  blocks: [
    { kind: 'kpi', label: 'Complete', value: 87, format: 'percent', detail: '1,079 of 1,240 expected' },
    { kind: 'kpi', label: 'Filed on time', value: 78, target: 90, format: 'percent', detail: 'Within 5 days' },
    { kind: 'kpi', label: 'Passed QC first time', value: 91, format: 'percent' },
    { kind: 'kpi', label: 'Open chases', value: 34, format: 'number', detail: '12 over 30 days' },
    { kind: 'kpi', label: 'Expiring this month', value: 4, format: 'number' },
    {
      kind: 'heatmap',
      title: 'Completeness by site',
      columns: heatColumns,
      rows: [
        heatRow('site_de104', 'DE-104 Berlin', [100, 100, 92, 96, 90, 100]),
        heatRow('site_de107', 'DE-107 Munich', [100, 100, 88, 91, 95, 86]),
        heatRow('site_fr201', 'FR-201 Lyon', [100, 94, 79, 89, 74, 90]),
        heatRow('site_fr203', 'FR-203 Lyon', [90, 100, null, null, null, 80]),
        heatRow('site_es301', 'ES-301 Madrid', [80, 50, null, null, null, 75]),
        heatRow('site_uk401', 'UK-401 Leeds', [100, 96, 85, 82, 61, 100]),
        heatRow('site_us012', 'US-012 Boston', [70, 0, null, null, null, 50]),
      ],
    },
    {
      kind: 'list',
      title: 'Missing or late, oldest first',
      result: {
        entity: 'etmf.expected_document',
        columns: [{ name: 'owner', label: 'Owner', type: 'Text' }, { name: 'days_late', label: 'Days late', type: 'Number' }],
        rows: [
          { entity: 'etmf.expected_document', id: 'exp_sae', title: 'SAE acknowledgement, UK-401', hidden: [], values: { owner: 'Site coordinator', days_late: 41 } },
          { entity: 'etmf.expected_document', id: 'exp_ethics', title: 'Ethics approval of amendment 2, ES-301', hidden: [], values: { owner: 'Spanish country lead', days_late: 33 } },
          { entity: 'etmf.expected_document', id: 'exp_mv', title: 'Monitoring visit follow-up letter, FR-201', hidden: [], values: { owner: 'CRA Julien Morel', days_late: 12 } },
          { entity: 'etmf.expected_document', id: 'exp_5', title: 'Lab certification, US-012', hidden: [], values: { owner: 'Site coordinator', days_late: 9 } },
        ],
        total: 4,
      },
    },
    { kind: 'text', markdown: 'Updated every two weeks by the **TMF health check** playbook.' },
  ],
}

// ---------------------------------------------------------------- automations

export const sampleTriggers: MwTrigger[] = [
  { id: 'activate-site:0', workflowId: 'activate-site', workflowTitle: 'Activate a site', domain: 'etmf', kind: 'entered', description: 'When a site moves to Activating', lastFiredAt: T('2026-10-01T08:00:00'), firings: 9, held: 0 },
  { id: 'watch-expiries:0', workflowId: 'watch-expiries', workflowTitle: 'Watch for expiries', domain: 'etmf', kind: 'date', description: "30 days before a person's CV expires", lastFiredAt: T('2026-10-20T06:00:00'), nextDue: { at: T('2026-10-27T00:00:00'), record: { entity: 'etmf.person', id: 'per_weber', title: 'Dr. Jonas Weber' } }, firings: 42, held: 300 },
  { id: 'tmf-health-check:0', workflowId: 'tmf-health-check', workflowTitle: 'TMF health check', domain: 'etmf', kind: 'every', description: 'Every 2 weeks', lastFiredAt: T('2026-10-20T06:00:00'), nextDue: { at: T('2026-11-03T06:00:00') }, firings: 21, held: 0 },
  { id: 'route-message:0', workflowId: 'route-message', workflowTitle: 'Sort incoming email', domain: 'etmf', kind: 'message', description: 'When an email arrives at etmf', lastFiredAt: T('2026-10-20T08:02:00'), firings: 1312, held: 0 },
  { id: 'client-intake:0', workflowId: 'client-intake', workflowTitle: 'Client intake', domain: 'onboarding', kind: 'created', description: 'When a client is added', firings: 0, held: 0 },
]

// ---------------------------------------------------------------- audit

export const sampleAuditTrail: MwAuditTrail = {
  entity: 'etmf.document',
  id: 'doc_vogel_cv',
  title: 'Investigator CV · Dr. Lena Vogel',
  domain: 'etmf',
  regulated: true,
  retentionDays: 25 * 365,
  values: {},
  versions: [],
  chain: { ok: true },
  signatures: sampleDocumentPage.signatures,
  cases: [],
  flags: sampleDocumentPage.flags,
  exportedAt: T('2026-10-20T10:00:00'),
}

// ---------------------------------------------------------------- a small real PDF for the viewer

/** The CV's text as ASCII lines by page ("Version 2026 rev. B" is left out, so one quote is not found). */
export const samplePdfLines: string[][] = [
  ['Dr. med. Lena Vogel', 'Curriculum vitae', 'Principal Investigator', 'Clinical research experience', 'Charite Berlin, 2012-2026'],
  ['GCP training', 'L. Vogel', 'Signature', '14 Mar 2026', 'Date'],
]

/** A small real PDF (one text line per row, Helvetica) for the playground's viewer. */
export function samplePdf(pages: string[][] = samplePdfLines): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, c => `\\${c}`)
  const pageIds = pages.map((_, i) => 4 + i * 2)
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [i, lines] of pages.entries()) {
    const content = `BT /F1 16 Tf 72 760 Td ${lines.map(l => `(${esc(l)}) Tj 0 -28 Td`).join(' ')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageIds[i]! + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}
