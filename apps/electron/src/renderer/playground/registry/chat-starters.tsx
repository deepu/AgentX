/**
 * Playground mock for #1095 — configurable new-chat starter prompts (Settings → AI).
 *
 * Shows the proposed `chatStarters` section exactly as it would appear in AiSettingsPage,
 * with an inline add form (with @-mention support for skills and sources), per-row delete,
 * a live chip preview, and a config.json output pane. All state is local — no IPC.
 */

import React, { useState, useRef, useId } from 'react'
import { Grip, Trash2, Plus, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineMentionMenu, useInlineMention } from '@/components/ui/mention-menu'
import type { MentionItem } from '@/components/ui/mention-menu'
import { RichTextInput, type RichTextInputHandle } from '@/components/ui/rich-text-input'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import {
  SettingsSection,
  SettingsCard,
  SettingsCardDivider,
} from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { cn } from '@/lib/utils'
import type { ComponentEntry } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatStarter {
  id: string
  label: string
  prompt: string
}

// ─── Mock data for the mention menu ───────────────────────────────────────────

const MOCK_SKILLS: LoadedSkill[] = [
  {
    slug: 'daily-standup',
    metadata: { name: 'Daily Standup', description: 'Run the daily standup flow' },
    content: '',
    path: '/mock/skills/daily-standup',
    source: 'workspace',
  },
  {
    slug: 'code-review',
    metadata: { name: 'Code Review', description: 'Review recent code changes' },
    content: '',
    path: '/mock/skills/code-review',
    source: 'workspace',
  },
  {
    slug: 'sprint-planning',
    metadata: { name: 'Sprint Planning', description: 'Prepare and kick off a sprint' },
    content: '',
    path: '/mock/skills/sprint-planning',
    source: 'workspace',
  },
] as LoadedSkill[]

const MOCK_SOURCES: LoadedSource[] = [
  {
    config: { id: 'github', name: 'GitHub', slug: 'github', tagline: 'Issues, PRs, and code', enabled: true } as LoadedSource['config'],
    guide: null,
    folderPath: '/mock/sources/github',
    workspaceRootPath: '/mock',
    workspaceId: 'mock-workspace',
  },
  {
    config: { id: 'linear', name: 'Linear', slug: 'linear', tagline: 'Project and issue tracking', enabled: true } as LoadedSource['config'],
    guide: null,
    folderPath: '/mock/sources/linear',
    workspaceRootPath: '/mock',
    workspaceId: 'mock-workspace',
  },
  {
    config: { id: 'slack', name: 'Slack', slug: 'slack', tagline: 'Team messaging and channels', enabled: true } as LoadedSource['config'],
    guide: null,
    folderPath: '/mock/sources/slack',
    workspaceRootPath: '/mock',
    workspaceId: 'mock-workspace',
  },
] as LoadedSource[]

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_STARTERS: ChatStarter[] = [
  { id: '1', label: 'Workspace status', prompt: 'Give me the workspace status dashboard' },
  { id: '2', label: 'What should I work on?', prompt: 'What should I work on next based on my open tasks?' },
  { id: '3', label: 'Start daily standup', prompt: '[skill:mock-workspace:daily-standup] Run my daily standup' },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Mirrors the chip design from NewChatSuggestions.tsx */
function StarterChip({ label }: { label: string }) {
  return (
    <div className="inline-flex h-control-lg max-w-full items-center gap-2 rounded-full border border-default bg-paper px-3.5 text-label text-secondary">
      <Zap aria-hidden className="size-4 shrink-0 text-tertiary" />
      <span className="truncate">{label}</span>
    </div>
  )
}

function StarterRow({ starter, onDelete }: { starter: ChatStarter; onDelete: () => void }) {
  return (
    <div className={cn('flex items-center gap-3', settingsUI.row)}>
      <Grip className="size-4 shrink-0 text-quaternary cursor-grab" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className={settingsUI.label}>{starter.label}</div>
        <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap, 'truncate')}>
          {starter.prompt}
        </div>
      </div>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Remove "${starter.label}"`}
        className="shrink-0 size-7 inline-grid place-items-center rounded-md text-tertiary transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:text-destructive hover:duration-instant"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </div>
  )
}

function AddStarterForm({ onAdd, onCancel }: {
  onAdd: (s: Omit<ChatStarter, 'id'>) => void
  onCancel: () => void
}) {
  const labelId = useId()
  const promptId = useId()
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const promptInputRef = useRef<RichTextInputHandle>(null)

  const inlineMention = useInlineMention({
    inputRef: promptInputRef,
    skills: MOCK_SKILLS,
    sources: MOCK_SOURCES,
    onSelect: () => {},
    workspaceId: 'mock-workspace',
  })

  const canAdd = label.trim().length > 0 && prompt.trim().length > 0

  function handleSubmit() {
    if (!canAdd) return
    onAdd({ label: label.trim(), prompt: prompt.trim() })
  }

  function handleMentionSelect(item: MentionItem) {
    const { value, cursorPosition } = inlineMention.handleSelect(item)
    setPrompt(value)
    // Restore focus and caret once the badge has rendered
    setTimeout(() => {
      promptInputRef.current?.focus()
      promptInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }

  function handleLabelKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && canAdd) handleSubmit()
    if (e.key === 'Escape') onCancel()
  }

  function handlePromptKeyDown(e: React.KeyboardEvent) {
    // Let the mention menu consume arrow/enter/escape when it's open
    if (inlineMention.isOpen) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canAdd) handleSubmit()
    }
    if (e.key === 'Escape') onCancel()
  }

  return (
    <>
      <div className="space-y-3 px-3.5 py-3">
        <div className="space-y-1.5">
          <label htmlFor={labelId} className={settingsUI.label}>Label</label>
          <Input
            id={labelId}
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={handleLabelKeyDown}
            placeholder="e.g. Workspace status"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <div id={promptId} className={settingsUI.label}>Prompt</div>
          <div className="field-surface rounded-md">
            <RichTextInput
              ref={promptInputRef}
              aria-labelledby={promptId}
              value={prompt}
              onChange={setPrompt}
              onInput={(value, cursor) => inlineMention.handleInputChange(value, cursor)}
              onKeyDown={handlePromptKeyDown}
              placeholder="e.g. What changed in my projects today? Type @ to mention a source or skill"
              skills={MOCK_SKILLS}
              sources={MOCK_SOURCES}
              workspaceId="mock-workspace"
              className="px-2.5 py-2 text-label"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!canAdd} onClick={handleSubmit}>Add</Button>
        </div>
      </div>

      <InlineMentionMenu
        open={inlineMention.isOpen}
        onOpenChange={(open) => { if (!open) inlineMention.close() }}
        sections={inlineMention.sections}
        filter={inlineMention.filter}
        position={inlineMention.position}
        onSelect={handleMentionSelect}
        isSearching={inlineMention.isSearching}
        workspaceId="mock-workspace"
      />
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ChatStartersSettingsSection({
  initialStarters = DEFAULT_STARTERS,
}: {
  initialStarters?: ChatStarter[]
}) {
  const [starters, setStarters] = useState<ChatStarter[]>(initialStarters)
  const [adding, setAdding] = useState(false)
  const nextIdRef = { current: starters.length + 100 }

  function handleAdd(s: Omit<ChatStarter, 'id'>) {
    setStarters(prev => [...prev, { ...s, id: String(nextIdRef.current++) }])
    setAdding(false)
  }

  function handleDelete(id: string) {
    setStarters(prev => prev.filter(s => s.id !== id))
  }

  return (
    <div className="space-y-8 p-6 max-w-2xl">

      {/* ── Settings section ─────────────────────────────── */}
      <SettingsSection
        title="Chat Starters"
        description="Custom prompt chips shown on the new-chat screen. Workspace-level — stored in config.json."
      >
        <SettingsCard divided={false}>
          {starters.length === 0 && !adding && (
            <div className="px-3.5 py-6 text-center text-label text-tertiary">
              No custom starters — the default source-based suggestions will appear.
            </div>
          )}

          {starters.map((s, i) => (
            <div key={s.id}>
              {i > 0 && <SettingsCardDivider />}
              <StarterRow starter={s} onDelete={() => handleDelete(s.id)} />
            </div>
          ))}

          {adding && (
            <>
              {starters.length > 0 && <SettingsCardDivider />}
              <AddStarterForm onAdd={handleAdd} onCancel={() => setAdding(false)} />
            </>
          )}
        </SettingsCard>

        {!adding && (
          <div className="pt-0">
            <Button variant="secondary" size="md" onClick={() => setAdding(true)}>
              <Plus className="size-4 mr-1.5" aria-hidden />
              Add starter
            </Button>
          </div>
        )}
      </SettingsSection>

      {/* ── Live preview ──────────────────────────────────── */}
      <SettingsSection
        title="Preview"
        description="How starters appear on the new-chat screen."
      >
        <div className="rounded-lg border border-subtle bg-paper px-6 py-8 flex flex-col items-center gap-4">
          <p className="text-label text-tertiary">What can I help you with?</p>
          {starters.length > 0 ? (
            <div role="group" aria-label="Chat starters preview" className="flex max-w-xl flex-wrap justify-center gap-2">
              {starters.map(s => <StarterChip key={s.id} label={s.label} />)}
            </div>
          ) : (
            <p className="text-label-sm text-tertiary italic">
              Default source-based suggestions will appear here
            </p>
          )}
        </div>
      </SettingsSection>

      {/* ── config.json output ────────────────────────────── */}
      <SettingsSection
        title="config.json output"
        description="What this generates in the workspace config file."
      >
        <div className="rounded-lg border border-subtle bg-sunken px-4 py-3 overflow-x-auto">
          <pre className="text-label-sm text-secondary font-mono whitespace-pre">
            {JSON.stringify(
              { chatStarters: starters.map(({ label, prompt }) => ({ label, prompt })) },
              null, 2
            )}
          </pre>
        </div>
      </SettingsSection>

    </div>
  )
}

// ─── Registry entry ───────────────────────────────────────────────────────────

export const chatStartersComponents: ComponentEntry[] = [
  {
    id: 'chat-starters-settings',
    name: 'Chat Starters Settings',
    category: 'Settings',
    description: '#1095 — mock of the configurable chat starters section (Settings → AI)',
    component: ChatStartersSettingsSection,
    props: [],
    variants: [
      {
        name: 'With starters',
        description: 'Three example starters pre-configured (one with a skill mention)',
        props: {},
      },
      {
        name: 'Empty state',
        description: 'No starters — shows empty state and fallback note',
        props: { initialStarters: [] },
      },
    ],
    layout: 'top',
  },
]
