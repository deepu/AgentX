/**
 * A draft of a playbook (20 §8, "Draft review"): what it changes in plain words and line by line,
 * its steps in the editor, the map in proposed-change mode, its checks, and its history with the
 * chat's edits to keep or discard. Also what the review step's inbox card opens. Presentational:
 * the page passes the API calls in `actions`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ClipboardCheck, FilePen, History, ListChecks, Map as MapIcon, MessageSquare, Send, Trash2, Waypoints } from 'lucide-react'
import type { MwDraft, MwPlaybook, MwRole, MwSubmitResult, MwWriteDraftResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { absoluteTime, relativeTime } from '../format'
import { WorkflowMap } from '../map'
import { useNow } from '../use-now'
import { ChangesView } from './ChangesView'
import { CheckProgress, ChecksView } from './ChecksView'
import { EditHistory, PendingEdits } from './EditHistory'
import { StepEditor, type SaveStepInput } from './StepEditor'
import { isOpenDraft, pendingEdits, stageLabel, stageTone, stepsTouchedBy } from './draft-model'

export type DraftTab = 'changes' | 'steps' | 'map' | 'checks' | 'history'

export interface DraftActions {
  check?: () => void
  submit?: () => void
  discard?: () => void
  /** Opens the chat that builds or changes this draft, beside it. */
  openChat?: () => void
  keepEdit?: (editId: string) => Promise<MwSubmitResult>
  discardEdit?: (editId: string) => Promise<MwSubmitResult>
  saveStep?: (input: SaveStepInput) => Promise<MwWriteDraftResult>
  openCase?: (caseId: string) => void
  openPlaybook?: (workflowId: string) => void
}

export interface DraftViewProps {
  draft: MwDraft
  /** The live playbook (absent for a new one). */
  live?: MwPlaybook | null
  roles?: MwRole[]
  actions: DraftActions
  /** Set while a check runs. */
  checking?: { startedAt: number } | null
  /** An action in flight. */
  busy?: 'submit' | 'discard' | null
  tab?: DraftTab
  onTabChange?: (tab: DraftTab) => void
  /** Opens the editor on this step (tests, playground). */
  editingStepId?: string
  now?: number
}

const TONE_TO_BADGE = { default: 'default', success: 'success', warning: 'warning', destructive: 'destructive', muted: 'muted' } as const

export function DraftView({ draft, live, roles, actions, checking, busy, tab: controlledTab, onTabChange, editingStepId, now: fixedNow }: DraftViewProps) {
  const { t, i18n } = useTranslation()
  const now = useNow(fixedNow)
  const [ownTab, setOwnTab] = React.useState<DraftTab>(controlledTab ?? 'changes')
  const tab = controlledTab ?? ownTab
  const setTab = (next: DraftTab) => { setOwnTab(next); onTabChange?.(next) }
  const [focusStep, setFocusStep] = React.useState<string | undefined>()

  const open = isOpenDraft(draft)
  const editable = open && draft.stage !== 'in_review'
  const pending = pendingEdits(draft)
  const pendingSteps = new Set(pending.flatMap(stepsTouchedBy))
  const checked = draft.stage === 'checked' && !draft.reportStale
  const errors = draft.diagnostics.filter(d => d.severity === 'error').length + (draft.report && !draft.reportStale ? draft.report.errors : 0)
  const editActions = editable ? { keep: actions.keepEdit, discard: actions.discardEdit } : {}
  // Built or changed in a chat that hasn't finished: the chat sends it for review, not this screen.
  const inChat = !!draft.inChat

  const openStep = (stepId: string) => {
    setFocusStep(stepId)
    setTab('steps')
  }

  const versionText = draft.kind === 'create'
    ? t('memwise.draft.newPlaybook')
    : draft.publishedVersion !== undefined
      ? t('memwise.draft.publishedAs', { version: draft.publishedVersion })
      : draft.structure?.version.to !== undefined && draft.baseVersion !== undefined
        ? t('memwise.draft.versionChange', { from: draft.baseVersion, to: draft.structure.version.to })
        : draft.baseVersion !== undefined
          ? t('memwise.draft.fromVersion', { version: draft.baseVersion })
          : undefined

  return (
    <Info_Page.Content wide={tab === 'map'}>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><FilePen className="size-4" /></div>}
        title={draft.title}
        meta={
          <>
            <Info_Badge color={TONE_TO_BADGE[stageTone(draft.stage)]} dot data-stage={draft.stage}>{stageLabel(draft.stage, t)}</Info_Badge>
            {actions.openPlaybook && draft.kind === 'change' ? (
              <button type="button" className="hover:underline" onClick={() => actions.openPlaybook!(draft.workflowId)}>{draft.playbookTitle}</button>
            ) : (
              <span>{draft.playbookTitle}</span>
            )}
            {versionText && <span>{versionText}</span>}
            <span title={absoluteTime(draft.createdAt, i18n.language)}>
              {draft.createdByName || draft.createdBy
                ? t('memwise.draft.startedBy', { name: draft.createdByName ?? draft.createdBy, time: relativeTime(draft.createdAt, now, i18n.language) })
                : t('memwise.draft.started', { time: relativeTime(draft.createdAt, now, i18n.language) })}
            </span>
            <span>{t('memwise.case.updatedAt', { time: relativeTime(draft.updatedAt, now, i18n.language) })}</span>
          </>
        }
      />

      {open && (
        <div className="flex flex-wrap items-center gap-2" data-draft-actions>
          {actions.openChat && (
            <Button variant={inChat && editable && actions.submit ? 'primary' : 'secondary'} size="sm" onClick={actions.openChat} data-action="open-chat">
              <MessageSquare />
              {t('memwise.draft.openChat')}
            </Button>
          )}
          {editable && actions.check && (
            <Button variant="secondary" size="sm" onClick={actions.check} disabled={!!checking} data-action="check">
              <ListChecks />
              {checking ? t('memwise.draft.checking') : t('memwise.draft.check')}
            </Button>
          )}
          {editable && actions.submit && (
            <Button
              variant={inChat ? 'secondary' : 'primary'}
              size="sm"
              onClick={actions.submit}
              disabled={inChat || !checked || pending.length > 0 || !!checking || busy === 'submit'}
              title={inChat ? t('memwise.draft.submitInChat') : !checked ? t('memwise.draft.submitNeedsCheck') : pending.length > 0 ? t('memwise.draft.submitNeedsKeep') : undefined}
              data-action="submit"
            >
              <Send />
              {busy === 'submit' ? t('memwise.inbox.sending') : t('memwise.draft.submit')}
            </Button>
          )}
          {editable && actions.submit && inChat && (
            <span className="text-label-sm text-tertiary" data-in-chat>{t('memwise.draft.finishInChat')}</span>
          )}
          <span className="flex-1" />
          {editable && actions.discard && (
            <Button variant="danger" size="sm" onClick={actions.discard} disabled={busy === 'discard'} data-action="discard-draft">
              <Trash2 />
              {t('memwise.draft.discard')}
            </Button>
          )}
        </div>
      )}

      {draft.stage === 'in_review' && (
        <Info_Alert variant="info" icon={<ClipboardCheck />}>
          <Info_Alert.Title>{t('memwise.draft.inReviewTitle')}</Info_Alert.Title>
          <Info_Alert.Description>{t('memwise.draft.inReviewDescription')}</Info_Alert.Description>
          {draft.caseId && actions.openCase && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => actions.openCase!(draft.caseId!)}>{t('memwise.draft.openChangeCase')}</Button>
          )}
        </Info_Alert>
      )}
      {draft.stage === 'published' && (
        <Info_Alert variant="success" icon={<CheckCircle2 />}>
          <Info_Alert.Title>{t('memwise.draft.publishedTitle', { version: draft.publishedVersion ?? '' })}</Info_Alert.Title>
        </Info_Alert>
      )}
      {checking && tab !== 'checks' && <CheckProgress startedAt={checking.startedAt} now={fixedNow} />}
      {editable && <PendingEdits draft={draft} live={live} actions={editActions} now={now} />}

      <Tabs value={tab} onValueChange={v => setTab(v as DraftTab)}>
        <TabsList>
          <TabsTrigger value="changes"><Waypoints />{t('memwise.draft.tab.changes')}</TabsTrigger>
          <TabsTrigger value="steps"><FilePen />{t('memwise.draft.tab.steps')}</TabsTrigger>
          <TabsTrigger value="map"><MapIcon />{t('memwise.draft.tab.map')}</TabsTrigger>
          <TabsTrigger value="checks">
            <ListChecks />
            {t('memwise.draft.tab.checks')}
            {errors > 0 && <span className="ml-1 rounded-full bg-destructive-tint px-1.5 text-[11px] text-destructive tabular-nums">{errors}</span>}
          </TabsTrigger>
          <TabsTrigger value="history"><History />{t('memwise.draft.tab.history')}</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="mt-4">
          <ChangesView draft={draft} live={live} pendingSteps={pendingSteps} onOpenStep={openStep} />
        </TabsContent>
        <TabsContent value="steps" className="mt-4">
          <StepEditor
            draft={draft}
            live={live}
            roles={roles}
            onSave={editable ? actions.saveStep : undefined}
            focusStepId={focusStep}
            editingStepId={editingStepId}
          />
        </TabsContent>
        <TabsContent value="map" className="mt-4">
          {draft.playbook ? (
            <div className="overflow-x-auto rounded-lg bg-raised p-3 shadow-elev-1">
              <WorkflowMap
                playbook={draft.playbook}
                mode={draft.structure ? 'change' : 'design'}
                change={draft.structure ? { diff: draft.structure, live } : undefined}
                roles={roles}
                onSelectState={id => { if (draft.playbook?.states.some(s => s.id === id && s.stepId)) openStep(id) }}
              />
            </div>
          ) : (
            <p className="text-label text-tertiary">{t('memwise.editor.doesNotLoad')}</p>
          )}
        </TabsContent>
        <TabsContent value="checks" className="mt-4">
          <ChecksView draft={draft} live={live} checking={checking} onCheck={editable ? actions.check : undefined} onOpenCase={actions.openCase} now={fixedNow} />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <Info_Section title={t('memwise.draft.tab.history')} count={draft.edits.length}>
            <EditHistory draft={draft} live={live} actions={editActions} now={now} />
          </Info_Section>
        </TabsContent>
      </Tabs>
    </Info_Page.Content>
  )
}
