/**
 * Literature watch sample pages (25 §4–§5) for tests and the playground: a Topic with KPI tiles,
 * a bar chart, a forest plot and "Ask about this topic"; an Article with its abstract and the
 * quotes its values were read from; a free page with charts. Illustrative numbers, not real
 * trial results.
 */

import type { MwDashboard, MwRecordField, MwRecordPage } from '@memwise/shared/protocol'

const T = (iso: string) => `${iso}.000Z`
const calculated = { kind: 'calculated' } as const
const memwiseOwned = { kind: 'domain' } as const
const pubmed = { kind: 'plugin', plugin: 'pubmed', title: 'PubMed' } as const
const extract = { kind: 'step', stepRunId: 'sr_save', workflowId: 'read-paper', label: 'Read a paper' } as const

function field(f: Partial<MwRecordField> & Pick<MwRecordField, 'name' | 'type' | 'value' | 'source'>): MwRecordField {
  return { label: f.name.charAt(0).toUpperCase() + f.name.slice(1).replace(/_/g, ' '), editable: false, ...f }
}

const topicRef = { entity: 'literature.topic', id: 'top_glp1', title: 'GLP-1 agonists and blood pressure', status: 'watching' }
const evidence = (id: string, title: string, values: Record<string, unknown>, status = 'kept') => ({ entity: 'literature.evidence', id, title, status, values })

const base = {
  domain: 'literature',
  domainName: 'Literature',
  regulated: false,
  parents: [],
  cases: [],
  flags: [],
  signatures: [],
  mentions: [],
  documents: {},
  history: [],
} satisfies Partial<MwRecordPage>

export const sampleTopicPage: MwRecordPage = {
  ...base,
  entity: 'literature.topic',
  entityName: 'Topic',
  id: topicRef.id,
  title: topicRef.title,
  status: 'watching',
  layout: {
    layout: 'sidebar',
    header: ['title', 'status', 'next_check'],
    areas: {
      main: [
        { kind: 'kpis', fields: ['included', 'excluded', 'evidence_kept', 'evidence_reviewed'] },
        { kind: 'chart', chart: 'bar', of: 'screenings', by: 'year', where: "status = 'included'", title: 'Included papers by year' },
        { kind: 'chart', chart: 'interval', of: 'evidence', label: '{intervention} vs {comparator}', value: 'effect', low: 'ci_low', high: 'ci_high', unit: 'unit', where: "status != 'rejected'", title: 'Effect vs comparator' },
        { kind: 'related', relationships: ['evidence'] },
      ],
      side: [{ kind: 'details' }, { kind: 'lifecycle' }, { kind: 'chat' }],
    },
  },
  fields: [
    field({ name: 'query', type: 'Text', value: '("GLP-1 receptor agonist") AND (blood pressure)', source: memwiseOwned, editable: true }),
    field({ name: 'status', type: 'Lifecycle', value: 'watching', source: memwiseOwned }),
    field({ name: 'last_checked', label: 'Last checked', type: 'DateTime', value: T('2026-10-20T07:00:00'), source: memwiseOwned }),
    field({ name: 'next_check', label: 'Next check', type: 'Date', value: '2026-10-27', source: memwiseOwned }),
    field({ name: 'included', type: 'Number', value: 42, source: calculated, calculated: true }),
    field({ name: 'excluded', type: 'Number', value: 131, source: calculated, calculated: true }),
    field({ name: 'evidence_kept', label: 'Evidence kept', type: 'Number', value: 6, source: calculated, calculated: true }),
    field({ name: 'evidence_reviewed', label: 'Evidence reviewed', type: 'Percentage', value: 66.7, source: calculated, calculated: true }),
  ],
  related: {
    evidence: {
      entity: 'literature.evidence',
      label: 'Evidence',
      total: 3,
      rows: [
        evidence('ev_1', 'Drug A vs placebo', { effect: -4.2, unit: 'mmHg' }, 'reviewed'),
        evidence('ev_2', 'Drug B vs placebo', { effect: -6.8, unit: 'mmHg' }),
        evidence('ev_3', 'Drug A vs Drug C', { effect: -1.1, unit: 'mmHg' }),
      ],
    },
  },
  lifecycle: { states: ['draft', 'watching', 'paused'], current: 'watching', transitions: [{ name: 'pause', label: 'Pause', to: 'paused', allowed: true }] },
  start: [{ workflowId: 'check-topic', title: 'Check for new papers' }],
  kpis: {
    included: { field: 'included', value: 42, type: 'Number' },
    excluded: { field: 'excluded', value: 131, type: 'Number' },
    evidence_kept: { field: 'evidence_kept', value: 6, type: 'Number' },
    evidence_reviewed: { field: 'evidence_reviewed', value: 66.7, type: 'Percentage', description: 'Of kept evidence, reviewed' },
  },
  charts: {
    'main:1': {
      kind: 'bar',
      title: 'Included papers by year',
      data: [{ label: '2021', value: 4, key: '2021' }, { label: '2022', value: 7, key: '2022' }, { label: '2023', value: 9, key: '2023' }, { label: '2024', value: 12, key: '2024' }, { label: '2025', value: 10, key: '2025' }],
      total: 42,
    },
    'main:2': {
      kind: 'interval',
      title: 'Effect vs comparator',
      unit: 'mmHg',
      data: [
        { label: 'Drug A vs placebo', value: -4.2, low: -6.1, high: -2.3, record: { entity: 'literature.evidence', id: 'ev_1', title: 'Drug A vs placebo' } },
        { label: 'Drug B vs placebo', value: -6.8, low: -9.0, high: -4.6, record: { entity: 'literature.evidence', id: 'ev_2', title: 'Drug B vs placebo' } },
        { label: 'Drug A vs Drug C', value: -1.1, low: -3.4, high: 1.2, record: { entity: 'literature.evidence', id: 'ev_3', title: 'Drug A vs Drug C' } },
      ],
      total: 3,
      skipped: 1,
    },
  },
}

const ABSTRACT = [
  'Background: Whether once-weekly Drug A lowers blood pressure in adults with type 2 diabetes is unclear.',
  'Methods: In this randomised, double-blind, placebo-controlled phase 3 trial, 1204 adults were assigned to Drug A or placebo for 52 weeks. The trial was funded by Example Pharma.',
  'Results: Systolic blood pressure fell by 4·2 mmHg more with Drug A than with placebo (95% CI −6·1 to −2·3).',
].join('\n\n')

const at = (quote: string) => ({ start: ABSTRACT.indexOf(quote), end: ABSTRACT.indexOf(quote) + quote.length })

export const sampleArticlePage: MwRecordPage = {
  ...base,
  entity: 'literature.article',
  entityName: 'Article',
  id: 'art_1',
  title: 'Drug A and blood pressure in type 2 diabetes: a randomised trial',
  status: 'read',
  parents: [topicRef],
  layout: {
    layout: 'split',
    header: ['title', 'status', 'journal', 'year'],
    areas: {
      left: [{ kind: 'fields', fields: ['study_type', 'phase', 'n', 'sponsor', 'intervention', 'condition'] }, { kind: 'related', relationships: ['evidence'] }],
      right: [{ kind: 'viewer', field: 'abstract' }],
    },
  },
  fields: [
    field({ name: 'pmid', label: 'PMID', type: 'Text', value: '00000000', source: pubmed }),
    field({ name: 'journal', type: 'Text', value: 'Example Journal of Medicine', source: pubmed }),
    field({ name: 'year', type: 'Number', value: 2025, source: pubmed }),
    field({ name: 'abstract', type: 'Text', value: ABSTRACT, source: pubmed }),
    field({ name: 'study_type', label: 'Study type', type: 'Text', value: 'Randomised controlled trial', source: extract }),
    field({ name: 'phase', type: 'Text', value: 'Phase 3', source: extract }),
    field({ name: 'n', label: 'Sample size', type: 'Number', value: 1204, source: extract }),
    field({ name: 'sponsor', type: 'Text', value: 'Example Pharma', source: extract }),
    field({ name: 'intervention', type: 'Text', value: 'Drug A, once weekly', source: extract }),
    field({ name: 'condition', type: 'Text', value: 'Type 2 diabetes', source: extract }),
  ],
  related: {
    evidence: { entity: 'literature.evidence', label: 'Evidence', total: 1, rows: [evidence('ev_1', 'Drug A vs placebo', { effect: -4.2, unit: 'mmHg' }, 'reviewed')] },
  },
  start: [],
  texts: {
    abstract: {
      text: ABSTRACT,
      highlights: [
        { quote: 'randomised, double-blind, placebo-controlled', field: 'study_type', label: 'Study type', kind: 'value', value: 'Randomised controlled trial', found: true, ...at('randomised, double-blind, placebo-controlled') },
        { quote: 'phase 3 trial', field: 'phase', label: 'Phase', kind: 'value', value: 'Phase 3', found: true, ...at('phase 3 trial') },
        { quote: '1204 adults', field: 'n', label: 'Sample size', kind: 'value', value: 1204, found: true, ...at('1204 adults') },
        { quote: 'funded by Example Pharma', field: 'sponsor', label: 'Sponsor', kind: 'value', value: 'Example Pharma', found: true, ...at('funded by Example Pharma') },
        { quote: 'fell by 4.2 mmHg more with Drug A than with placebo (95% CI -6.1 to -2.3)', field: 'quote', label: 'Quote', kind: 'related', record: { entity: 'literature.evidence', id: 'ev_1', title: 'Drug A vs placebo' }, found: true },
        { quote: 'once-daily oral tablet', field: 'intervention', label: 'Intervention', kind: 'value', value: 'Drug A, once weekly', found: false },
      ],
    },
  },
}

export const sampleLiteratureDashboard: MwDashboard = {
  pageId: 'overview',
  domain: 'literature',
  title: 'Literature overview',
  description: 'What the watch found across topics',
  params: {},
  computedAt: T('2026-10-20T09:00:00'),
  blocks: [
    { kind: 'kpi', label: 'Topics watched', value: 3 },
    { kind: 'kpi', label: 'Evidence reviewed', value: 66.7, format: 'percent', target: 80 },
    { kind: 'chart', chart: { kind: 'donut', title: 'Screenings by decision', data: [{ label: 'Included', value: 42, key: 'included' }, { label: 'Excluded', value: 131, key: 'excluded' }, { label: 'Not set', value: 5, key: null }], total: 178 } },
    { kind: 'chart', chart: { kind: 'line', title: 'Papers screened per month', data: ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'].map((label, i) => ({ label, value: [12, 18, 15, 22, 30, 26][i]! })), total: 123 } },
  ],
}
