/**
 * The client intake playbook (examples/intake) as the app API would return it, built by hand for
 * the playground and the render tests. Keep it close to the files in examples/intake.
 */

import type { MwField, MwLiveCounts, MwPlaybook, MwPolicyRule, MwRole } from '@memwise/shared/protocol'

const DAY = 24 * 60 * 60 * 1000

const STRING = { type: 'string' }

function field(name: string, type: string, schema: Record<string, unknown> = STRING, extra: Partial<MwField> = {}): MwField {
  return { name, type, schema, ...extra }
}

const caseFields: MwField[] = [
  field('client_name', 'PersonName', STRING, { required: true }),
  field('client_email', 'Email', { type: 'string', format: 'email' }, { required: true }),
  field('pan', 'Identifier(PAN)', { type: 'string', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' }, { required: true }),
  field('gstin', 'Identifier(GSTIN)', { type: 'string', pattern: '^[0-9]{2}[A-Z0-9]{13}$' }, { required: true }),
  field('annual_turnover', 'Money', { type: 'object' }),
  field('documents', 'List<Document>', { type: 'array' }),
  field('gstin_ok', 'Boolean', { type: 'boolean' }),
  field('legal_name', 'Text'),
  field('flags', 'List<Flag>', { type: 'array' }),
  field('customer', 'Ref<Customer>'),
  field('status', 'Enum[draft, submitted, checked, approved, rejected]'),
]

const byName = (names: string[]) => names.map((n) => caseFields.find((f) => f.name === n)!)

const PLAYBOOK_POLICY = 'workflows/client-intake/policy.yaml'
const DOMAIN_POLICY = 'domain/policy.yaml'

/** Rules every step of intake runs under. */
const common: MwPolicyRule[] = [
  { subject: 'read', value: 'allowed', layer: 'platform', layerName: 'Platform' },
  { subject: 'draft', value: 'allowed', layer: 'platform', layerName: 'Platform' },
  { subject: 'write', value: 'allowed', layer: 'platform', layerName: 'Platform' },
  { subject: 'outbound', value: 'needs approval', layer: 'domain', layerName: 'Domain', source: DOMAIN_POLICY },
  { subject: 'irreversible', value: 'denied', layer: 'workflow', layerName: 'client-intake', source: PLAYBOOK_POLICY },
  { subject: 'payments.transfer', value: 'denied', layer: 'domain', layerName: 'Domain', source: DOMAIN_POLICY },
  { subject: 'tokens', value: '100,000', layer: 'workflow', layerName: 'client-intake', source: PLAYBOOK_POLICY },
  { subject: 'model calls', value: '60', layer: 'domain', layerName: 'Domain', source: DOMAIN_POLICY },
]

const override = (rules: MwPolicyRule[], changes: MwPolicyRule[]): MwPolicyRule[] => [
  ...rules.filter((r) => !changes.some((c) => c.subject === r.subject)),
  ...changes,
]

export const samplePlaybook: MwPlaybook = {
  id: 'client-intake',
  version: 1,
  hash: 'sha256:5f1c0d9e4b7a',
  title: 'Client intake',
  start: 'fill',
  states: [
    { id: 'fill', stepId: 'fill', on: { submitted: 'check' }, wait: { remindMs: 3 * DAY, timeout: { afterMs: 7 * DAY, target: 'needs_person' } } },
    { id: 'check', stepId: 'check', on: { checked: 'verify', needs_info: 'fill', failed: 'needs_person', needs_person: 'needs_person' } },
    { id: 'verify', stepId: 'verify', on: { approved: 'onboard', sent_back: 'fill' }, wait: { remindMs: 1 * DAY, timeout: { afterMs: 3 * DAY, target: 'needs_person' } } },
    { id: 'onboard', stepId: 'onboard', on: { done: 'end' } },
    { id: 'needs_person', on: { resolved: 'check' }, wait: { timeout: { afterMs: 7 * DAY, target: 'end' } }, assignee: 'manager' },
  ],
  steps: {
    fill: {
      id: 'fill',
      title: 'Client fills in the intake form',
      performer: 'external',
      assignee: 'staff',
      strictness: 'strict',
      instructions:
        'The client enters their details and uploads their **PAN card** and **GST certificate**.\n\nStaff can fill the form in on the client\'s behalf when the client sends the documents by email.',
      reads: [],
      writes: byName(['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents']),
      tools: [],
      checkpoint: [],
      outcomes: ['submitted'],
      policy: common,
      file: 'workflows/client-intake/steps/fill.md',
    },
    check: {
      id: 'check',
      title: "Check the client's answers",
      performer: 'agent',
      strictness: 'guided',
      instructions: [
        'Validate the client\'s GSTIN with the GST lookup, and record whether it is valid and the legal name it is registered to.',
        '',
        'Compare what the client typed with what was extracted from their documents. Flag any mismatch, and say which document it came from.',
        '',
        'If anything is missing or doesn\'t match, email the client at their address on the case. Say exactly what is missing or wrong, politely and in plain words, then finish with `needs_info`. If everything matches, finish with `checked`. If the GSTIN is not valid at all, finish with `failed`.',
      ].join('\n'),
      reads: ['case.client_name', 'case.client_email', 'case.pan', 'case.gstin', 'case.annual_turnover', 'case.documents'],
      writes: byName(['gstin_ok', 'legal_name', 'flags']),
      tools: [
        { name: 'gst.validate_gstin', description: 'Looks up a GSTIN on the GST portal', effect: 'read', classified: true, required: true, plugin: 'gst' },
        { name: 'intake.extract_fields', description: 'Reads fields from an uploaded document', effect: 'read', classified: true, required: false, plugin: 'intake' },
        { name: 'email.send', description: 'Sends an email from the practice mailbox', effect: 'outbound', classified: true, required: false, plugin: 'email' },
        { name: 'recall.step_record', description: 'Looks up what an earlier step saw and decided', effect: 'read', classified: true, required: false },
        { name: 'recall.similar_cases', description: 'Finds similar past cases', effect: 'read', classified: true, required: false },
      ],
      modelRole: 'checker',
      checkpoint: ['every flag names the document it came from'],
      outcomes: ['checked', 'needs_info', 'failed'],
      policy: override(common, [
        { subject: 'tokens', value: '40,000', layer: 'step', layerName: 'check', source: 'workflows/client-intake/steps/check.md' },
        { subject: 'time', value: '10 minutes', layer: 'step', layerName: 'check', source: 'workflows/client-intake/steps/check.md' },
        { subject: 'model calls', value: '12', layer: 'step', layerName: 'check', source: 'workflows/client-intake/steps/check.md' },
        { subject: 'taint', value: 'read separately, never followed as instructions', layer: 'platform', layerName: 'Platform' },
        { subject: 'email.send', value: '20 a day', layer: 'plugin', layerName: 'email', source: 'plugins/email/plugin.yaml', notEnforced: true },
      ]),
      file: 'workflows/client-intake/steps/check.md',
    },
    verify: {
      id: 'verify',
      title: 'Manager approves onboarding',
      performer: 'person',
      assignee: 'manager',
      strictness: 'strict',
      instructions: 'The manager reviews the checked answers and the flags, then approves or sends the case back with a note saying what to fix.',
      reads: ['case.client_name', 'case.gstin', 'case.legal_name', 'case.flags'],
      writes: [],
      tools: [],
      checkpoint: [],
      outcomes: ['approved', 'sent_back'],
      policy: common,
      file: 'workflows/client-intake/steps/verify.md',
    },
    onboard: {
      id: 'onboard',
      title: 'Create the customer',
      performer: 'system',
      strictness: 'strict',
      instructions: 'Create the customer record from the approved case.',
      reads: ['case.client_name', 'case.client_email', 'case.gstin', 'case.pan'],
      writes: byName(['customer']),
      tools: [{ name: 'domain.customer.create', description: 'Adds a customer to the client list', effect: 'write', classified: true, required: true }],
      checkpoint: [],
      outcomes: ['done'],
      policy: common,
      file: 'workflows/client-intake/steps/onboard.md',
    },
  },
  caseFields,
  diagnostics: [
    {
      severity: 'warning',
      code: 'policy.not_enforced',
      message: 'The email plugin\'s daily sending limit is shown but not enforced yet.',
      file: 'plugins/email/plugin.yaml',
    },
  ],
}

export const sampleRoles: MwRole[] = [
  { id: 'staff', title: 'Staff', description: 'Runs intakes and fills forms for clients' },
  { id: 'manager', title: 'Manager', description: 'Approves onboarding' },
  { id: 'finance', title: 'Finance', description: 'Sees bank details' },
]

export const sampleLiveCounts: MwLiveCounts = {
  workflowId: 'client-intake',
  byState: { fill: 3, check: 1, verify: 2, needs_person: 1 },
  edges: {
    'fill>check': 14,
    'check>verify': 10,
    'check>fill': 3,
    'check>needs_person': 1,
    'fill>needs_person': 2,
    'verify>onboard': 8,
    'verify>fill': 1,
    'onboard>end': 8,
    'needs_person>check': 1,
  },
}

/** A case that was sent back once for missing information and now waits on the manager. */
export const sampleHighlightPath: string[] = ['fill', 'check', 'fill', 'check', 'verify']
