import * as React from 'react'
import type { ComponentEntry } from './types'
import type { MwDraft, MwDraftStage, MwSubmitResult } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { DraftView, StepEditor, type DraftActions, type DraftTab } from '@/components/memwise/draft'
import { WorkflowMap } from '@/components/memwise/map'
import { VersionLine, VersionList, PlaybookDrafts } from '@/components/memwise/playbook/VersionLine'
import { NewPlaybookForm } from '@/components/memwise/BuildDialogs'
import { InboxItemView, type InboxActions } from '@/components/memwise/InboxItemView'
import { PlaybooksList } from '@/components/memwise/MemwiseListPanels'
import { sampleRoles } from '@/components/memwise/playbook/sample-playbook'
import { samplePlaybookSummaries } from '@/components/memwise/sample-data'
import {
  sampleConversationItem,
  sampleDraft,
  sampleDraftPlaybook,
  sampleDraftSummaries,
  sampleLivePlaybook,
  sampleReviewItem,
  sampleStructure,
  sampleVersions,
} from '@/components/memwise/draft/sample-draft'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const log = (what: string) => () => console.log(`[playground] ${what}`)

/** The draft screen with the edits and the check working on local state. */
function DraftDemo({ stage, tab, stale }: { stage: MwDraftStage; tab: DraftTab; stale: boolean }) {
  const [draft, setDraft] = React.useState<MwDraft>(sampleDraft)
  const [checking, setChecking] = React.useState<{ startedAt: number } | null>(null)
  const [current, setCurrent] = React.useState<DraftTab>(tab)
  React.useEffect(() => setDraft({ ...sampleDraft, stage, reportStale: stale }), [stage, stale])
  React.useEffect(() => setCurrent(tab), [tab])

  const decide = (status: 'kept' | 'discarded') => async (editId: string): Promise<MwSubmitResult> => {
    await wait(500)
    setDraft(d => ({ ...d, edits: d.edits.map(e => (e.id === editId ? { ...e, status } : e)), pendingEdits: Math.max(0, d.pendingEdits - 1) }))
    return { applied: true }
  }
  const actions: DraftActions = {
    check: () => {
      setChecking({ startedAt: Date.now() })
      void wait(2500).then(() => {
        setChecking(null)
        setDraft(d => ({ ...d, stage: 'checked', reportStale: false, report: { ...d.report!, outcome: 'passed', examples: d.report!.examples.map(e => ({ ...e, status: e.status === 'fail' ? 'pass' : e.status, differences: [] })) } }))
      })
    },
    submit: log('send for review'),
    discard: log('discard draft'),
    openChat: log('open chat'),
    keepEdit: decide('kept'),
    discardEdit: decide('discarded'),
    saveStep: async input => {
      await wait(500)
      console.log('[playground] save step', input)
      return { applied: true, diagnostics: [] }
    },
    openCase: id => console.log('[playground] open case', id),
    openPlaybook: id => console.log('[playground] open playbook', id),
  }
  return (
    <div className="h-[900px] w-full overflow-hidden rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <DraftView draft={draft} live={sampleLivePlaybook} roles={sampleRoles} actions={actions} checking={checking} tab={current} onTabChange={setCurrent} />
      </Info_Page>
    </div>
  )
}

function ChangeMapDemo({ withLive }: { withLive: boolean }) {
  return (
    <div className="w-full p-6">
      <WorkflowMap playbook={sampleDraftPlaybook} mode="change" change={{ diff: sampleStructure, live: withLive ? sampleLivePlaybook : undefined }} roles={sampleRoles} onSelectState={() => {}} />
    </div>
  )
}

function StepEditorDemo({ editable }: { editable: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[760px] p-6">
      <StepEditor
        draft={sampleDraft}
        live={sampleLivePlaybook}
        roles={sampleRoles}
        onSave={editable ? async input => { await wait(500); console.log('[playground] save step', input); return { applied: true, diagnostics: [] } } : undefined}
      />
    </div>
  )
}

function VersionsDemo() {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 p-6">
      <VersionLine versions={sampleVersions} now={NOW} />
      <div className="w-80 overflow-hidden rounded-lg bg-floating shadow-elev-2"><VersionList versions={sampleVersions} now={NOW} /></div>
      <PlaybookDrafts drafts={sampleDraftSummaries} onOpen={id => console.log('[playground] open draft', id)} now={NOW} />
    </div>
  )
}

function BuildingInboxDemo({ which }: { which: 'conversation' | 'review' }) {
  const ok = async () => ({ applied: true })
  const actions: InboxActions = {
    submitStep: ok,
    decideApproval: ok,
    sendEvent: ok,
    uploadFile: async f => ({ id: f.name, name: f.name, mime: f.type, size: f.size, sha256: '' }),
    openCase: log('open case'),
    continueChat: log('continue in chat'),
    openDraft: id => console.log('[playground] open draft', id),
  }
  return (
    <div className="h-[640px] w-full overflow-hidden rounded-lg bg-background shadow-elev-1">
      <InboxItemView item={which === 'conversation' ? sampleConversationItem : sampleReviewItem} actions={actions} roles={sampleRoles} now={NOW} />
    </div>
  )
}

function NewPlaybookDemo() {
  const [request, setRequest] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [open, setOpen] = React.useState(true)
  return (
    <div className="p-6">
      <button type="button" className="text-label underline" onClick={() => setOpen(true)}>Open</button>
      <NewPlaybookForm open={open} onOpenChange={setOpen} request={request} onRequestChange={setRequest} title={title} onTitleChange={setTitle} onStart={log('start building')} />
    </div>
  )
}

function PlaybooksListDemo() {
  const playbooks = [
    ...samplePlaybookSummaries,
    { id: 'create-playbook', version: 1, title: 'Build a playbook', stepCount: 4, open: 1, waitingOnMe: 1, done: 0 },
    { id: 'change-playbook', version: 1, title: 'Change a playbook', stepCount: 5, open: 1, waitingOnMe: 0, done: 2 },
  ]
  const [selected, setSelected] = React.useState<string | null>('drf_sanctions')
  return (
    <div className="flex h-[520px] w-[320px] flex-col overflow-hidden rounded-lg bg-background shadow-elev-1">
      <PlaybooksList playbooks={playbooks} drafts={sampleDraftSummaries} selectedDraftId={selected} onSelect={() => setSelected(null)} onSelectDraft={setSelected} />
    </div>
  )
}

const STAGES = (['draft', 'checked', 'failed', 'in_review', 'published', 'discarded'] as const).map(s => ({ label: s, value: s }))
const TABS = (['changes', 'steps', 'map', 'checks', 'history'] as const).map(s => ({ label: s, value: s }))

export const memwiseDraftsComponents: ComponentEntry[] = [
  {
    id: 'memwise-draft',
    name: 'Draft',
    category: 'MemWise',
    description: 'A draft of a playbook: what changes in words and line by line, the steps, the map of the change, the checks and the history, with the chat\'s changes to keep or discard.',
    component: DraftDemo,
    layout: 'top',
    props: [
      { name: 'stage', control: { type: 'select', options: STAGES }, defaultValue: 'failed' },
      { name: 'tab', control: { type: 'select', options: TABS }, defaultValue: 'changes' },
      { name: 'stale', description: 'Changed since the last check', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      { name: 'Changes', props: { stage: 'failed', tab: 'changes', stale: false } },
      { name: 'Checks', props: { stage: 'failed', tab: 'checks', stale: false } },
      { name: 'Checks, out of date', props: { stage: 'checked', tab: 'checks', stale: true } },
      { name: 'In review', props: { stage: 'in_review', tab: 'changes', stale: false } },
    ],
  },
  {
    id: 'memwise-change-map',
    name: 'Playbook map (change)',
    category: 'MemWise',
    description: 'The map of a proposed change: new in green, changed in amber, removed in red and dashed.',
    component: ChangeMapDemo,
    layout: 'top',
    props: [{ name: 'withLive', description: 'Draw removed steps from the live playbook', control: { type: 'boolean' }, defaultValue: true }],
  },
  {
    id: 'memwise-step-editor',
    name: 'Step editor',
    category: 'MemWise',
    description: 'One card per step; edit the title, who does it, instructions and checks. Changed and pending parts are marked.',
    component: StepEditorDemo,
    layout: 'top',
    props: [{ name: 'editable', control: { type: 'boolean' }, defaultValue: true }],
  },
  {
    id: 'memwise-versions',
    name: 'Versions and drafts',
    category: 'MemWise',
    description: 'A playbook\'s version line, the versions with their running cases, and its drafts in progress.',
    component: VersionsDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'memwise-building-inbox',
    name: 'Inbox: building playbooks',
    category: 'MemWise',
    description: 'A chat to build a playbook, and the review of a change, as inbox items.',
    component: BuildingInboxDemo,
    layout: 'top',
    props: [{ name: 'which', control: { type: 'select', options: [{ label: 'Chat', value: 'conversation' }, { label: 'Review', value: 'review' }] }, defaultValue: 'conversation' }],
  },
  {
    id: 'memwise-new-playbook',
    name: 'New playbook',
    category: 'MemWise',
    description: 'What should it do? Starts building it in a chat.',
    component: NewPlaybookDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'memwise-playbooks-list-drafts',
    name: 'Playbooks list with drafts',
    category: 'MemWise',
    description: 'Drafts first, then the playbooks, then the playbooks that build playbooks.',
    component: PlaybooksListDemo,
    layout: 'top',
    props: [],
  },
]
