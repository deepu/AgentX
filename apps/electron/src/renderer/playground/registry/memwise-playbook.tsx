import * as React from 'react'
import type { ComponentEntry } from './types'
import { PlaybookView, StepDetail, samplePlaybook, sampleRoles, sampleLiveCounts, sampleHighlightPath } from '@/components/memwise/playbook'
import { WorkflowMap } from '@/components/memwise/map'

function PlaybookDemo({ withRoles }: { withRoles: boolean }) {
  const [selected, setSelected] = React.useState<string | undefined>()
  return (
    <div className="mx-auto w-full max-w-[760px] p-6">
      <PlaybookView playbook={samplePlaybook} roles={withRoles ? sampleRoles : undefined} selectedStepId={selected} onSelectStep={setSelected} />
    </div>
  )
}

function MapDemo({ mode, showPath }: { mode: 'design' | 'live'; showPath: boolean }) {
  const [selected, setSelected] = React.useState<string | undefined>()
  const step = selected ? samplePlaybook.steps[samplePlaybook.states.find((s) => s.id === selected)?.stepId ?? ''] : undefined
  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <WorkflowMap
        playbook={samplePlaybook}
        roles={sampleRoles}
        mode={mode}
        live={mode === 'live' ? sampleLiveCounts : undefined}
        highlightPath={showPath ? sampleHighlightPath : undefined}
        selectedStateId={selected}
        onSelectState={setSelected}
      />
      {step && (
        <div className="max-w-[720px] rounded-lg border border-border bg-raised p-4">
          <StepDetail step={step} playbook={samplePlaybook} roles={sampleRoles} />
        </div>
      )}
    </div>
  )
}

export const memwisePlaybookComponents: ComponentEntry[] = [
  {
    id: 'memwise-playbook-view',
    name: 'Playbook view',
    category: 'MemWise',
    description: 'A playbook read as a document: numbered steps, who does each, tools, checks, what happens next and each step\'s rules.',
    component: PlaybookDemo,
    layout: 'top',
    props: [{ name: 'withRoles', description: 'Pass role titles for assignee tags', control: { type: 'boolean' }, defaultValue: true }],
  },
  {
    id: 'memwise-workflow-map',
    name: 'Playbook map',
    category: 'MemWise',
    description: 'The playbook drawn left to right with problems below. Click a step to open its detail.',
    component: MapDemo,
    layout: 'top',
    props: [
      { name: 'mode', control: { type: 'select', options: [{ label: 'Design', value: 'design' }, { label: 'Live', value: 'live' }] }, defaultValue: 'design' },
      { name: 'showPath', description: "Highlight one case's path", control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      { name: 'Design', props: { mode: 'design', showPath: false } },
      { name: 'Live with a case path', props: { mode: 'live', showPath: true } },
    ],
  },
  {
    id: 'memwise-workflow-map-live',
    name: 'Playbook map (live)',
    category: 'MemWise',
    description: 'Live mode: open cases per step, line thickness from transitions in the last 30 days, and one case\'s path.',
    component: MapDemo,
    layout: 'top',
    props: [
      { name: 'mode', control: { type: 'select', options: [{ label: 'Design', value: 'design' }, { label: 'Live', value: 'live' }] }, defaultValue: 'live' },
      { name: 'showPath', description: "Highlight one case's path", control: { type: 'boolean' }, defaultValue: true },
    ],
  },
]
