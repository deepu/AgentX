import * as React from 'react'
import type { ComponentEntry } from './types'
import type { MwExplanation, MwInboxItem, MwSubmitResult } from '@memwise/shared/protocol'
import { InboxItemView, type InboxActions } from '@/components/memwise/InboxItemView'
import { CaseView } from '@/components/memwise/CaseView'
import { StepRecordView } from '@/components/memwise/StepRecordView'
import { InboxList, CasesList, PlaybooksList } from '@/components/memwise/MemwiseListPanels'
import { ActingAsSwitcherView } from '@/components/memwise/MemwiseStatus'
import { peopleById } from '@/components/memwise/format'
import {
  sampleCase,
  sampleCaseSummaries,
  sampleExplanation,
  sampleInbox,
  samplePeople,
  samplePlaybook,
  samplePlaybookSummaries,
  sampleRoles,
  sampleStepRecord,
} from '@/components/memwise/sample-data'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const people = peopleById(samplePeople)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function mockActions(rejectFields: boolean): InboxActions {
  const answer = async (): Promise<MwSubmitResult> => {
    await wait(600)
    if (rejectFields) {
      return { applied: false, errors: { gstin: ['`27AAACM1234M1Z` is not a valid GSTIN'] }, message: 'One value failed validation.' }
    }
    return { applied: true }
  }
  return {
    submitStep: answer,
    decideApproval: answer,
    sendEvent: answer,
    uploadFile: async file => {
      await wait(400)
      return { id: `file_${file.name}`, name: file.name, mime: file.type, size: file.size, sha256: '' }
    },
    openCase: caseId => console.log('[playground] open case', caseId),
  }
}

function InboxDemo({ kind, rejectFields }: { kind: MwInboxItem['kind']; rejectFields: boolean }) {
  const [selected, setSelected] = React.useState<string>(() => sampleInbox.find(i => i.kind === kind)!.id)
  React.useEffect(() => setSelected(sampleInbox.find(i => i.kind === kind)!.id), [kind])
  const item = sampleInbox.find(i => i.id === selected)!
  return (
    <div className="flex h-[760px] w-full overflow-hidden rounded-lg bg-background shadow-elev-1">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-separator">
        <InboxList items={sampleInbox} selectedId={selected} onSelect={setSelected} now={NOW} />
      </div>
      <div className="min-w-0 flex-1">
        <InboxItemView key={item.id + String(rejectFields)} item={item} actions={mockActions(rejectFields)} people={people} roles={sampleRoles} now={NOW} />
      </div>
    </div>
  )
}

function CaseDemo({ withMap }: { withMap: boolean }) {
  const [step, setStep] = React.useState<string | null>(null)
  const [explanations, setExplanations] = React.useState<MwExplanation[]>([])
  const [asking, setAsking] = React.useState(false)
  const ask = async (question: string) => {
    setAsking(true)
    await wait(800)
    setExplanations(prev => [...prev, { ...sampleExplanation, id: `exp_${prev.length}`, question }])
    setAsking(false)
  }
  return (
    <div className="flex h-[860px] w-full overflow-hidden rounded-lg bg-background shadow-elev-1">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-separator">
        <CasesList cases={sampleCaseSummaries} playbooks={samplePlaybookSummaries} roles={sampleRoles} selectedId={sampleCase.caseId} onSelect={() => {}} now={NOW} />
      </div>
      <div className="min-w-0 flex-1">
        <CaseView
          kase={sampleCase}
          playbook={withMap ? samplePlaybook : null}
          people={people}
          roles={sampleRoles}
          onOpenStep={id => { setStep(id); setExplanations([]) }}
          onOpenChat={() => console.log('[playground] open chat')}
          now={NOW}
        />
      </div>
      {step && (
        <div className="w-[520px] shrink-0 overflow-y-auto border-l border-separator bg-floating p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-label font-semibold">{sampleStepRecord.title}</span>
            <button type="button" className="text-label-sm text-secondary hover:underline" onClick={() => setStep(null)}>Close</button>
          </div>
          <StepRecordView
            record={sampleStepRecord}
            people={people}
            explanations={explanations}
            onAsk={q => void ask(q)}
            asking={asking}
            onOpenChat={() => console.log('[playground] open chat on step')}
          />
        </div>
      )}
    </div>
  )
}

function StepRecordDemo({ answered }: { answered: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[600px] p-6">
      <StepRecordView record={sampleStepRecord} people={people} explanations={answered ? [sampleExplanation] : []} onAsk={() => {}} onOpenChat={() => {}} />
    </div>
  )
}

function ListsDemo() {
  const [inbox, setInbox] = React.useState<string | null>(null)
  return (
    <div className="grid h-[520px] w-full grid-cols-3 gap-4">
      <div className="flex flex-col overflow-hidden rounded-lg bg-background shadow-elev-1"><InboxList items={sampleInbox} selectedId={inbox} onSelect={setInbox} now={NOW} /></div>
      <div className="flex flex-col overflow-hidden rounded-lg bg-background shadow-elev-1"><CasesList cases={sampleCaseSummaries} playbooks={samplePlaybookSummaries} roles={sampleRoles} onSelect={() => {}} now={NOW} /></div>
      <div className="flex flex-col overflow-hidden rounded-lg bg-background shadow-elev-1"><PlaybooksList playbooks={samplePlaybookSummaries} onSelect={() => {}} /></div>
    </div>
  )
}

function ActingAsDemo() {
  const [me, setMe] = React.useState(samplePeople[0]!)
  return (
    <div className="w-[240px] rounded-lg bg-background py-2 shadow-elev-1">
      <ActingAsSwitcherView me={me} people={samplePeople} roles={sampleRoles} onSelect={id => setMe(samplePeople.find(p => p.id === id)!)} />
    </div>
  )
}

const KIND_OPTIONS = (['input', 'decision', 'approval', 'attention', 'reminder'] as const).map(k => ({ label: k, value: k }))

export const memwiseScreensComponents: ComponentEntry[] = [
  {
    id: 'memwise-inbox',
    name: 'Inbox',
    category: 'MemWise',
    description: 'The inbox list and an item opened in place: a generated form, an approval card, an effect approval, a stopped case, a reminder.',
    component: InboxDemo,
    layout: 'top',
    props: [
      { name: 'kind', control: { type: 'select', options: KIND_OPTIONS }, defaultValue: 'input' },
      { name: 'rejectFields', description: 'The server rejects a field on submit', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: KIND_OPTIONS.map(o => ({ name: o.label, props: { kind: o.value, rejectFields: false } })),
  },
  {
    id: 'memwise-case-view',
    name: 'Case view',
    category: 'MemWise',
    description: "A case: fields with provenance badges, the map with this case's path and the step timeline. Click a step for its record and \"Ask about this step\".",
    component: CaseDemo,
    layout: 'top',
    props: [{ name: 'withMap', description: 'Playbook loaded (draws the map)', control: { type: 'boolean' }, defaultValue: true }],
  },
  {
    id: 'memwise-step-record',
    name: 'Step record',
    category: 'MemWise',
    description: 'Outcome, outputs with provenance, checks, tool and model calls, usage, and an explanation with its sources.',
    component: StepRecordDemo,
    layout: 'top',
    props: [{ name: 'answered', description: 'Show an answered question', control: { type: 'boolean' }, defaultValue: true }],
  },
  {
    id: 'memwise-lists',
    name: 'Inbox, cases and playbooks lists',
    category: 'MemWise',
    description: 'The navigator lists for the three MemWise sections.',
    component: ListsDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'memwise-acting-as',
    name: 'Acting as',
    category: 'MemWise',
    description: 'The sidebar footer person switcher (desktop).',
    component: ActingAsDemo,
    props: [],
  },
]
