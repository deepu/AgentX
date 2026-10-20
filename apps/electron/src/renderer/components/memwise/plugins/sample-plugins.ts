/**
 * Sample data for the Plugins screens (previews and render tests): a CRM plugin being bound,
 * its binding under review, an identity match in the inbox, and a linked record.
 */

import type {
  MwBindingView, MwEntityRecord, MwEntityRow, MwEntityType, MwInboxItem, MwInstallChoices, MwPluginDetail, MwPluginSummary,
} from '@memwise/shared/protocol'

const crmSummary: MwPluginSummary = {
  id: 'memwise/sample-crm',
  version: '1.0.0',
  versions: ['1.0.0'],
  title: 'Sample CRM',
  description: 'Contacts and deals from a CRM, read through MCP.',
  trust: 'first-party',
  tools: 3,
  workflows: ['crm-follow-up'],
  provides: ['crm.contacts'],
  requires: ['email_send'],
  binding: { status: 'binding', runId: 'run_bind1', caseId: 'case_bind1', draftId: 'draft_bind1' },
}

export const samplePlugins: MwPluginSummary[] = [
  crmSummary,
  {
    id: 'memwise/client-intake',
    version: '1.1.0',
    versions: ['1.1.0', '1.0.0'],
    title: 'Client intake',
    trust: 'verified',
    tools: 1,
    workflows: ['client-intake'],
    provides: [],
    requires: [],
    binding: { status: 'bound', version: 2, pluginVersion: '1.0.0', frozenAt: '2026-10-18T09:00:00Z', frozenByName: 'Asha Rao' },
    upgradeAvailable: true,
  },
  {
    id: 'claude/notes',
    version: '0.2.0',
    versions: ['0.2.0'],
    title: 'Notes',
    trust: 'local',
    imported: 'claude-plugin',
    tools: 0,
    workflows: [],
    provides: [],
    requires: [],
    binding: { status: 'unbound' },
  },
]

export const sampleEntityTypes: MwEntityType[] = [
  {
    name: 'Customer',
    fields: [
      { name: 'name', type: 'Text', schema: { type: 'string' } },
      { name: 'gstin', type: 'Identifier(GSTIN)', schema: { type: 'string' } },
      { name: 'email', type: 'Email', schema: { type: 'string' } },
    ],
  },
]

export const samplePluginDetail: MwPluginDetail = {
  ...crmSummary,
  dir: '/Users/asha/.memwise/plugins/memwise/sample-crm/1.0.0',
  hash: '9c1e0a7d55f2b3c4',
  toolList: [
    { name: 'crm.list_contacts', description: 'List contacts.', effect: 'read', from: 'annotations', hinted: 'read', route: 'mcp', capability: 'crm.contacts' },
    { name: 'crm.create_contact', description: 'Create a contact.', effect: 'write', from: 'binding', reason: 'Creates a CRM record', route: 'mcp' },
    { name: 'crm.delete_contact', description: 'Delete a contact.', from: 'none', route: 'mcp' },
  ],
  workflowList: [{ id: 'crm-follow-up', title: 'CRM follow-up', live: false }],
  skills: [{ name: 'crm-etiquette', description: 'How to write to CRM contacts.' }],
  providesList: [{ name: 'crm.contacts', tool: 'crm.list_contacts' }],
  requiresList: [{ name: 'email_send', as: 'email.send' }],
  entities: [{ name: 'Client', fields: [{ name: 'name', type: 'Text', required: true }, { name: 'tax_id', type: 'Text' }] }],
  roles: [{ id: 'staff', title: 'Staff' }],
  records: [{ name: 'contact', title: 'Contacts', key: 'id', fields: { id: 'string', company_name: 'string', gst_number: 'string', email: 'string' } }],
  servers: [{ name: 'crm', kind: 'command', detail: 'node server.js' }],
  notes: [],
  bindingHistory: [],
}

export const sampleBindingView: MwBindingView = {
  pluginId: 'memwise/sample-crm',
  pluginTitle: 'Sample CRM',
  pluginVersion: '1.0.0',
  draftId: 'draft_bind1',
  editable: true,
  path: 'domain/bindings/sample-crm.yaml',
  text: `plugin: memwise/sample-crm
plugin_version: 1.0.0
plugin_hash: 9c1e
version: 0
tools:
  crm.list_contacts: { effect: read }
  crm.create_contact: { effect: write, reason: "Creates a CRM record" }
capabilities: {}
entities:
  Client: { entity: Customer, fields: { name: name, tax_id: gstin } }
roles: { staff: staff }
records:
  contact:
    entity: Customer
    fields:
      name: { from: company_name, transform: [trim, squash] }
      gstin: { from: gst_number, transform: [upper] }
    identity: { keys: [gstin], fuzzy: { field: name, auto: 0.95, review: 0.75 } }
`,
  binding: {
    plugin: 'memwise/sample-crm',
    pluginVersion: '1.0.0',
    pluginHash: '9c1e',
    version: 0,
    tools: { 'crm.list_contacts': { effect: 'read' }, 'crm.create_contact': { effect: 'write', reason: 'Creates a CRM record' } },
    capabilities: {},
    entities: { Client: { entity: 'Customer', fields: { name: 'name', tax_id: 'gstin' } } },
    roles: { staff: 'staff' },
    records: {
      contact: {
        entity: 'Customer',
        fields: { name: { from: 'company_name', transform: ['trim', 'squash'] }, gstin: { from: 'gst_number', transform: ['upper'] } },
        identity: { keys: ['gstin'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 } },
      },
    },
  },
  gaps: [
    { kind: 'tool-unclassified', subject: 'crm.delete_contact', message: 'crm.delete_contact has no effect class.', suggestions: ['irreversible'] },
    { kind: 'capability-missing', subject: 'email_send', message: 'Nothing provides email_send.' },
  ],
  report: {
    hash: 'old',
    at: '2026-10-20T11:30:00Z',
    diagnostics: [],
    errors: 0,
    warnings: 0,
    examples: [],
    records: [
      {
        source: 'contact',
        externalId: 'c-101',
        raw: { company_name: '  Acme   Traders ', gst_number: '29abcde1234f1z5' },
        values: { name: 'Acme Traders', gstin: '29ABCDE1234F1Z5' },
        extra: { email: 'ops@acme.example' },
        errors: [],
        roundTrip: [],
      },
    ],
    outcome: 'passed',
    summary: 'Mapped 1 record.',
  },
  reportStale: true,
  tools: samplePluginDetail.toolList,
  capabilities: [{ name: 'email_send', as: 'email.send', providers: ['email.send'] }],
  entities: samplePluginDetail.entities,
  domainEntities: [
    { name: 'Customer', fields: [{ name: 'name', type: 'Text' }, { name: 'gstin', type: 'Identifier(GSTIN)' }, { name: 'email', type: 'Email' }] },
  ],
  roles: [{ id: 'staff', title: 'Staff' }],
  records: samplePluginDetail.records,
  pluginPolicy: [{ subject: 'write', value: 'needs approval' }],
  bindingPolicy: [],
  run: { runId: 'run_bind1', caseId: 'case_bind1', state: 'fix' },
}

export const sampleBindingInbox: Extract<MwInboxItem, { kind: 'input' }> = {
  kind: 'input',
  id: 'in_bind_fix',
  stepRunId: 'sr_bind_fix',
  caseId: 'case_bind1',
  runId: 'run_bind1',
  caseTitle: 'Bind Sample CRM',
  workflowId: 'bind-plugin',
  stepTitle: 'Settle what the agent could not',
  fields: [],
  prefill: {},
  outcomes: ['done'],
  context: {},
  since: '2026-10-20T11:40:00Z',
  binding: { pluginId: 'memwise/sample-crm', draftId: 'draft_bind1', mode: 'edit' },
}

export const sampleBindingReviewInbox: Extract<MwInboxItem, { kind: 'decision' }> = {
  kind: 'decision',
  id: 'in_bind_review',
  stepRunId: 'sr_bind_review',
  caseId: 'case_bind1',
  runId: 'run_bind1',
  caseTitle: 'Bind Sample CRM',
  workflowId: 'bind-plugin',
  stepTitle: 'Review the binding',
  instructions: '',
  outcomes: ['approved', 'changes_requested'],
  context: {},
  since: '2026-10-20T11:50:00Z',
  binding: { pluginId: 'memwise/sample-crm', draftId: 'draft_bind1', mode: 'review' },
}

export const sampleIdentityInbox: Extract<MwInboxItem, { kind: 'identity' }> = {
  kind: 'identity',
  id: 'idc_1',
  candidateId: 'idc_1',
  caseTitle: 'Sample CRM',
  stepTitle: 'Same customer?',
  entity: 'Customer',
  recordId: 'ent_customer_1',
  plugin: 'memwise/sample-crm',
  pluginTitle: 'Sample CRM',
  source: 'contact',
  externalId: 'c-102',
  score: 0.82,
  reasons: ['Names are close (0.82)', 'Same city'],
  record: { name: 'Acme Traders', gstin: '29ABCDE1234F1Z5', email: 'ops@acme.example' },
  external: { name: 'Acme Traders Pvt Ltd', gstin: '29ABCDE1234F1Z5 ', email: '' },
  fields: ['gstin', 'name', 'email'],
  since: '2026-10-20T11:55:00Z',
}

export const sampleEntityRows: MwEntityRow[] = [
  {
    id: 'ent_customer_1',
    values: {
      name: { value: 'Acme Traders', provenance: { kind: 'person', at: '2026-10-01T10:00:00Z', by: 'p_asha' } },
      gstin: { value: '29ABCDE1234F1Z5', provenance: { kind: 'person', at: '2026-10-01T10:00:00Z', by: 'p_asha' } },
    },
    createdAt: '2026-10-01T10:00:00Z',
    links: [{ plugin: 'memwise/sample-crm', pluginTitle: 'Sample CRM', source: 'contact', method: 'key' }],
  },
]

export const sampleEntityRecord: MwEntityRecord = {
  entity: 'Customer',
  id: 'ent_customer_1',
  title: 'Acme Traders',
  values: sampleEntityRows[0]!.values,
  createdAt: '2026-10-01T10:00:00Z',
  links: [{
    id: 'lnk_1',
    plugin: 'memwise/sample-crm',
    pluginTitle: 'Sample CRM',
    source: 'contact',
    method: 'key',
    externalId: 'c-101',
    score: 1,
    reasons: ['Same GSTIN'],
    at: '2026-10-20T11:31:00Z',
    values: { name: 'Acme Traders', gstin: '29ABCDE1234F1Z5' },
    extra: { email: 'ops@acme.example' },
  }],
  readThrough: { email: { plugin: 'memwise/sample-crm', pluginTitle: 'Sample CRM', value: 'ops@acme.example' } },
}

export const sampleInstallChoices: MwInstallChoices = {
  examples: [
    { slug: 'sample-crm', name: 'Sample CRM', dir: '/app/examples/plugins/sample-crm', pluginId: 'memwise/sample-crm', installed: '1.0.0' },
    { slug: 'client-intake', name: 'Client intake', dir: '/app/examples/plugins/client-intake', description: 'Take in a new client.' },
  ],
  sources: [{ slug: 'linear', name: 'Linear', dir: '/Users/asha/.memwise/workspaces/w/sources/linear', pluginId: 'source/linear' }],
  canInstall: true,
  canInstallPath: true,
}
