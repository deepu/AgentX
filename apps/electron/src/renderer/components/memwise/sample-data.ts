/**
 * Sample MemWise data for the playground and render tests, modelled on examples/intake
 * (the client intake playbook: fill → check → verify → onboard). Plain data, no API.
 */

import type {
  MwCase,
  MwCaseSummary,
  MwCaseValue,
  MwChannelsAvailable,
  MwExplanation,
  MwExtractSuggestion,
  MwField,
  MwInboxItem,
  MwLiveCounts,
  MwNotifySettings,
  MwPerson,
  MwPlaybook,
  MwPlaybookSummary,
  MwRelayStatus,
  MwRole,
  MwStatus,
  MwStepRecord,
} from '@memwise/shared/protocol'

const T0 = '2026-10-17T09:12:00.000Z'
const T1 = '2026-10-17T09:20:00.000Z'
const T2 = '2026-10-17T09:21:30.000Z'
const T3 = '2026-10-18T11:05:00.000Z'
const T4 = '2026-10-18T11:06:40.000Z'
const T5 = '2026-10-19T08:30:00.000Z'

export const samplePeople: MwPerson[] = [
  { id: 'per_priya', name: 'Priya Shah', email: 'priya@example.com', roles: ['staff'] },
  { id: 'per_arjun', name: 'Arjun Rao', email: 'arjun@example.com', roles: ['manager', 'finance'] },
]

export const sampleRoles: MwRole[] = [
  { id: 'staff', title: 'Staff', description: 'Runs intakes and fills forms for clients' },
  { id: 'manager', title: 'Manager', description: 'Approves onboarding' },
  { id: 'finance', title: 'Finance', description: 'Sees bank details' },
]

export const sampleStatus: MwStatus = {
  ready: true,
  me: samplePeople[1],
  canActAs: true,
  modelConfigured: true,
  projectDir: '~/.memwise/project',
  diagnostics: [],
}

const str = { type: 'string' }
const documentSchema = {
  anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] }],
}

export const sampleCaseFields: MwField[] = [
  { name: 'client_name', type: 'PersonName', schema: { ...str, description: "A person's name." }, required: true },
  { name: 'client_email', type: 'Email', schema: { type: 'string', format: 'email' }, required: true },
  { name: 'pan', type: 'Identifier(PAN)', schema: { type: 'string', minLength: 1, pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', description: 'PAN identifier.' }, required: true },
  { name: 'gstin', type: 'Identifier(GSTIN)', schema: { type: 'string', minLength: 1, pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', description: 'GSTIN identifier.' }, required: true },
  {
    name: 'annual_turnover',
    type: 'Money',
    schema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['amount', 'currency'], additionalProperties: false },
  },
  { name: 'documents', type: 'List<Document>', schema: { type: 'array', items: documentSchema }, description: 'PAN card and GST certificate' },
  { name: 'gstin_ok', type: 'Boolean', schema: { type: 'boolean' } },
  { name: 'legal_name', type: 'Text', schema: str },
  {
    name: 'flags',
    type: 'List<Flag>',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: str, problem: str, document: str },
        additionalProperties: false,
      },
    },
  },
  { name: 'customer', type: 'Ref<Customer>', schema: { type: 'string', minLength: 1 } },
  { name: 'status', type: 'Enum[draft, submitted, checked, approved, rejected]', schema: { type: 'string', enum: ['draft', 'submitted', 'checked', 'approved', 'rejected'] } },
]

const field = (name: string) => sampleCaseFields.find(f => f.name === name)!

export const samplePlaybook: MwPlaybook = {
  id: 'client-intake',
  version: 1,
  hash: 'sha256:5f1c',
  title: 'Client intake',
  start: 'fill',
  states: [
    { id: 'fill', stepId: 'fill', on: { submitted: 'check' }, wait: { remindMs: 3 * 86400_000, timeout: { afterMs: 7 * 86400_000, target: 'needs_person' } } },
    { id: 'check', stepId: 'check', on: { checked: 'verify', needs_info: 'fill', failed: 'needs_person', needs_person: 'needs_person' } },
    { id: 'verify', stepId: 'verify', on: { approved: 'onboard', sent_back: 'fill' }, wait: { remindMs: 86400_000, timeout: { afterMs: 3 * 86400_000, target: 'needs_person' } } },
    { id: 'onboard', stepId: 'onboard', on: { done: 'end' } },
    { id: 'needs_person', on: { resolved: 'check' }, assignee: 'manager', wait: { timeout: { afterMs: 7 * 86400_000, target: 'end' } } },
  ],
  steps: {
    fill: {
      id: 'fill', title: 'Client fills in the intake form', performer: 'external', assignee: 'staff', strictness: 'strict',
      instructions: 'The client enters their details and uploads their PAN card and GST certificate.',
      reads: [], writes: ['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents'].map(field),
      tools: [], checkpoint: [], outcomes: ['submitted'], policy: [], file: 'steps/fill.md',
    },
    check: {
      id: 'check', title: "Check the client's answers", performer: 'agent', strictness: 'guided',
      instructions: "## What to do\n\nValidate the client's GSTIN with the GST lookup, and record whether it is valid and the legal name it is registered to.\n\nCompare what the client typed with what was extracted from their documents. Flag any mismatch, and say which document it came from.",
      reads: ['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents'],
      writes: ['gstin_ok', 'legal_name', 'flags'].map(field),
      tools: [
        { name: 'gst.validate_gstin', description: 'GST lookup', effect: 'read', classified: true, required: true, plugin: 'gst' },
        { name: 'intake.extract_fields', description: 'Read fields from documents', effect: 'read', classified: true, required: false, plugin: 'intake' },
        { name: 'email.send', description: 'Send an email', effect: 'outbound', classified: true, required: false, plugin: 'email' },
      ],
      modelRole: 'checker', checkpoint: ['every flag names the document it came from'], outcomes: ['checked', 'needs_info', 'failed'],
      policy: [
        { subject: 'outbound', value: 'needs approval', layer: 'domain', layerName: 'Domain policy', source: 'domain/policy.yaml' },
        { subject: 'tokens', value: '40,000', layer: 'step', layerName: 'This step', source: 'steps/check.md' },
      ],
      file: 'steps/check.md',
    },
    verify: {
      id: 'verify', title: 'Manager approves onboarding', performer: 'person', assignee: 'manager', strictness: 'strict',
      instructions: 'Review the checked answers and the flags, then **approve** or send the case back with a note for the client.',
      reads: ['client_name', 'gstin', 'legal_name', 'flags'], writes: [], tools: [], checkpoint: [], outcomes: ['approved', 'sent_back'], policy: [], file: 'steps/verify.md',
    },
    onboard: {
      id: 'onboard', title: 'Create the customer', performer: 'system', strictness: 'strict', instructions: 'Create the customer from the approved case.',
      reads: ['client_name', 'client_email', 'gstin', 'pan'], writes: [field('customer')],
      tools: [{ name: 'domain.customer.create', effect: 'write', classified: true, required: true }],
      checkpoint: [], outcomes: ['done'], policy: [], file: 'steps/onboard.md',
    },
  },
  caseFields: sampleCaseFields,
  diagnostics: [],
}

export const samplePlaybookSummaries: MwPlaybookSummary[] = [
  { id: 'client-intake', version: 1, title: 'Client intake', stepCount: 4, open: 3, waitingOnMe: 2, done: 12 },
]

export const sampleLiveCounts: MwLiveCounts = {
  workflowId: 'client-intake',
  byState: { fill: 1, verify: 1, needs_person: 1 },
  edges: { 'fill>check': 16, 'check>verify': 13, 'check>fill': 3, 'verify>onboard': 12, 'verify>fill': 1, 'onboard>end': 12 },
}

const v = (value: unknown, provenance: MwCaseValue['provenance'], extra: Partial<MwCaseValue> = {}): MwCaseValue => ({ value, provenance, ...extra })
const byPriya = { kind: 'person' as const, at: T0, by: 'per_priya', stepRunId: 'sr_fill_1' }

export const sampleValues: Record<string, MwCaseValue> = {
  client_name: v('Ravi Menon', byPriya),
  client_email: v('ravi@menon-exports.example', byPriya),
  pan: v('AAACM1234M', byPriya),
  gstin: v('27AAACM1234M1Z2', byPriya),
  annual_turnover: v({ amount: 8500000, currency: 'INR' }, byPriya),
  documents: v([
    { id: 'file_1', name: 'pan-card.pdf', mime: 'application/pdf', size: 182_000, sha256: 'a1' },
    { id: 'file_2', name: 'gst-certificate.pdf', mime: 'application/pdf', size: 240_500, sha256: 'b2' },
  ], byPriya),
  gstin_ok: v(true, { kind: 'tool', at: T2, stepRunId: 'sr_check_2', tool: 'gst.validate_gstin', callId: 'call_1' }),
  legal_name: v('Menon Exports LLP', { kind: 'tool', at: T2, stepRunId: 'sr_check_2', tool: 'gst.validate_gstin', callId: 'call_1' }),
  flags: v(
    [{ field: 'pan', problem: 'Typed PAN does not match the PAN card', document: 'pan-card.pdf' }],
    { kind: 'judgement', at: T4, stepRunId: 'sr_check_2', rationale: 'The typed PAN differs from the PAN card.' },
    { tainted: true },
  ),
  bank_account: { value: null, provenance: { kind: 'input', at: T0 }, hidden: true },
}

export const sampleCaseSummaries: MwCaseSummary[] = [
  {
    caseId: 'case_menon', runId: 'run_menon', workflowId: 'client-intake', workflowVersion: 1, title: 'Ravi Menon',
    state: 'verify', stateTitle: 'Manager approves onboarding', status: 'active', waitingOn: { kind: 'role', role: 'manager' },
    createdAt: T0, updatedAt: T4,
  },
  {
    caseId: 'case_acme', runId: 'run_acme', workflowId: 'client-intake', workflowVersion: 1, title: 'Acme Traders',
    state: 'fill', stateTitle: 'Client fills in the intake form', status: 'active', waitingOn: { kind: 'role', role: 'staff' },
    createdAt: T3, updatedAt: T5,
  },
  {
    caseId: 'case_sun', runId: 'run_sun', workflowId: 'client-intake', workflowVersion: 1, title: 'Sunrise Foods',
    state: 'needs_person', stateTitle: 'Needs a person', status: 'stopped', stopReason: 'The GST lookup did not answer three times.',
    createdAt: T0, updatedAt: T3,
  },
]

export const sampleCase: MwCase = {
  ...sampleCaseSummaries[0]!,
  fields: sampleCaseFields,
  values: sampleValues,
  timeline: [
    { stepRunId: 'sr_fill_1', stepId: 'fill', title: 'Client fills in the intake form', performer: 'external', attempt: 1, status: 'completed', outcome: 'submitted', decidedBy: 'per_priya', tainted: false, startedAt: T0, finishedAt: T1 },
    { stepRunId: 'sr_check_2', stepId: 'check', title: "Check the client's answers", performer: 'agent', attempt: 1, status: 'completed', outcome: 'checked', rationale: 'GSTIN is valid; one flag on the PAN.', tainted: true, startedAt: T1, finishedAt: T4 },
    { stepRunId: 'sr_verify_3', stepId: 'verify', title: 'Manager approves onboarding', performer: 'person', attempt: 1, status: 'waiting', tainted: false, startedAt: T4 },
  ],
  transitions: [
    { seq: 1, from: 'fill', to: 'check', event: 'submitted', source: 'step', accepted: true, stepRunId: 'sr_fill_1', at: T1 },
    { seq: 2, from: 'check', to: 'verify', event: 'checked', source: 'step', accepted: true, stepRunId: 'sr_check_2', at: T4 },
  ],
  path: ['fill', 'check', 'verify'],
}

export const sampleStepRecord: MwStepRecord = {
  ...sampleCase.timeline[1]!,
  runId: 'run_menon',
  caseId: 'case_menon',
  workflowId: 'client-intake',
  workflowVersion: 1,
  modelRole: 'checker',
  context: {
    pushed: { client_name: sampleValues.client_name!, pan: sampleValues.pan!, gstin: sampleValues.gstin!, documents: sampleValues.documents! },
    tools: ['gst.validate_gstin', 'intake.extract_fields', 'email.send'],
    modelRole: 'checker',
  },
  outputs: { gstin_ok: sampleValues.gstin_ok!, legal_name: sampleValues.legal_name!, flags: sampleValues.flags! },
  checkpoint: [{ rule: 'every flag names the document it came from', kind: 'verifier', passed: true, reason: 'The only flag cites pan-card.pdf.' }],
  journal: [
    { key: 'j1', kind: 'model', name: 'checker', request: { messages: 3 }, response: { toolCalls: 2 }, startedAt: T1, durationMs: 2100 },
    { key: 'j2', kind: 'tool', name: 'gst.validate_gstin', callId: 'call_1', effect: 'read', request: { gstin: '27AAACM1234M1Z2' }, response: { valid: true, legal_name: 'Menon Exports LLP' }, startedAt: T2, durationMs: 420 },
    { key: 'j3', kind: 'tool', name: 'intake.extract_fields', callId: 'call_2', effect: 'read', request: { documents: ['pan-card.pdf'] }, response: { fields: [{ name: 'pan', value: 'AAACM1234M', document: 'pan-card.pdf' }] }, startedAt: T2, durationMs: 3100 },
    { key: 'j4', kind: 'checkpoint', name: 'verifier', response: { passed: true }, startedAt: T4, durationMs: 900 },
  ],
  usage: { tokens: 12840, modelCalls: 4, durationMs: 98_000, costUsd: 0.042 },
}

export const sampleExplanation: MwExplanation = {
  id: 'exp_1',
  stepRunId: 'sr_check_2',
  question: 'Why was this flagged?',
  answer: 'The PAN typed in the form (**AAACM9999Z**) does not match the PAN read from *pan-card.pdf* (**AAACM1234M**), so the step added a flag on `pan` citing that document.',
  cites: [
    { kind: 'journal', ref: 'j3', label: 'Read fields from pan-card.pdf' },
    { kind: 'output', ref: 'flags', label: 'Flags' },
  ],
  grounded: true,
  at: T5,
}

export const sampleInbox: MwInboxItem[] = [
  {
    kind: 'input', id: 'inb_input_acme', stepRunId: 'sr_fill_9', caseId: 'case_acme', runId: 'run_acme', caseTitle: 'Acme Traders',
    workflowId: 'client-intake', stepTitle: 'Client fills in the intake form', assignee: 'staff',
    fields: ['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents'].map(field),
    prefill: { client_name: v('Acme Traders', { kind: 'input', at: T3, by: 'per_priya' }), annual_turnover: v({ amount: 0, currency: 'INR' }, { kind: 'input', at: T3 }) },
    outcomes: ['submitted'],
    context: {},
    since: T5,
  },
  {
    kind: 'decision', id: 'inb_decision_menon', stepRunId: 'sr_verify_3', caseId: 'case_menon', runId: 'run_menon', caseTitle: 'Ravi Menon',
    workflowId: 'client-intake', stepTitle: 'Manager approves onboarding',
    instructions: samplePlaybook.steps.verify!.instructions, assignee: 'manager', outcomes: ['approved', 'sent_back'],
    context: { client_name: sampleValues.client_name!, gstin: sampleValues.gstin!, legal_name: sampleValues.legal_name!, flags: sampleValues.flags! },
    since: T4,
  },
  {
    kind: 'approval', id: 'inb_approval_menon', approvalId: 'apr_1', stepRunId: 'sr_check_2', caseId: 'case_menon', runId: 'run_menon',
    caseTitle: 'Ravi Menon', workflowId: 'client-intake', stepTitle: "Check the client's answers", tool: 'email.send', effect: 'outbound',
    preview: {
      summary: 'Email to ravi@menon-exports.example',
      detail: { to: 'ravi@menon-exports.example', subject: 'One detail in your intake form', body: 'The PAN you typed (AAACM9999Z) does not match your PAN card (AAACM1234M). Please correct it in the form.' },
    },
    reason: 'Outbound needs approval (domain policy)',
    since: T2,
  },
  {
    kind: 'attention', id: 'inb_attention_sun', caseId: 'case_sun', runId: 'run_sun', caseTitle: 'Sunrise Foods', workflowId: 'client-intake',
    state: 'needs_person', reason: 'The GST lookup did not answer three times.', events: ['resolved'], since: T3,
  },
  {
    kind: 'reminder', id: 'inb_reminder_acme', caseId: 'case_acme', runId: 'run_acme', caseTitle: 'Acme Traders', workflowId: 'client-intake',
    stepTitle: 'Client fills in the intake form', text: 'Acme Traders has not finished the intake form for 3 days.', since: T0,
  },
]

// ---------------------------------------------------------------- Phase 5: client links, reading documents, public address

const L0 = '2026-10-20T04:42:00.000Z'
const L1 = '2026-10-20T05:20:00.000Z'
const L2 = '2026-10-20T05:32:00.000Z'
const asha = { name: 'Asha Rao', email: 'asha@raotraders.example', phone: '+919845012345' }
const fromLink = { kind: 'external' as const, at: L2, by: 'Asha Rao', linkId: 'lnk_2', stepRunId: 'sr_fill_21' }

/** A case waiting on the client: an earlier link was used, the newest is open (sent, opened, a draft saved). */
export const sampleClientCase: MwCase = {
  caseId: 'case_asha', runId: 'run_asha', workflowId: 'client-intake', workflowVersion: 2, title: 'Asha Rao',
  state: 'fill', stateTitle: 'Client fills in the intake form', status: 'active', waitingOn: { kind: 'role', role: 'staff' },
  createdAt: '2026-10-18T06:00:00.000Z', updatedAt: L2,
  fields: [...sampleCaseFields, { name: 'client_phone', type: 'Phone', schema: { type: 'string' } }],
  values: {
    client_name: v('Asha Rao', { kind: 'person', at: T0, by: 'per_priya' }),
    client_email: v('asha@raotraders.example', { kind: 'person', at: T0, by: 'per_priya' }),
    client_phone: v('+919845012345', fromLink, { tainted: true }),
    pan: v('AAACR1234A', { kind: 'tool', at: L2, stepRunId: 'sr_fill_20', tool: 'intake.extract_fields', callId: 'form.extract:1', document: 'pan-card.pdf', confidence: 0.93, confirmedBy: 'external:lnk_1' }, { tainted: true }),
    gstin: v('29AAACR1234A1Z5', fromLink, { tainted: true }),
  },
  timeline: [
    { stepRunId: 'sr_prepare_18', stepId: 'prepare', title: 'Prepare the request', performer: 'person', attempt: 1, status: 'completed', outcome: 'send_link', decidedBy: 'per_priya', tainted: false, startedAt: '2026-10-18T06:00:00.000Z', finishedAt: '2026-10-18T06:02:00.000Z' },
    { stepRunId: 'sr_invite_19', stepId: 'invite', title: 'Send the client a link', performer: 'system', attempt: 1, status: 'completed', outcome: 'sent', tainted: false, startedAt: '2026-10-18T06:02:00.000Z', finishedAt: '2026-10-18T06:05:00.000Z' },
    { stepRunId: 'sr_fill_20', stepId: 'fill', title: 'Client fills in the intake form', performer: 'external', attempt: 1, status: 'completed', outcome: 'submitted', decidedBy: 'external:lnk_1', tainted: true, startedAt: '2026-10-18T06:05:00.000Z', finishedAt: '2026-10-19T10:00:00.000Z' },
    { stepRunId: 'sr_verify_21', stepId: 'verify', title: 'Manager approves onboarding', performer: 'person', attempt: 1, status: 'completed', outcome: 'sent_back', decidedBy: 'per_arjun', comment: 'Please upload a clearer GST certificate.', tainted: false, startedAt: '2026-10-19T10:05:00.000Z', finishedAt: '2026-10-20T04:30:00.000Z' },
    { stepRunId: 'sr_fill_22', stepId: 'fill', title: 'Client fills in the intake form', performer: 'external', attempt: 2, status: 'waiting', tainted: false, startedAt: L0 },
  ],
  transitions: [],
  path: ['prepare', 'invite', 'fill', 'check', 'verify', 'invite', 'fill'],
  links: [
    {
      id: 'lnk_2', kind: 'step', status: 'open', runId: 'run_asha', caseId: 'case_asha', stepId: 'fill', stepRunId: 'sr_fill_22',
      participant: asha, via: 'email', note: 'Please upload a clearer GST certificate.', createdAt: L0, createdBy: 'per_arjun',
      expiresAt: '2026-10-27T04:42:00.000Z', sentAt: L0, firstOpenedAt: L1, lastOpenedAt: L1, draftSavedAt: L2,
    },
    {
      id: 'lnk_1', kind: 'step', status: 'used', runId: 'run_asha', caseId: 'case_asha', stepId: 'fill', stepRunId: 'sr_fill_20',
      participant: asha, via: 'whatsapp', createdAt: '2026-10-18T06:05:00.000Z', expiresAt: '2026-10-25T06:05:00.000Z',
      sentAt: '2026-10-18T06:05:00.000Z', firstOpenedAt: '2026-10-18T07:10:00.000Z', usedAt: '2026-10-19T10:00:00.000Z',
    },
  ],
  deliveries: [
    { id: 'dlv_2', channel: 'email', to: 'asha@raotraders.example', purpose: 'invite', linkId: 'lnk_2', status: 'sent', at: L0 },
    { id: 'dlv_1', channel: 'whatsapp', to: '+919845012345', purpose: 'invite', linkId: 'lnk_1', status: 'read', at: '2026-10-18T06:05:00.000Z' },
  ],
}

/** An approval of the invite email: what Asha will get. */
export const sampleInviteApproval: MwInboxItem = {
  kind: 'approval', id: 'inb_invite_asha', approvalId: 'apr_9', stepRunId: 'sr_invite_19', caseId: 'case_asha', runId: 'run_asha',
  caseTitle: 'Asha Rao', workflowId: 'client-intake', stepTitle: 'Send the client a link', tool: 'external.invite', effect: 'outbound',
  preview: {
    summary: 'Email to Asha Rao with a link to the form',
    detail: {
      via: 'email',
      to: 'Asha Rao <asha@raotraders.example>',
      subject: 'Acme & Co. needs a few details from you',
      body: 'Hello Asha,\n\nAcme & Co. asks you to fill in a short form so we can open your account. You can add photos of your PAN card and GST certificate.\n\nhttps://k7q2m4x6p3r5s2t6.relay.memwise.app/f/mwl_…\n\nThe link works until 27 October.\n\nThank you,\nAcme & Co.',
      expires: '27 Oct 2026',
    },
  },
  reason: 'Outbound needs approval (playbook policy: staff or manager)',
  since: L0,
}

/** A staff fill form that can read its documents. */
export const sampleExtractInput: MwInboxItem = {
  ...(sampleInbox[0] as Extract<MwInboxItem, { kind: 'input' }>),
  id: 'inb_input_extract',
  extract: { documentsField: 'documents', fields: ['pan', 'gstin'], minConfidence: 0.8 },
  prefill: {
    documents: v([{ id: 'file_pan', name: 'pan-card.pdf', mime: 'application/pdf', size: 182_000, sha256: 'a1' }], { kind: 'input', at: T3 }),
  },
}

export const sampleSuggestions: MwExtractSuggestion[] = [
  { id: 'sg_1', field: 'pan', value: 'AAACR1234A', confidence: 0.93, document: 'pan-card.pdf', documentId: 'file_pan', quote: 'Permanent Account Number AAACR1234A', found: true, prefill: true },
  { id: 'sg_2', field: 'gstin', value: '29AAACR1234A1Z5', confidence: 0.61, document: 'pan-card.pdf', documentId: 'file_pan', found: true, prefill: false },
]

export const sampleRelayStatus: MwRelayStatus = {
  enabled: true, state: 'connected', relayUrl: 'https://relay.memwise.app', installId: 'k7q2m4x6p3r5s2t6',
  publicUrl: 'https://k7q2m4x6p3r5s2t6.relay.memwise.app', source: 'relay', since: L0,
}

export const sampleChannels: MwChannelsAvailable = {
  email: { tool: 'email.send', plugin: 'Email (SMTP)' },
  whatsapp: null,
}

export const sampleNotify: MwNotifySettings = { email: true, whatsapp: '+919845012345' }
