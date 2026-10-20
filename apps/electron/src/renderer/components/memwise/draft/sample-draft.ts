/**
 * A change draft of client intake (version 2 → 3) for the playground and the render tests: a chat
 * added a sanctions screening step after the check (still pending), an editor edit reworded the
 * check, and the welcome email step was dropped. Plain data, shaped like the app API returns it.
 */

import type {
  MwDraft,
  MwDraftReport,
  MwDraftSummary,
  MwInboxItem,
  MwPlaybook,
  MwStep,
  MwStructuralDiff,
  MwVersion,
} from '@memwise/shared/protocol'
import { samplePlaybook } from '../playbook/sample-playbook'

const T0 = '2026-10-19T10:00:00.000Z'
const T1 = '2026-10-19T10:12:00.000Z'
const T2 = '2026-10-20T09:30:00.000Z'
const T3 = '2026-10-20T09:41:00.000Z'

const notify: MwStep = {
  id: 'notify',
  title: 'Email the welcome pack',
  performer: 'system',
  strictness: 'strict',
  instructions: 'Send the welcome pack to the client.',
  reads: ['case.client_email'],
  writes: [],
  tools: [{ name: 'email.send_welcome', description: 'Sends the welcome pack', effect: 'outbound', classified: true, required: true, plugin: 'email' }],
  checkpoint: [],
  outcomes: ['sent'],
  policy: [],
  file: 'workflows/client-intake/steps/notify.md',
}

/** The live playbook (version 2): intake with a welcome email at the end. */
export const sampleLivePlaybook: MwPlaybook = {
  ...samplePlaybook,
  version: 2,
  hash: 'sha256:live2',
  states: samplePlaybook.states.flatMap(s =>
    s.id === 'onboard'
      ? [{ ...s, on: { done: 'notify' } }, { id: 'notify', stepId: 'notify', on: { sent: 'end' } }]
      : [s],
  ),
  steps: { ...samplePlaybook.steps, notify },
}

const screen: MwStep = {
  id: 'screen',
  title: 'Screen for sanctions',
  performer: 'agent',
  strictness: 'guided',
  instructions: 'Screen the client and its directors against the sanctions lists. Record whether anything matched.',
  reads: ['case.client_name', 'case.pan'],
  writes: [{ name: 'sanctions_hit', type: 'Boolean', schema: { type: 'boolean' } }],
  tools: [{ name: 'sanctions.screen', description: 'Checks a name against the sanctions lists', effect: 'read', classified: true, required: true, plugin: 'sanctions' }],
  modelRole: 'checker',
  checkpoint: ['a hit names the list it came from'],
  outcomes: ['clear', 'hit'],
  policy: samplePlaybook.steps.check!.policy,
  file: 'workflows/client-intake/steps/screen.md',
}

const CHECK_INSTRUCTIONS = [
  'Validate the client\'s GSTIN with the GST lookup, and record whether it is valid and the legal name it is registered to.',
  '',
  'Compare what the client typed with what was extracted from their documents. Flag any mismatch, and say which document and page it came from.',
].join('\n')

/** The draft read as a playbook (version 3). */
export const sampleDraftPlaybook: MwPlaybook = {
  ...samplePlaybook,
  version: 3,
  hash: 'sha256:draft3',
  states: samplePlaybook.states.flatMap(s => {
    if (s.id === 'check') return [{ ...s, on: { ...s.on, checked: 'screen' } }, { id: 'screen', stepId: 'screen', on: { clear: 'verify', hit: 'needs_person' } }]
    return [s]
  }),
  steps: {
    ...samplePlaybook.steps,
    check: {
      ...samplePlaybook.steps.check!,
      instructions: CHECK_INSTRUCTIONS,
      tools: samplePlaybook.steps.check!.tools.filter(t => t.name !== 'recall.similar_cases'),
      file: 'workflows/client-intake/steps/check.md',
    },
    screen,
  },
  caseFields: [...samplePlaybook.caseFields, { name: 'sanctions_hit', type: 'Boolean', schema: { type: 'boolean' } }],
  diagnostics: [],
}

export const sampleStructure: MwStructuralDiff = {
  states: { check: 'changed', screen: 'added', onboard: 'changed', notify: 'removed' },
  transitions: [
    { from: 'check', event: 'checked', to: 'verify', change: 'removed' },
    { from: 'onboard', event: 'done', to: 'notify', change: 'removed' },
    { from: 'notify', event: 'sent', to: 'end', change: 'removed' },
    { from: 'check', event: 'checked', to: 'screen', change: 'added' },
    { from: 'screen', event: 'clear', to: 'verify', change: 'added' },
    { from: 'screen', event: 'hit', to: 'needs_person', change: 'added' },
    { from: 'onboard', event: 'done', to: 'end', change: 'added' },
  ],
  steps: {
    check: { change: 'changed', parts: ['instructions', 'tools'] },
    screen: { change: 'added', parts: [] },
    notify: { change: 'removed', parts: [] },
  },
  caseFields: { added: ['sanctions_hit'], removed: [], changed: [] },
  tools: { added: ['sanctions.screen'], removed: ['email.send_welcome', 'recall.similar_cases'] },
  requiredTools: [{ step: 'screen', tool: 'sanctions.screen', change: 'added' }],
  roles: { added: [], removed: [] },
  examples: { added: ['sanctions-hit.yaml'], removed: [], changed: [] },
  version: { from: 2, to: 3 },
  playbook: [],
}

const SCREEN_FILE = `---
title: Screen for sanctions
performer: agent
strictness: guided
reads: [case.client_name, case.pan]
writes:
  sanctions_hit: Boolean
tools:
  allowed:  [sanctions.screen]
  required: [sanctions.screen]
model: checker
checkpoint:
  - a hit names the list it came from
outcomes: [clear, hit]
---
Screen the client and its directors against the sanctions lists. Record whether anything matched.
`

const CHECK_FILE = `---
title: Check the client's answers
performer: agent
strictness: guided
reads:  [case.client_name, case.client_email, case.pan, case.gstin, case.annual_turnover, case.documents]
writes:
  gstin_ok:   { type: Boolean, from: { tool: gst.validate_gstin, field: valid } }
  legal_name: { type: Text, from: { tool: gst.validate_gstin, field: legal_name } }
  flags:      List<Flag>
tools:
  allowed:  [gst.validate_gstin, intake.extract_fields, email.send, recall.step_record]
  required: [gst.validate_gstin]
model: checker
budget: { tokens: 40k, time: 10m, modelCalls: 12 }
checkpoint:
  - every flag names the document it came from
outcomes: [checked, needs_info, failed]
---
${CHECK_INSTRUCTIONS}
`

const lines = (text: string, kind: 'added' | 'removed' | 'same') => text.replace(/\n$/, '').split('\n').map(t => ({ kind, text: t }))

export const sampleReport: MwDraftReport = {
  hash: 'sha256:draft3',
  at: T3,
  diagnostics: [
    { severity: 'warning', code: 'policy.not_enforced', message: 'The email plugin\'s daily sending limit is shown but not enforced yet.', file: 'plugins/email/plugin.yaml' },
  ],
  errors: 0,
  warnings: 1,
  examples: [
    { name: 'happy-path', status: 'pass', differences: [] },
    { name: 'missing-pan', status: 'pass', differences: [] },
    { name: 'sanctions-hit', status: 'fail', differences: ['ended at verify instead of needs_person', 'screen: required tool sanctions.screen was not called'] },
    { name: 'gst-portal-down', status: 'skip', differences: [], reason: 'it needs a recorded GST lookup' },
  ],
  pastCases: [
    { caseId: 'case_menon', title: 'Ravi Menon', status: 'same', differences: [], livePath: ['fill', 'check', 'verify', 'onboard', 'notify'], draftPath: ['fill', 'check', 'screen', 'verify', 'onboard'] },
    { caseId: 'case_sun', title: 'Sunrise Foods', status: 'different', differences: ['went to needs_person instead of verify'], livePath: ['fill', 'check', 'verify'], draftPath: ['fill', 'check', 'screen', 'needs_person'] },
  ],
  impact: {
    liveVersion: 2,
    newVersion: 3,
    openCases: { total: 4, byState: { fill: 2, verify: 1, notify: 1 } },
    removedStatesWithCases: [{ state: 'notify', cases: 1 }],
    newTools: [{ name: 'sanctions.screen', bound: true, effect: 'read', treatment: 'allow', plugin: 'sanctions' }],
    newRequiredTools: [{ step: 'screen', tool: 'sanctions.screen' }],
    caseFields: { added: ['sanctions_hit'], removed: [], changed: [] },
    otherPlaybooks: [],
    summary: [
      '4 open cases stay on version 2 and finish there.',
      '1 case is at "Email the welcome pack", which this change removes; it finishes on version 2.',
      'Uses a new tool, sanctions.screen (reads only).',
    ],
  },
  outcome: 'failed',
  summary: '1 example case failed.',
}

export const sampleDraft: MwDraft & { fileTexts: Record<string, string> } = {
  id: 'drf_sanctions',
  title: 'Screen new clients for sanctions',
  workflowId: 'client-intake',
  playbookTitle: 'Client intake',
  kind: 'change',
  stage: 'failed',
  createdBy: 'per_priya',
  createdByName: 'Priya Shah',
  createdAt: T0,
  updatedAt: T3,
  pendingEdits: 1,
  changedFiles: 5,
  baseVersion: 2,
  runId: 'run_change_7',
  caseId: 'case_change_7',
  edits: [
    {
      id: 'ed_3', at: T2, by: 'per_priya', byName: 'Priya Shah', via: 'chat', sessionId: 'ses_build', status: 'pending',
      summary: 'Added a sanctions screening step after the check',
      paths: ['workflows/client-intake/workflow.yaml', 'workflows/client-intake/steps/screen.md', 'workflows/client-intake/case.yaml'],
    },
    {
      id: 'ed_2', at: T1, by: 'per_priya', byName: 'Priya Shah', via: 'editor', status: 'kept',
      summary: 'Flags say which page they came from',
      paths: ['workflows/client-intake/steps/check.md'],
    },
    {
      id: 'ed_1', at: T0, by: 'per_priya', byName: 'Priya Shah', via: 'chat', sessionId: 'ses_build', status: 'discarded',
      summary: 'Removed the manager approval',
      paths: ['workflows/client-intake/workflow.yaml'],
    },
  ],
  files: [
    {
      path: 'workflows/client-intake/workflow.yaml',
      status: 'modified',
      pendingEditId: 'ed_3',
      hunks: [
        {
          oldStart: 1, oldLines: 7, newStart: 1, newLines: 8,
          lines: [
            { kind: 'removed', text: 'version: 2' },
            { kind: 'added', text: 'version: 3' },
            { kind: 'same', text: 'start: fill' },
            { kind: 'same', text: 'steps:' },
            { kind: 'removed', text: '  check:   { on: { checked: verify, needs_info: fill, failed: needs_person } }' },
            { kind: 'added', text: '  check:   { on: { checked: screen, needs_info: fill, failed: needs_person } }' },
            { kind: 'added', text: '  screen:  { on: { clear: verify, hit: needs_person } }' },
            { kind: 'same', text: '  verify:  { on: { approved: onboard, sent_back: fill } }' },
            { kind: 'removed', text: '  onboard: { on: { done: notify } }' },
            { kind: 'removed', text: '  notify:  { on: { sent: end } }' },
            { kind: 'added', text: '  onboard: { on: { done: end } }' },
          ],
        },
      ],
    },
    {
      path: 'workflows/client-intake/steps/screen.md',
      status: 'added',
      pendingEditId: 'ed_3',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: SCREEN_FILE.split('\n').length - 1, lines: lines(SCREEN_FILE, 'added') }],
    },
    {
      path: 'workflows/client-intake/steps/check.md',
      status: 'modified',
      hunks: [
        {
          oldStart: 10, oldLines: 4, newStart: 10, newLines: 4,
          lines: [
            { kind: 'removed', text: '  allowed:  [gst.validate_gstin, intake.extract_fields, email.send, recall.step_record, recall.similar_cases]' },
            { kind: 'added', text: '  allowed:  [gst.validate_gstin, intake.extract_fields, email.send, recall.step_record]' },
            { kind: 'same', text: '  required: [gst.validate_gstin]' },
            { kind: 'same', text: 'model: checker' },
          ],
        },
        {
          oldStart: 21, oldLines: 1, newStart: 21, newLines: 1,
          lines: [
            { kind: 'removed', text: 'Compare what the client typed with what was extracted from their documents. Flag any mismatch, and say which document it came from.' },
            { kind: 'added', text: 'Compare what the client typed with what was extracted from their documents. Flag any mismatch, and say which document and page it came from.' },
          ],
        },
      ],
    },
    {
      path: 'workflows/client-intake/steps/notify.md',
      status: 'deleted',
      conflict: true,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0, lines: lines('---\ntitle: Email the welcome pack\n---', 'removed') }],
    },
    {
      path: 'workflows/client-intake/examples/sanctions-hit.yaml',
      status: 'added',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: lines('name: sanctions-hit\ninput: { client_name: Blocked Co }\nexpect: { path: [fill, check, screen, needs_person] }', 'added') }],
    },
  ],
  structure: sampleStructure,
  conflicts: ['workflows/client-intake/steps/notify.md'],
  report: sampleReport,
  reportStale: false,
  playbook: sampleDraftPlaybook,
  diagnostics: [],
  fileTexts: {
    'workflows/client-intake/steps/check.md': CHECK_FILE,
    'workflows/client-intake/steps/screen.md': SCREEN_FILE,
  },
}

export const sampleDraftSummaries: MwDraftSummary[] = [
  (({ edits: _e, files: _f, structure: _s, conflicts: _c, report: _r, reportStale: _rs, playbook: _p, diagnostics: _d, fileTexts: _t, ...summary }) => summary)(sampleDraft),
  {
    id: 'drf_letter',
    title: 'Engagement letter',
    workflowId: 'engagement-letter',
    playbookTitle: 'Engagement letter',
    kind: 'create',
    stage: 'draft',
    createdBy: 'per_priya',
    createdByName: 'Priya Shah',
    createdAt: T2,
    updatedAt: T3,
    pendingEdits: 3,
    changedFiles: 6,
    runId: 'run_build_8',
    caseId: 'case_build_8',
  },
  {
    id: 'drf_old',
    title: 'Ask for the GST certificate',
    workflowId: 'client-intake',
    playbookTitle: 'Client intake',
    kind: 'change',
    stage: 'published',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    pendingEdits: 0,
    changedFiles: 1,
    baseVersion: 1,
    publishedVersion: 2,
  },
]

export const sampleVersions: MwVersion[] = [
  { version: 2, hash: 'sha256:live2', publishedAt: '2026-10-02T09:00:00.000Z', publishedBy: 'per_ravi', publishedByName: 'Ravi Menon', source: 'app', draftId: 'drf_old', runId: 'run_change_3', openCases: 3, live: true },
  { version: 1, hash: 'sha256:5f1c', publishedAt: '2026-09-12T08:00:00.000Z', source: 'files', openCases: 1, live: false },
]

export const sampleConversationItem: Extract<MwInboxItem, { kind: 'conversation' }> = {
  kind: 'conversation',
  id: 'inb_conv_letter',
  stepRunId: 'sr_interview_8',
  caseId: 'case_build_8',
  runId: 'run_build_8',
  caseTitle: 'Engagement letter',
  workflowId: 'create-playbook',
  stepTitle: 'Talk it through',
  assignee: 'staff',
  sessionId: 'ses_build',
  draftId: 'drf_letter',
  since: T3,
}

/** The review step of a change: the decision card links to the draft. */
export const sampleReviewItem: Extract<MwInboxItem, { kind: 'decision' }> = {
  kind: 'decision',
  id: 'inb_review_7',
  stepRunId: 'sr_review_7',
  caseId: 'case_change_7',
  runId: 'run_change_7',
  caseTitle: 'Screen new clients for sanctions',
  workflowId: 'change-playbook',
  stepTitle: 'Review the change',
  instructions: 'Read the changes, the checks and the impact. Approve to publish it as a new version, or ask for changes and say what.',
  assignee: 'manager',
  outcomes: ['approved', 'changes_requested'],
  context: {
    draft: { value: 'drf_sanctions', provenance: { kind: 'system', at: T3 } },
    summary: { value: 'Adds a sanctions screening step after the check.', provenance: { kind: 'judgement', at: T3, stepRunId: 'sr_edit_7' } },
  },
  since: T3,
}
