/**
 * Phase 4 DTO mappers (22 §9): plugins, bindings and identity map to the Mw* shapes the screens
 * read, with titles, class sources and plain-words policy, and nothing kernel-only leaking out.
 */
import { describe, expect, it } from 'bun:test'
import type { BindingDef, IdentityCandidate, PluginManifest } from '@memwise/defs'
import type { BindingView, EntityRecordView, PluginDetail } from '@memwise/runtime'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaseTypeDef, WorkflowVersion } from '@memwise/defs'
import { boundPluginTools, entityTools, loadProject, valueTypeToJsonSchema } from '@memwise/defs'
import {
  caseTitle, classFromAnnotations, projectToolInfo, toStep, identityFields, policyDocLines, recordTitle, toBinding, toBindingState, toBindingView, toEntityRecord,
  toIdentityInboxItem, toPluginDetail, toPluginSummary, toVersion, toWorkflowOrigin, versionOrigin,
} from '../dto'
import { readPluginHead } from '../../handlers/rpc/memwise'

const names = new Map([['per_ravi', 'Ravi Menon']])

const manifest: PluginManifest = {
  id: 'memwise/sample-crm', version: '1.1.0', title: 'Sample CRM', trust: 'community',
  provides: { capabilities: {} },
  requires: { capabilities: { email_send: { as: 'email.send' } }, entities: { Client: { name: 'Client', fields: { name: { typeSource: 'PersonName', required: true }, tax_id: { typeSource: 'Identifier(GSTIN)' } } } }, roles: { staff: { id: 'staff', title: 'Staff' } } },
  tools: {
    'crm.list_contacts': { name: 'crm.list_contacts', description: 'List contacts', inputSchema: {}, annotations: { readOnlyHint: true }, run: { mcp: 'crm', tool: 'list_contacts' } },
    'crm.create_contact': { name: 'crm.create_contact', description: 'Create a contact', inputSchema: {}, run: { mcp: 'crm', tool: 'create_contact' } },
    'gst.validate_gstin': { name: 'gst.validate_gstin', description: 'Look up a GSTIN', effect: 'read', inputSchema: {}, run: { builtin: 'gst.validate_gstin' } },
  },
  mcpServers: { crm: { command: 'node', args: ['server.mjs'] }, mail: { source: 'gmail' } },
  workflows: ['client-intake'],
  skills: [],
  records: { contact: { name: 'contact', list: { tool: 'crm.list_contacts', items: 'contacts' }, key: 'id', fields: { company_name: 'Text', gst_number: 'Text' } } },
  policy: { effects: { outbound: 'approve' }, tools: { rules: { 'crm.create_contact': { rateLimit: { count: 30, perMs: 60_000 } } } } },
  importedFrom: { kind: 'claude-plugin', name: 'sample-crm' },
  file: 'plugins/memwise__sample-crm/1.1.0/memwise-plugin.yaml',
}

const binding: BindingDef = {
  plugin: 'memwise/sample-crm', pluginVersion: '1.0.0', pluginHash: 'h1', version: 2,
  frozen: { by: 'per_ravi', at: '2026-10-21T02:10:00Z', runId: 'run_1' },
  tools: { 'crm.create_contact': { effect: 'write', reason: 'Creates a record in the CRM only.' }, 'crm.list_contacts': { off: true } },
  capabilities: { email_send: 'email.send' },
  entities: { Client: { entity: 'Customer', fields: { name: 'name', tax_id: 'gstin' } } },
  roles: { staff: 'staff' },
  records: {
    contact: {
      entity: 'Customer',
      fields: { name: { from: 'company_name', transform: ['trim', 'squash'] }, gstin: { from: 'gst_number', transform: ['upper'] } },
      identity: { keys: ['gstin'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 }, createMissing: false },
    },
  },
  policy: { effects: { write: 'approve' } },
  file: 'domain/bindings/memwise__sample-crm.yaml', hash: 'b1',
}

const project = {
  workflows: {
    'client-intake': { id: 'client-intake', title: 'Client intake', origin: { kind: 'plugin', plugin: 'memwise/sample-crm', pluginVersion: '1.0.0', bindingVersion: 2 } },
  },
  entities: { Customer: { entity: 'Customer', fields: { name: { typeSource: 'Text' }, gstin: { typeSource: 'Identifier(GSTIN)' }, email: { typeSource: 'Email' } } } },
  plugins: { 'memwise/sample-crm': { manifest } },
  bindings: { 'memwise/sample-crm': binding },
} as never

describe('plugins', () => {
  it('summary: binding state with the name of whoever froze it', () => {
    const s = toPluginSummary({
      id: manifest.id, version: '1.1.0', versions: ['1.1.0', '1.0.0'], title: 'Sample CRM', trust: 'community', imported: 'claude-plugin',
      tools: 3, workflows: ['client-intake'], provides: [], requires: ['email_send'],
      binding: { status: 'bound', version: 2, pluginVersion: '1.0.0', frozenBy: 'per_ravi', frozenAt: '2026-10-21T02:10:00Z' },
      upgradeAvailable: true,
    }, names)
    expect(s.binding).toEqual({ status: 'bound', version: 2, pluginVersion: '1.0.0', frozenAt: '2026-10-21T02:10:00Z', frozenBy: 'per_ravi', frozenByName: 'Ravi Menon' })
    expect(s.upgradeAvailable).toBe(true)
    expect(toBindingState({ status: 'binding', runId: 'r', caseId: 'c' }, names)).toEqual({ status: 'binding', runId: 'r', caseId: 'c' })
  })

  it('detail: tools with their class source, hints, routes; servers; live workflows; requirements filled', () => {
    const detail: PluginDetail = {
      id: manifest.id, version: '1.1.0', versions: ['1.1.0'], title: 'Sample CRM', trust: 'community', tools: 3, workflows: ['client-intake'],
      provides: [], requires: ['email_send'], binding: { status: 'unbound' }, manifest, dir: 'plugins/x/1.1.0', hash: 'h', skills: [],
      toolClasses: [
        { name: 'crm.list_contacts', description: 'List contacts', effect: 'read', from: 'annotations', off: true },
        { name: 'crm.create_contact', description: 'Create a contact', effect: 'write', from: 'binding' },
        { name: 'gst.validate_gstin', description: 'Look up a GSTIN', effect: 'read', from: 'declared' },
      ],
      notes: ['Ignored 2 commands'],
    }
    const d = toPluginDetail(detail, { project, names, history: [] })
    expect(d.toolList.map((t) => [t.name, t.effect, t.from, t.route])).toEqual([
      ['crm.list_contacts', 'read', 'annotations', 'mcp'],
      ['crm.create_contact', 'write', 'binding', 'mcp'],
      ['gst.validate_gstin', 'read', 'declared', 'builtin'],
    ])
    expect(d.toolList[0]).toMatchObject({ off: true, hinted: 'read' })
    expect(d.toolList[1]!.reason).toBe('Creates a record in the CRM only.')
    expect(d.servers).toEqual([{ name: 'crm', kind: 'command', detail: 'node server.mjs' }, { name: 'mail', kind: 'source', detail: 'gmail' }])
    expect(d.workflowList).toEqual([{ id: 'client-intake', title: 'Client intake', live: true }])
    expect(d.requiresList).toEqual([{ name: 'email_send', as: 'email.send', boundTo: 'email.send' }])
    expect(d.entities[0]!.fields).toEqual([{ name: 'name', type: 'PersonName', required: true }, { name: 'tax_id', type: 'Identifier(GSTIN)' }])
    expect(d.notes).toEqual(['Ignored 2 commands'])
  })

  it('origin reads as "from <plugin title> <version>"', () => {
    expect(toWorkflowOrigin(project, { kind: 'plugin', plugin: 'memwise/sample-crm', pluginVersion: '1.0.0', bindingVersion: 2 }))
      .toEqual({ kind: 'plugin', plugin: 'memwise/sample-crm', pluginTitle: 'Sample CRM', pluginVersion: '1.0.0', bindingVersion: 2 })
  })

  it('MCP hints: read-only → read, destructive → irreversible, else none', () => {
    expect(classFromAnnotations({ readOnlyHint: true })).toBe('read')
    expect(classFromAnnotations({ destructiveHint: true })).toBe('irreversible')
    expect(classFromAnnotations({ idempotentHint: true })).toBeUndefined()
  })
})

describe('bindings', () => {
  it('binding: camel case data, frozen by name, no file or hash', () => {
    const b = toBinding(binding, names)
    expect(b.frozen).toEqual({ by: 'per_ravi', byName: 'Ravi Menon', at: '2026-10-21T02:10:00Z', runId: 'run_1' })
    expect(b.records.contact!.identity).toEqual({ keys: ['gstin'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 }, createMissing: false })
    expect(b.tools['crm.list_contacts']).toEqual({ off: true })
    expect('file' in b).toBe(false)
  })

  it('policy in plain words', () => {
    expect(policyDocLines(manifest.policy)).toEqual([
      { subject: 'outbound', value: 'needs approval' },
      { subject: 'crm.create_contact rate limit', value: '30 per 1 minute' },
    ])
  })

  it('view: a draft classification wins; providers; stale report', () => {
    const view: BindingView = {
      pluginId: manifest.id, draftId: 'bind-1', binding: { ...binding, tools: { 'crm.create_contact': { effect: 'outbound' } } },
      text: 'plugin: memwise/sample-crm\n', path: binding.file, gaps: [{ kind: 'tool-unclassified', subject: 'crm.list_contacts', message: 'No class' }],
      report: {
        plugin: manifest.id, draftId: 'bind-1', hash: 'old', at: '2026-10-21T00:00:00Z', diagnostics: [], errors: 0, warnings: 0, examples: [],
        records: [{ source: 'contact', externalId: 'c1', values: { name: 'Acme' }, extra: { 'crm.phone': '1' }, errors: [], roundTrip: [] }],
        impact: [{ workflowId: 'client-intake', states: {}, transitions: [], steps: {}, caseFields: { added: [], removed: [], changed: [] }, tools: { added: [], removed: [] }, requiredTools: [], roles: { added: [], removed: [] }, examples: { added: [], removed: [], changed: [] }, version: {}, playbook: [] }],
        outcome: 'passed', summary: 'ok',
      },
    }
    const v = toBindingView(view, { project, names, editable: true, contentHash: 'new' })
    expect(v.editable).toBe(true)
    expect(v.reportStale).toBe(true)
    expect(v.tools.find((t) => t.name === 'crm.create_contact')).toMatchObject({ effect: 'outbound', from: 'binding' })
    expect(v.tools.find((t) => t.name === 'crm.list_contacts')).toMatchObject({ from: 'annotations', effect: 'read', hinted: 'read' })
    expect(v.capabilities).toEqual([{ name: 'email_send', as: 'email.send', providers: ['email.send'] }])
    expect(v.domainEntities[0]!.fields.map((f) => f.name)).toEqual(['name', 'gstin', 'email'])
    expect(v.report!.impact![0]).toMatchObject({ workflowId: 'client-intake', title: 'Client intake' })
    expect(v.pluginPolicy[0]).toEqual({ subject: 'outbound', value: 'needs approval' })
    expect(v.bindingPolicy).toEqual([{ subject: 'write', value: 'needs approval' }])
    // The live binding (no draft) is never editable
    expect(toBindingView({ ...view, draftId: undefined }, { project, names, editable: true }).editable).toBe(false)
  })
})

describe('identity', () => {
  const candidate: IdentityCandidate = {
    id: 'idc_1', entity: 'Customer', recordId: 'cus_1', plugin: 'memwise/sample-crm', source: 'contact', externalId: 'c7',
    score: 0.82, reasons: ['name 0.82 similar'], external: { name: 'Acme Traders Pvt Ltd', email: 'a@acme.example', gstin: '29ABCDE1234F1Z5' },
    status: 'pending', createdAt: '2026-10-21T03:00:00Z',
  }

  it('inbox item: side by side, keys first, titled by the record', () => {
    const item = toIdentityInboxItem({ id: 'identity:idc_1', candidate, since: candidate.createdAt }, project, { name: 'Acme Traders', gstin: '29ABCDE1234F1Z5' })
    expect(item).toMatchObject({ kind: 'identity', candidateId: 'idc_1', caseTitle: 'Acme Traders', stepTitle: 'Same customer?', pluginTitle: 'Sample CRM' })
    expect(item.fields).toEqual(['gstin', 'name', 'email'])
    expect('caseId' in item).toBe(false)
  })

  it('fields without a binding: what either side has', () => {
    expect(identityFields(undefined, 'contact', { a: 1 }, { b: 2 })).toEqual(['b', 'a'])
  })

  it('record: hidden fields nulled, read-through values carry their plugin', () => {
    const r: EntityRecordView = {
      entity: 'Customer', id: 'cus_1', values: { name: 'Acme Traders', pan: 'AAACA1234A' }, hidden: ['pan'], createdAt: '2026-10-20T00:00:00Z',
      links: [{ id: 'link_1', entity: 'Customer', recordId: 'cus_1', plugin: 'memwise/sample-crm', source: 'contact', externalId: 'c7', method: 'person', score: 0.82, reasons: [], linkedBy: 'per_ravi', at: '2026-10-21T03:05:00Z', values: { email: 'a@acme.example' } }],
      readThrough: { email: { plugin: 'memwise/sample-crm', value: 'a@acme.example' }, pan: { plugin: 'memwise/sample-crm', value: 'x' } },
    }
    const m = toEntityRecord(r, project, names)
    expect(m.title).toBe('Acme Traders')
    expect(m.values.pan).toMatchObject({ value: null, hidden: true })
    expect(m.links[0]).toMatchObject({ pluginTitle: 'Sample CRM', method: 'person', linkedByName: 'Ravi Menon', values: { email: 'a@acme.example' } })
    expect(m.readThrough).toEqual({ email: { plugin: 'memwise/sample-crm', pluginTitle: 'Sample CRM', value: 'a@acme.example' } })
  })

  it('record: a linked record shows no field hidden from the actor, and no unmapped extras then', () => {
    const link = { id: 'link_1', entity: 'Customer', recordId: 'cus_1', plugin: 'memwise/sample-crm', source: 'contact', externalId: 'c7', method: 'key' as const, score: 1, reasons: [], at: '2026-10-21T03:05:00Z' }
    const r: EntityRecordView = {
      entity: 'Customer', id: 'cus_1', values: { name: 'Acme Traders' }, hidden: ['email'], createdAt: '2026-10-20T00:00:00Z',
      links: [{ ...link, values: { name: 'Acme', email: 'a@acme.example' }, extra: { 'crm.email_2': 'b@acme.example' } }],
      readThrough: {},
    }
    const m = toEntityRecord(r, project, names)
    expect(m.links[0]!.values).toEqual({ name: 'Acme' })
    expect(m.links[0]!.extra).toBeUndefined()
    // Nothing hidden: everything shows.
    const all = toEntityRecord({ ...r, hidden: [] }, project, names)
    expect(all.links[0]).toMatchObject({ values: { name: 'Acme', email: 'a@acme.example' }, extra: { 'crm.email_2': 'b@acme.example' } })
  })

  it('record title falls back to the entity and a short id', () => {
    expect(recordTitle('Customer', 'cus_0123456789', {})).toBe('Customer 456789')
  })
})

describe('Phase 4 walkthrough fixes', () => {
  it('a bind-plugin case is named by the plugin, never its draft', () => {
    const caseType = { id: 'plugin_binding', fields: { draft: { typeSource: 'Text' }, plugin: { typeSource: 'Text' } } } as unknown as CaseTypeDef
    const values = { draft: 'memwise__sample-crm-mvh1vciv', plugin: 'memwise/sample-crm' }
    expect(caseTitle(values, 'case_0123456789', caseType, project)).toBe('Bind Sample CRM')
    // Not installed (or no project at hand): the plugin id.
    expect(caseTitle({ ...values, plugin: 'acme/other' }, 'case_0123456789', caseType, project)).toBe('Bind acme/other')
    expect(caseTitle(values, 'case_0123456789', caseType)).toBe('Bind memwise/sample-crm')
    // Values with provenance, as the case summary holds them.
    expect(caseTitle({ draft: { value: values.draft }, plugin: { value: values.plugin } }, 'case_1', caseType, project)).toBe('Bind Sample CRM')
  })

  it('a plugin playbook\'s versions say which binding made them', () => {
    const v: WorkflowVersion = { workflowId: 'client-intake', version: 2, hash: 'h_live', publishedAt: '2026-10-21T02:11:00Z', source: 'files', openCases: 0, live: true }
    const wf = { hash: 'h_live', origin: { kind: 'plugin' as const, plugin: 'memwise/sample-crm', pluginVersion: '1.0.0', bindingVersion: 2 } }
    const bindings = [
      { version: 2, pluginVersion: '1.0.0', frozenAt: '2026-10-21T02:10:00Z' },
      { version: 1, pluginVersion: '0.9.0', frozenAt: '2026-10-01T09:00:00Z' },
    ]
    const live = versionOrigin(v, wf, project, bindings)
    expect(live).toEqual({ kind: 'plugin', plugin: 'memwise/sample-crm', pluginTitle: 'Sample CRM', pluginVersion: '1.0.0', bindingVersion: 2 })
    expect(toVersion(v, names, live).origin).toEqual(live)
    // An older version: the binding frozen last before it was indexed.
    expect(versionOrigin({ ...v, hash: 'h_old', publishedAt: '2026-10-01T09:00:05Z' }, wf, project, bindings))
      .toMatchObject({ pluginVersion: '0.9.0', bindingVersion: 1 })
    // Authored playbooks, and versions published through review, keep their own line.
    expect(versionOrigin(v, { hash: 'h_live' }, project, bindings)).toBeUndefined()
    expect(versionOrigin({ ...v, source: 'app' }, wf, project, bindings)).toBeUndefined()
    expect(toVersion(v, names).origin).toBeUndefined()
  })

  it('the Install dialog reads a folded description as text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-head-'))
    try {
      writeFileSync(join(dir, 'memwise-plugin.yaml'), [
        'id: acme/folded   # a comment',
        'version: 1.0.0',
        'title: "Folded: plugin"',
        'description: >',
        '  Reads the first line',
        '  and the second.',
        'tools: {}',
        '',
      ].join('\n'))
      expect(await readPluginHead(dir)).toEqual({ id: 'acme/folded', title: 'Folded: plugin', description: 'Reads the first line and the second.' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Literature walkthrough: tools on the playbook page', () => {
  it('a step\'s plugin and entity tools have the class the kernel binds them with, not "can\'t be undone"', async () => {
    const { project } = await loadProject(join(import.meta.dir, '..', '..', '..', '..', '..', 'examples', 'literature'))
    const builtins = new Map([['PubMed.search_articles', { name: 'PubMed.search_articles', description: 'from the builtin', effect: 'irreversible' as const }]])
    const tools = projectToolInfo(new Map(), builtins, entityTools(project.entities), boundPluginTools(project))
    const wf = project.workflows['set-up-watch']!
    const step = Object.values(wf.steps).find((s) => s.title === 'Draft the PubMed search')!
    const out = toStep({ project, diagnostics: [], tools, jsonSchema: valueTypeToJsonSchema }, wf, step)
    expect(out.tools.map((t) => [t.name, t.effect, t.classified])).toEqual([
      ['literature.topic.get', 'read', true],
      ['PubMed.search_articles', 'read', true],
      ['PubMed.get_article_metadata', 'read', true],
    ])
    // The binding's class wins over a builtin of the same name; the plugin is named.
    expect(out.tools[1]).toMatchObject({ plugin: 'claude/pubmed', required: true })
    expect(tools.get('literature.topic.create')?.effect).toBe('write')
    // A tool passed directly keeps its own entry.
    const direct = projectToolInfo(new Map([['literature.topic.get', { name: 'literature.topic.get', effect: 'write' as const }]]), new Map(), entityTools(project.entities), {})
    expect(direct.get('literature.topic.get')?.effect).toBe('write')
  })
})
