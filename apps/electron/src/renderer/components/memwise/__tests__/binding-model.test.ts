import { describe, expect, test } from 'bun:test'
import i18next from 'i18next'
import type { TFunction } from 'i18next'
import en from '@memwise/shared/i18n/locales/en.json'
import type { MwBinding } from '@memwise/shared/protocol'
import {
  allowedClasses, applyBindingSections, changedSections, loosens, parseTransformText, sectionLines, setCapability, setEntity,
  setFieldRename, setIdentity, setPolicyEffect, setRecordEntity, setRecordField, setRole, setToolClass, toolChoice, transformLabel,
} from '../plugins/binding-model'
import { beforeValue, bindingBadge, identityRows, originLabel, sortPlugins } from '../plugins/plugin-model'

const i18n = i18next.createInstance()
void i18n.init({ resources: { en: { translation: en } }, lng: 'en', fallbackLng: 'en', initAsync: false, interpolation: { escapeValue: false } })
const t = i18n.t.bind(i18n) as unknown as TFunction

const FILE = `# Bound in the app; edit through the binding review.
plugin: memwise/sample-crm
plugin_version: 1.0.0
plugin_hash: 9c1e
version: 0
tools:
  crm.list_contacts: { effect: read }   # from the MCP hints
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
    identity: { keys: [gstin] }

# The last dry run of this content
dry_run: { at: "2026-10-21T02:00:00Z", hash: abc, passed: true, summary: ok }
`

const binding: MwBinding = {
  plugin: 'memwise/sample-crm', pluginVersion: '1.0.0', pluginHash: '9c1e', version: 0,
  tools: { 'crm.list_contacts': { effect: 'read' }, 'crm.create_contact': { effect: 'write', reason: 'Creates a CRM record' } },
  capabilities: {},
  entities: { Client: { entity: 'Customer', fields: { name: 'name', tax_id: 'gstin' } } },
  roles: { staff: 'staff' },
  records: { contact: { entity: 'Customer', fields: { name: { from: 'company_name', transform: ['trim', 'squash'] } }, identity: { keys: ['gstin'] } } },
}

describe('binding edits', () => {
  test('tool classes: pick, turn off, back to declared; never looser than declared', () => {
    let b = setToolClass(binding, 'crm.create_contact', 'outbound')
    expect(b.tools['crm.create_contact']).toEqual({ effect: 'outbound' })
    expect(toolChoice(b, 'crm.create_contact')).toBe('outbound')
    b = setToolClass(b, 'crm.list_contacts', 'off')
    expect(toolChoice(b, 'crm.list_contacts')).toBe('off')
    b = setToolClass(b, 'crm.list_contacts', 'unset')
    expect('crm.list_contacts' in b.tools).toBe(false)
    expect(allowedClasses('write')).toEqual(['write', 'outbound', 'irreversible'])
    expect(allowedClasses()).toHaveLength(5)
    expect(loosens('outbound', 'read')).toBe(true)
    expect(loosens('read', 'outbound')).toBe(false)
    expect(binding.tools['crm.create_contact']!.effect).toBe('write') // pure
  })

  test('capabilities, roles, entities and field renames', () => {
    let b = setCapability(binding, 'email_send', 'email.send')
    expect(b.capabilities).toEqual({ email_send: 'email.send' })
    b = setCapability(b, 'email_send', undefined)
    expect(b.capabilities).toEqual({})
    b = setRole(b, 'manager', 'partner')
    expect(b.roles).toEqual({ staff: 'staff', manager: 'partner' })
    b = setFieldRename(b, 'Client', 'pan', 'pan')
    expect(b.entities.Client!.fields).toEqual({ name: 'name', tax_id: 'gstin', pan: 'pan' })
    b = setFieldRename(b, 'Client', 'tax_id', undefined)
    expect(b.entities.Client!.fields).toEqual({ name: 'name', pan: 'pan' })
    b = setEntity(b, 'Client', 'Party')
    expect(b.entities.Client).toEqual({ entity: 'Party', fields: { name: 'name', pan: 'pan' } })
  })

  test('record mappings and identity rules', () => {
    let b = setRecordField(binding, 'contact', 'gstin', { from: 'gst_number', transform: ['upper'], direction: 'read' })
    expect(b.records.contact!.fields.gstin).toEqual({ from: 'gst_number', transform: ['upper'] })
    b = setRecordField(b, 'contact', 'name', { from: '' })
    expect('name' in b.records.contact!.fields).toBe(false)
    b = setIdentity(b, 'contact', { keys: ['gstin', 'email'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 }, createMissing: false })
    expect(b.records.contact!.identity.keys).toEqual(['gstin', 'email'])
    expect(setRecordEntity(b, 'contact', 'Customer').records.contact).toBe(b.records.contact)
    expect(setRecordEntity(b, 'contact', 'Vendor').records.contact).toEqual({ entity: 'Vendor', fields: {}, identity: { keys: [] } })
  })

  test('transforms typed as words keep the structured ones', () => {
    expect(parseTransformText('Trim, upper  squash x', ['lower', { default: 'n/a' }])).toEqual({ transform: ['trim', 'upper', 'squash', { default: 'n/a' }], unknown: ['x'] })
    expect(transformLabel({ money: 'INR' })).toBe('money: INR')
    expect(transformLabel({ map: { a: 1, b: 2 } })).toBe('map (2)')
  })

  test('policy tightening by effect class', () => {
    let b = setPolicyEffect(binding, 'outbound', 'approve')
    expect(b.policy).toEqual({ effects: { outbound: 'approve' } })
    b = setPolicyEffect(b, 'outbound', undefined)
    expect(b.policy).toBeUndefined()
  })

  test('changed sections ignore key order and empty maps', () => {
    const reordered: MwBinding = { ...binding, roles: { staff: 'staff' }, capabilities: {} }
    expect(changedSections(binding, reordered)).toEqual([])
    expect(changedSections(binding, setRole(binding, 'manager', 'manager'))).toEqual(['roles'])
  })
})

describe('binding YAML', () => {
  test('sections in the file format: snake_case, plain source fields, flow leaves', () => {
    const b = setIdentity(setRecordField(binding, 'contact', 'gstin', { from: 'gst_number' }), 'contact', { keys: ['gstin'], createMissing: true })
    expect(sectionLines('records', b)).toEqual([
      'records:',
      '  contact:',
      '    entity: Customer',
      '    fields: { name: { from: company_name, transform: [trim, squash] }, gstin: gst_number }',
      '    identity: { keys: [gstin], create_missing: true }',
    ])
    expect(sectionLines('capabilities', binding)).toEqual(['capabilities: {}'])
    expect(sectionLines('policy', binding)).toEqual([])
  })

  test('rewrites only the edited sections; comments and other keys stay', () => {
    const b = setToolClass(binding, 'crm.create_contact', 'outbound')
    const out = applyBindingSections(FILE, b, ['tools'])
    expect(out).toContain('# Bound in the app; edit through the binding review.\nplugin: memwise/sample-crm\n')
    expect(out).toContain('tools:\n  crm.list_contacts: { effect: read }\n  crm.create_contact: { effect: outbound }\ncapabilities: {}\n')
    expect(out).toContain('roles: { staff: staff }')
    expect(out).toContain('\n# The last dry run of this content\ndry_run: { at: "2026-10-21T02:00:00Z", hash: abc, passed: true, summary: ok }\n')
    // Unedited sections are byte-for-byte the same
    expect(out.split('records:')[1]).toBe(FILE.split('records:')[1])
  })

  test('a new section goes before dry_run; an emptied policy goes away', () => {
    const withPolicy = applyBindingSections(FILE, setPolicyEffect(binding, 'outbound', 'approve'), ['policy'])
    expect(withPolicy).toContain('    identity: { keys: [gstin] }\n\npolicy:\n  effects: { outbound: approve }\n# The last dry run')
    const removed = applyBindingSections(withPolicy, binding, ['policy'])
    expect(removed).not.toContain('policy:')
  })

  test('values that need quotes get them', () => {
    const b = setRecordField(binding, 'contact', 'name', { transform: [{ template: '{first} {last}' }, { default: 'n/a, none' }] })
    expect(sectionLines('records', b).join('\n')).toContain('name: { transform: [{ template: "{first} {last}" }, { default: "n/a, none" }] }')
  })
})

describe('plugins in words', () => {
  test('binding badge', () => {
    expect(bindingBadge({ binding: { status: 'unbound' } }, t).label).toBe('Not bound')
    expect(bindingBadge({ binding: { status: 'binding', runId: 'r', caseId: 'c' } }, t).label).toBe('Being bound')
    expect(bindingBadge({ binding: { status: 'bound', version: 2, pluginVersion: '1.0.0' } }, t).label).toBe('Bound v2')
    expect(bindingBadge({ binding: { status: 'bound', version: 2, pluginVersion: '1.0.0' }, upgradeAvailable: true }, t).label).toBe('Newer version available')
  })

  test('origin and order', () => {
    expect(originLabel({ kind: 'plugin', plugin: 'memwise/client-intake', pluginTitle: 'Client intake', pluginVersion: '1.0.0' }, t)).toBe('from Client intake 1.0.0')
    const p = (title: string, status: 'unbound' | 'bound') => ({ title, binding: status === 'bound' ? { status, version: 1, pluginVersion: '1' } as const : { status } as const })
    expect(sortPlugins([p('B', 'bound'), p('A', 'bound'), p('C', 'unbound')]).map(x => x.title)).toEqual(['C', 'A', 'B'])
  })

  test('identity rows compare normalised values', () => {
    const rows = identityRows({ fields: ['gstin', 'name', 'email'], record: { gstin: '29abcde1234f1z5', name: 'Acme' }, external: { gstin: '29ABCDE1234F1Z5 ', name: 'Acme Ltd', email: 'a@x' } })
    expect(rows.map(r => r.same)).toEqual([true, false, null])
  })

  test('before value reads a dotted path of the raw record', () => {
    expect(beforeValue({ source: 's', externalId: '1', raw: { a: { b: 'x' } }, values: {}, extra: {}, errors: [], roundTrip: [] }, 'a.b')).toBe('x')
    expect(beforeValue({ source: 's', externalId: '1', values: {}, extra: {}, errors: [], roundTrip: [] }, 'a')).toBeUndefined()
  })
})
