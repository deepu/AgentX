/**
 * Chat header (design spec §7.3) in isolation: status glyph, title, "workspace · folder" meta, label
 * chips with "+N" overflow, Info, Share and ⋯, on the desktop and compact layouts.
 */

import * as React from 'react'
import { ChevronLeft, Circle, CircleCheck, CircleDot, X } from 'lucide-react'
import type { LabelConfig } from '@memwise/shared/labels'
import { AppShellProvider } from '@/context/AppShellContext'
import { ChatHeader } from '@/components/app-shell/chat-header/ChatHeader'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import { cn } from '@/lib/utils'
import { playgroundAppShellValue } from '../PlaygroundAppShellProvider'
import { ensureMockElectronAPI } from '../mock-utils'
import type { ComponentEntry } from './types'

const STATUSES: SessionStatus[] = [
  { id: 'todo', label: 'Todo', resolvedColor: 'var(--text-tertiary)', icon: <Circle strokeWidth={1.75} />, iconColorable: true, category: 'open' },
  { id: 'in-progress', label: 'In Progress', resolvedColor: 'var(--accent-text)', icon: <CircleDot strokeWidth={1.75} />, iconColorable: true, category: 'open' },
  { id: 'done', label: 'Done', resolvedColor: 'var(--success-text)', icon: <CircleCheck strokeWidth={1.75} />, iconColorable: true, category: 'closed' },
]

const LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'code', name: 'Code', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'string' },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'design', name: 'Design', color: { light: '#8B5CF6', dark: '#A78BFA' } },
  { id: 'due', name: 'Due', color: { light: '#10B981', dark: '#34D399' }, valueType: 'date' },
  { id: 'customer', name: 'Customer escalation', color: { light: '#EC4899', dark: '#F472B6' } },
]
const LABEL_ENTRIES = ['bug', 'code::git', 'priority::2', 'design', 'due::2026-10-09', 'customer']

const SHORT_TITLE = 'Create a new branch based on latest main'
const LONG_TITLE = 'Create a new branch based on latest main bugfix/session-continuation and port the regression test'

interface ChatHeaderDemoProps {
  labelCount?: number
  longTitle?: boolean
  shared?: boolean
  withFolder?: boolean
  compact?: boolean
  width?: number
}

function ChatHeaderDemo({ labelCount = 2, longTitle = false, shared = false, withFolder = true, compact = false, width = 900 }: ChatHeaderDemoProps) {
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  const [status, setStatus] = React.useState('in-progress')
  const [labels, setLabels] = React.useState(() => LABEL_ENTRIES.slice(0, labelCount))
  React.useEffect(() => setLabels(LABEL_ENTRIES.slice(0, labelCount)), [labelCount])

  const item: SessionMeta = {
    id: 'playground-chat-header',
    workspaceId: playgroundAppShellValue.activeWorkspaceId ?? 'playground-workspace',
    name: longTitle ? LONG_TITLE : SHORT_TITLE,
    labels,
    sessionStatus: status,
    sharedUrl: shared ? 'https://example.com/s/abc123' : undefined,
    workingDirectory: withFolder ? '/Users/demo/memwise' : undefined,
  }

  const context = React.useMemo(() => ({
    ...playgroundAppShellValue,
    isCompactMode: compact,
    sessionStatuses: STATUSES,
    labels: LABELS,
    onSessionStatusChange: (_id: string, next: string) => setStatus(next),
    onSessionLabelsChange: (_id: string, next: string[]) => setLabels(next),
    leadingAction: compact ? <PanelHeaderCenterButton icon={<ChevronLeft className="h-4 w-4" />} tooltip="Back to list" /> : undefined,
    rightSidebarButton: <PanelHeaderCenterButton icon={<X className="h-4 w-4" />} tooltip="Close" />,
  }), [compact])

  return (
    <AppShellProvider value={context}>
      {/* The shell and panel containers the header's compact sizes and container queries read. A narrow
       * desktop panel still sits in a wide shell; only the compact shell itself is narrow. */}
      <div className="@container/shell" style={{ width: compact ? width : Math.max(width, 900) }}>
        <div data-compact={compact || undefined} className="@container/panel rounded-xl bg-paper shadow-elev-0" style={{ width }}>
          <ChatHeader
            sessionId={item.id}
            item={item}
            title={item.name ?? ''}
            sharedUrl={item.sharedUrl}
            workingDirectory={item.workingDirectory}
          />
          <div className={cn('h-24 border-t border-subtle px-6 py-4 text-label-sm text-tertiary')}>
            Transcript…
          </div>
        </div>
      </div>
    </AppShellProvider>
  )
}

export const chatHeaderComponents: ComponentEntry[] = [
  {
    id: 'chat-header',
    name: 'Chat header',
    category: 'Chat',
    description: 'Status glyph, title (rename), workspace · folder, label chips with +N overflow, Info, Share, ⋯ (spec §7.3)',
    component: ChatHeaderDemo,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      { name: 'labelCount', description: 'Labels on the session (0–6)', control: { type: 'number', min: 0, max: 6, step: 1 }, defaultValue: 2 },
      { name: 'longTitle', description: 'Long title (truncation)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'shared', description: 'Published to the viewer', control: { type: 'boolean' }, defaultValue: false },
      { name: 'withFolder', description: 'Working folder set', control: { type: 'boolean' }, defaultValue: true },
      { name: 'compact', description: 'Compact shell (phone)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'width', description: 'Panel width (px)', control: { type: 'number', min: 320, max: 1400, step: 10 }, defaultValue: 900 },
    ],
    variants: [
      { name: 'No labels', props: { labelCount: 0 } },
      { name: 'Two labels', props: { labelCount: 2 } },
      { name: 'Overflow (6 labels)', props: { labelCount: 6 } },
      { name: 'Narrow panel', props: { labelCount: 6, longTitle: true, width: 480 } },
      { name: 'Shared, long title', props: { labelCount: 3, longTitle: true, shared: true } },
      { name: 'Compact', props: { labelCount: 3, compact: true, width: 390 } },
    ],
  },
]
