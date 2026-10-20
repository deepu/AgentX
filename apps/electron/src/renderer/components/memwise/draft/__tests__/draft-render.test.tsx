/**
 * Render tests for drafts: the draft screen (what changes, the chat's edits to keep or discard,
 * the checks), the map in proposed-change mode, the step editor, the conversation inbox item,
 * the review card and the version line, from sample data with the real translations.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import type { MwDraft } from '@memwise/shared/protocol'
import {
  sampleConversationItem,
  sampleDraft,
  sampleDraftPlaybook,
  sampleDraftSummaries,
  sampleLivePlaybook,
  sampleReviewItem,
  sampleStructure,
  sampleVersions,
} from '../sample-draft'
import { sampleRoles } from '../../playbook/sample-playbook'

// The markdown renderer pulls in the PDF block: pdf.js needs a browser and its worker is a Vite asset.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { DraftView } = await import('../DraftView')
type DraftActions = import('../DraftView').DraftActions
const { StepEditor } = await import('../StepEditor')
const { WorkflowMap } = await import('../../map')
const { InboxItemView } = await import('../../InboxItemView')
type InboxActions = import('../../InboxItemView').InboxActions
const { VersionLine, VersionList, PlaybookDrafts } = await import('../../playbook/VersionLine')
const { PlaybooksList } = await import('../../MemwiseListPanels')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const NOW = Date.parse('2026-10-20T12:00:00Z')
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const ok = async () => ({ applied: true })
const actions: DraftActions = {
  check: () => {},
  submit: () => {},
  discard: () => {},
  openChat: () => {},
  keepEdit: ok,
  discardEdit: ok,
  saveStep: async () => ({ applied: true, diagnostics: [] }),
  openCase: () => {},
  openPlaybook: () => {},
}
const count = (html: string, needle: string) => html.split(needle).length - 1
/** No raw keys and none of the words domain experts should not see. */
const plain = (html: string) => {
  expect(html).not.toContain('memwise.')
  expect(text(html)).not.toMatch(/\bworkflow\b|\bAPI\b|\bYAML\b/i)
}

describe('draft screen', () => {
  test('changes: header, actions, what changes in words, the chat edit to keep or discard, the conflict', () => {
    const html = render(<DraftView draft={sampleDraft} live={sampleLivePlaybook} roles={sampleRoles} actions={actions} now={NOW} />)
    const out = text(html)
    expect(out).toContain('Screen new clients for sanctions')
    expect(html).toContain('data-stage="failed"')
    expect(out).toContain('Needs fixing')
    expect(out).toContain('Started by Priya Shah')
    expect(out).toContain('Version 2 → 3')
    // Actions: submit is off until the draft is checked and the chat's change is decided
    for (const a of ['open-chat', 'check', 'submit', 'discard-draft']) expect(html).toContain(`data-action="${a}"`)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-action="submit"/)
    // The chat's pending change, with Keep and Discard
    expect(html).toContain('data-pending-edits')
    expect(out).toContain('1 change from the chat is waiting for you')
    expect(out).toContain('Added a sanctions screening step after the check')
    expect(count(html, 'data-action="keep"')).toBe(1)
    expect(count(html, 'data-action="discard"')).toBe(1)
    // What changes, in plain words, with the pending step marked
    expect(html).toContain('data-change-summary')
    expect(out).toContain('New step “Screen for sanctions”')
    expect(out).toContain('Step “Email the welcome pack” removed')
    expect(html).toMatch(/data-change-kind="added" data-pending="true"/)
    // The conflict and the file diffs (file names only in the details)
    expect(html).toContain('data-conflicts')
    expect(out).toContain('The live playbook changed meanwhile')
    expect(count(html, 'data-file=')).toBe(5)
    expect(html).toContain('data-file-status="deleted"')
    expect(html).not.toContain('memwise.')
  })

  test('submit is on once the draft is checked and nothing waits', () => {
    const checked: MwDraft = {
      ...sampleDraft,
      stage: 'checked',
      edits: sampleDraft.edits.map(e => (e.status === 'pending' ? { ...e, status: 'kept' as const } : e)),
      pendingEdits: 0,
      report: { ...sampleDraft.report!, outcome: 'passed' },
    }
    const html = render(<DraftView draft={checked} live={sampleLivePlaybook} actions={actions} now={NOW} />)
    expect(html).not.toContain('data-pending-edits')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-action="submit"/)
    expect(html).toContain('data-action="submit"')
  })

  test('checks: what was found, example cases, recent cases tried and the impact', () => {
    const html = render(<DraftView draft={sampleDraft} live={sampleLivePlaybook} actions={actions} tab="checks" now={NOW} />)
    const out = text(html)
    expect(html).toContain('data-report-outcome="failed"')
    expect(html).toContain('data-example-status="pass"')
    expect(html).toContain('data-example-status="fail"')
    expect(html).toContain('data-example-status="skip"')
    expect(out).toContain('ended at verify instead of needs_person')
    expect(out).toContain('Skipped: it needs a recorded GST lookup')
    expect(html).toContain('data-past-status="different"')
    expect(out).toContain('Sunrise Foods')
    expect(html).toContain('data-impact')
    expect(out).toContain('4 cases, which stay on their version')
    expect(html).not.toContain('data-report-stale')
    expect(html).not.toContain('memwise.')
  })

  test('checks: a stale report, a draft never checked and a check running', () => {
    const stale = text(render(<DraftView draft={{ ...sampleDraft, reportStale: true }} actions={actions} tab="checks" now={NOW} />))
    expect(stale).toContain('Changed since the last check')
    const never = render(<DraftView draft={{ ...sampleDraft, report: undefined, stage: 'draft' }} actions={actions} tab="checks" now={NOW} />)
    expect(never).toContain('data-not-checked')
    const running = render(<DraftView draft={sampleDraft} actions={actions} checking={{ startedAt: NOW - 12_000 }} now={NOW} />)
    expect(running).toContain('data-checking')
    expect(text(running)).toContain('Checking…')
  })

  test('history: every edit with how it was made and what became of it', () => {
    const html = render(<DraftView draft={sampleDraft} live={sampleLivePlaybook} actions={actions} tab="history" now={NOW} />)
    expect(html).toContain('data-edit-status="pending"')
    expect(html).toContain('data-edit-status="kept"')
    expect(html).toContain('data-edit-status="discarded"')
    const out = text(html)
    expect(out).toContain('By Priya Shah in chat')
    expect(out).toContain('By Priya Shah in the editor')
  })

  test('in review: no edits and no actions but the chat', () => {
    const html = render(<DraftView draft={{ ...sampleDraft, stage: 'in_review' }} actions={actions} now={NOW} />)
    expect(text(html)).toContain('Waiting for approval')
    expect(html).not.toContain('data-action="keep"')
    expect(html).not.toContain('data-action="submit"')
    expect(html).toContain('data-action="open-chat"')
  })
})

describe('map in proposed-change mode', () => {
  test('added green, changed amber, removed red and dashed, removed steps from the live playbook', () => {
    const html = renderToStaticMarkup(
      <WorkflowMap playbook={sampleDraftPlaybook} mode="change" change={{ diff: sampleStructure, live: sampleLivePlaybook }} />,
    )
    const out = text(html)
    expect(out).toContain('Screen for sanctions')
    expect(out).toContain('Email the welcome pack')
    expect(html).toMatch(/data-state="screen"[^>]*data-change="added"|data-change="added"[^>]*data-state="screen"/)
    expect(html).toContain('data-change="added"')
    expect(html).toContain('data-change="changed"')
    expect(html).toContain('data-change="removed"')
    expect(html).toContain('stroke="var(--success-raw)"')
    expect(html).toContain('stroke="var(--destructive-raw)"')
    expect(html).toContain('stroke-dasharray="6 4"')
    expect(html).toContain('data-legend')
    expect(out).toContain('Added')
    expect(out).toContain('Removed')
    expect(html).not.toContain('\u0000')
    expect(html).not.toContain('memwise.')
  })
})

describe('step editor', () => {
  test('one card per step, marked when changed or touched by the chat, with removed steps', () => {
    const html = render(<StepEditor draft={sampleDraft} live={sampleLivePlaybook} roles={sampleRoles} onSave={actions.saveStep} />)
    for (const id of ['fill', 'check', 'screen', 'verify', 'onboard', 'notify']) expect(html).toContain(`data-step-card="${id}"`)
    expect(html).toMatch(/data-step-card="screen" data-step-change="added" data-step-pending="true"/)
    expect(html).toMatch(/data-step-card="check" data-step-change="changed"/)
    expect(html).toMatch(/data-step-card="notify" data-step-change="removed"/)
    expect(html).toContain('data-part-changed="instructions"')
    const out = text(html)
    expect(out).toContain('From chat, waiting for you')
    expect(out).toContain('Removed')
    // Steps the editor can't read the file of are changed by chat
    expect(out).toContain('Change by chat')
    plain(html)
  })

  test('editing a step: title, who does it, instructions and checks; outcomes stay with the chat', () => {
    const html = render(
      <StepEditor draft={sampleDraft} live={sampleLivePlaybook} roles={sampleRoles} onSave={actions.saveStep} editingStepId="check" />,
    )
    expect(html).toContain('data-step-form="check"')
    expect(html).toContain('data-action="save-step"')
    expect(html).toContain(`value="Check the client&#x27;s answers"`)
    expect(html).toContain('every flag names the document it came from')
    const out = text(html)
    expect(out).toContain('Instructions')
    expect(out).toContain('Add a check')
    expect(out).toContain('To add an outcome or change where it leads, ask in the chat.')
    expect(html).not.toContain('memwise.')
  })

  test('read only without a save action', () => {
    const html = render(<StepEditor draft={sampleDraft} live={sampleLivePlaybook} />)
    expect(html).not.toContain('data-step-form')
    expect(html).not.toContain('data-action="edit-step"')
  })
})

describe('inbox: building and changing playbooks', () => {
  const inboxActions: InboxActions = {
    submitStep: ok,
    decideApproval: ok,
    sendEvent: ok,
    openCase: () => {},
    continueChat: () => {},
    openDraft: () => {},
    uploadFile: async f => ({ id: 'x', name: f.name, mime: f.type, size: f.size, sha256: '' }),
  }

  test('a conversation item continues in chat and opens its draft', () => {
    const html = render(<InboxItemView item={sampleConversationItem} actions={inboxActions} now={NOW} />)
    const out = text(html)
    expect(out).toContain('Build a playbook')
    expect(out).toContain('Continue in chat')
    expect(html).toContain('data-action="continue-chat"')
    expect(html).toContain('data-action="open-draft"')
    plain(html)
  })

  test('the review card of a change links to the draft', () => {
    const html = render(<InboxItemView item={sampleReviewItem} actions={inboxActions} now={NOW} />)
    const out = text(html)
    expect(html).toContain('data-review-draft')
    expect(html).toContain('data-action="review-draft"')
    expect(out).toContain('Review the change')
    expect(out).toContain('Ask for changes')
    // The draft id is a link, not a detail to read
    expect(out).not.toContain('drf_sanctions')
    expect(html).not.toContain('memwise.')
  })
})

describe('playbook versions and drafts', () => {
  test('the version line names the live version, when and by whom', () => {
    const html = render(<VersionLine versions={sampleVersions} now={NOW} />)
    const out = text(html)
    expect(out).toContain('Version 2')
    expect(out).toMatch(/published (2 Oct|Oct 2) by Ravi Menon/)
    expect(out).toContain('All 2 versions')
    expect(html).toContain('data-action="versions"')
    expect(text(render(<VersionLine versions={null} version={4} />))).toContain('Version 4')
  })

  test('the versions list shows the cases still running on each', () => {
    const out = text(render(<VersionList versions={sampleVersions} now={NOW} />))
    expect(out).toContain('In use')
    expect(out).toContain('3 cases running')
    expect(out).toMatch(/changed in the files (12 Sep|Sep 12)/)
    expect(out).toContain('1 case still running on it')
  })

  test('drafts in progress leave out published ones', () => {
    const html = render(<PlaybookDrafts drafts={sampleDraftSummaries} onOpen={() => {}} now={NOW} />)
    expect(html).toContain('data-draft="drf_sanctions"')
    expect(html).toContain('data-draft="drf_letter"')
    expect(html).not.toContain('data-draft="drf_old"')
    expect(text(html)).toContain('3 changes waiting for you')
  })

  test('the playbooks list groups drafts and the building playbooks', () => {
    const playbooks = [
      { id: 'client-intake', title: 'Client intake', version: 2, stepCount: 5, open: 3, waitingOnMe: 0, done: 4 },
      { id: 'create-playbook', title: 'Build a playbook', version: 1, stepCount: 4, open: 1, waitingOnMe: 1, done: 0 },
      { id: 'change-playbook', title: 'Change a playbook', version: 1, stepCount: 5, open: 1, waitingOnMe: 0, done: 2 },
    ]
    const html = render(<PlaybooksList playbooks={playbooks} drafts={sampleDraftSummaries} onSelect={() => {}} onSelectDraft={() => {}} />)
    expect(html).toContain('data-list-group="drafts"')
    expect(html).toContain('data-list-group="building"')
    const out = text(html)
    expect(out).toContain('Building playbooks')
    expect(out.indexOf('Client intake')).toBeLessThan(out.indexOf('Building playbooks'))
  })
})
