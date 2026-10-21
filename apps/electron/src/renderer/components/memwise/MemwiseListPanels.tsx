/**
 * Navigator lists for the MemWise sections: the inbox (newest first), cases (filter by
 * playbook and status) and playbooks. Rows use EntityRow so they read like the session list.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, Bell, BookOpen, Briefcase, CheckCircle2, ClipboardCheck, ClipboardList, FileCheck2, FilePen, HelpCircle, Link2, MessagesSquare, Play, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import type { MwCaseSummary, MwDraftSummary, MwInboxItem, MwPlaybookSummary, MwRole, MwRunStatus } from '@memwise/shared/protocol'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  memwiseCaseFilterAtom,
  memwiseCasesAtom,
  memwiseDraftsAtom,
  memwiseInboxAtom,
  memwisePlaybooksAtom,
  memwiseReviewQueueAtom,
  memwiseRolesAtom,
  memwiseStartCaseDialogAtom,
} from '@/atoms/memwise'
import { MemwiseStatusBanner } from './MemwiseStatus'
import { DomainFilterRow, inboxItemDomain, useDomainFilter, useInboxDomains } from './domains/DomainFilter'
import { firstDocumentReview } from './records/record-model'
import { originLabel } from './plugins/plugin-model'
import { useNow } from './use-now'
import { isMetaPlaybook, isOpenDraft, sortDrafts, stageLabel, stageTone } from './draft/draft-model'
import {
  absoluteTime,
  caseStatusLabel,
  filterCases,
  inboxItemStepTitle,
  inboxKindLabel,
  relativeTime,
  sortInbox,
  stateLabel,
  waitingOnLabel,
} from './format'

const KIND_ICON: Record<MwInboxItem['kind'], React.ComponentType<{ className?: string }>> = {
  input: ClipboardList,
  decision: CheckCircle2,
  approval: ShieldCheck,
  attention: AlertTriangle,
  reminder: Bell,
  conversation: MessagesSquare,
  identity: Link2,
  flag: AlertTriangle,
  'trigger-hold': Bell,
  'change-request': FileCheck2,
  'inspector-question': HelpCircle,
}

function ListSkeleton() {
  return (
    <div className="space-y-3 px-4 py-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  )
}

/**
 * A subtitle with its chips right after the text: the text takes what the chips leave (EntityRow's
 * own `subtitleTrailing` reserves half the line for label chips, which cut short subtitles).
 */
function SubtitleWithChips({ text, children }: { text: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">{text}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>
    </span>
  )
}

// ---------------------------------------------------------------- inbox

export interface InboxListProps {
  items: MwInboxItem[] | null
  selectedId?: string | null
  onSelect: (id: string) => void
  now?: number
  className?: string
}

export function InboxList({ items, selectedId, onSelect, now: fixedNow, className }: InboxListProps) {
  const { t, i18n } = useTranslation()
  const now = useNow(fixedNow)
  if (items === null) return <ListSkeleton />
  if (items.length === 0) {
    return (
      <EntityListEmptyScreen
        icon={<ClipboardCheck />}
        title={t('memwise.inbox.emptyTitle')}
        description={t('memwise.inbox.emptyDescription')}
        className={cn('flex-1', className)}
      />
    )
  }
  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="pt-1 pb-2" data-list-role="memwise-inbox">
        {sortInbox(items).map(item => {
          const Icon = KIND_ICON[item.kind]
          return (
            <EntityRow
              key={item.id}
              isSelected={selectedId === item.id}
              onClick={() => onSelect(item.id)}
              icon={<Icon className={cn('h-3.5 w-3.5', item.kind === 'attention' ? 'text-info' : 'text-foreground/60')} />}
              title={item.caseTitle}
              titleTrailing={
                <span className="text-label-sm text-tertiary tabular-nums" title={absoluteTime(item.since, i18n.language)}>
                  {relativeTime(item.since, now, i18n.language)}
                </span>
              }
              subtitle={
                <SubtitleWithChips text={inboxItemStepTitle(item, t)}>
                  <EntityListBadge colorClass="bg-fill-hover text-secondary">{inboxKindLabel(item.kind, t)}</EntityListBadge>
                </SubtitleWithChips>
              }
              dataAttributes={{ 'data-inbox-kind': item.kind }}
            />
          )
        })}
      </div>
    </ScrollArea>
  )
}

export function InboxListPanel({ selectedId, onSelect }: { selectedId?: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  const items = useAtomValue(memwiseInboxAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const filter = useDomainFilter(useInboxDomains(items))
  const setQueue = useSetAtom(memwiseReviewQueueAtom)
  const shown = React.useMemo(() => (items && filter.value ? items.filter(i => filter.matches(inboxItemDomain(i, playbooks))) : items), [items, filter, playbooks])
  // Phase 6: "Review in a row" opens the first document review, then the next of the same kind after each decision
  const first = shown ? firstDocumentReview(shown) : undefined
  const reviews = first ? (shown ?? []).filter(i => (i.kind === 'input' || i.kind === 'decision') && i.review?.kind === 'document').length : 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MemwiseStatusBanner className="mx-3 mt-1 mb-2" />
      <DomainFilterRow filter={filter} />
      {first && (
        <div className="px-3 pb-2">
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => { setQueue({ active: true, workflowId: first.workflowId, stepTitle: first.stepTitle }); onSelect(first.id) }}
            data-action="review-in-a-row"
          >
            <ClipboardCheck />
            {t('memwise.review.inARow', { count: reviews })}
          </Button>
        </div>
      )}
      <InboxList items={shown} selectedId={selectedId} onSelect={id => { setQueue(q => (q.active ? { active: false } : q)); onSelect(id) }} />
    </div>
  )
}

// ---------------------------------------------------------------- cases

export interface CasesListProps {
  cases: MwCaseSummary[] | null
  playbooks?: MwPlaybookSummary[] | null
  roles?: MwRole[]
  selectedId?: string | null
  onSelect: (caseId: string) => void
  onStartCase?: () => void
  now?: number
  className?: string
}

const STATUS_BADGE: Record<MwRunStatus, string> = {
  active: 'bg-fill-hover text-secondary',
  done: 'bg-success-tint text-success',
  stopped: 'bg-destructive-tint text-destructive',
}

export function CasesList({ cases, playbooks, roles, selectedId, onSelect, onStartCase, now: fixedNow, className }: CasesListProps) {
  const { t, i18n } = useTranslation()
  const now = useNow(fixedNow)
  if (cases === null) return <ListSkeleton />
  if (cases.length === 0) {
    return (
      <EntityListEmptyScreen
        icon={<Briefcase />}
        title={t('memwise.cases.emptyTitle')}
        description={t('memwise.cases.emptyDescription')}
        className={cn('flex-1', className)}
      >
        {onStartCase && (
          <Button variant="secondary" onClick={onStartCase}>
            <Play />
            {t('memwise.cases.startCase')}
          </Button>
        )}
      </EntityListEmptyScreen>
    )
  }
  const titleOf = (id: string) => playbooks?.find(p => p.id === id)?.title ?? id
  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="pt-1 pb-2" data-list-role="memwise-cases">
        {cases.map(c => {
          const waiting = waitingOnLabel(c, t, roles)
          return (
            <EntityRow
              key={c.caseId}
              isSelected={selectedId === c.caseId}
              onClick={() => onSelect(c.caseId)}
              icon={<Briefcase className="h-3.5 w-3.5 text-foreground/60" />}
              title={c.title}
              titleTrailing={
                <span className="text-label-sm text-tertiary tabular-nums" title={absoluteTime(c.updatedAt, i18n.language)}>
                  {relativeTime(c.updatedAt, now, i18n.language)}
                </span>
              }
              subtitle={`${titleOf(c.workflowId)} · ${stateLabel(c.state, t, c.stateTitle)}`}
              badges={
                <div className="flex min-w-0 items-center gap-1.5">
                  <EntityListBadge colorClass={STATUS_BADGE[c.status]}>{caseStatusLabel(c.status, t)}</EntityListBadge>
                  {waiting && <span className="truncate text-label-sm text-tertiary">{waiting}</span>}
                </div>
              }
              dataAttributes={{ 'data-case-status': c.status }}
            />
          )
        })}
      </div>
    </ScrollArea>
  )
}

const ALL = '__all__'

export function CasesListPanel({ selectedId, onSelect }: { selectedId?: string | null; onSelect: (caseId: string) => void }) {
  const { t } = useTranslation()
  const cases = useAtomValue(memwiseCasesAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const roles = useAtomValue(memwiseRolesAtom)
  const [filter, setFilter] = useAtom(memwiseCaseFilterAtom)
  const setStartCase = useSetAtom(memwiseStartCaseDialogAtom)
  const domainFilter = useDomainFilter(React.useMemo(() => (cases ?? []).map(c => c.domain), [cases]))
  const filtered = React.useMemo(() => (cases ? filterCases(cases, filter).filter(c => domainFilter.matches(c.domain)) : null), [cases, filter, domainFilter])
  const filtering = !!(filter.workflowId || filter.status || domainFilter.value)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MemwiseStatusBanner className="mx-3 mt-1 mb-2" />
      <DomainFilterRow filter={domainFilter} />
      <div className="flex gap-2 px-3 pb-2">
        <Select value={filter.workflowId ?? ALL} onValueChange={v => setFilter(f => ({ ...f, workflowId: v === ALL ? undefined : v }))}>
          <SelectTrigger className="h-control text-label-sm" aria-label={t('memwise.cases.filterPlaybook')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('memwise.cases.allPlaybooks')}</SelectItem>
            {(playbooks ?? []).map(p => <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filter.status ?? ALL} onValueChange={v => setFilter(f => ({ ...f, status: v === ALL ? undefined : (v as MwRunStatus) }))}>
          <SelectTrigger className="h-control w-36 shrink-0 text-label-sm" aria-label={t('memwise.cases.filterStatus')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('memwise.cases.allStatuses')}</SelectItem>
            {(['active', 'done', 'stopped'] as const).map(s => <SelectItem key={s} value={s}>{caseStatusLabel(s, t)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {filtering && filtered && filtered.length === 0 && cases && cases.length > 0 ? (
        <p className="px-4 py-6 text-center text-label text-tertiary">{t('memwise.cases.noneMatch')}</p>
      ) : (
        <CasesList
          cases={filtered}
          playbooks={playbooks}
          roles={roles}
          selectedId={selectedId}
          onSelect={onSelect}
          onStartCase={() => setStartCase({ open: true, workflowId: filter.workflowId })}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- playbooks

const STAGE_BADGE: Record<ReturnType<typeof stageTone>, string> = {
  default: 'bg-fill-hover text-secondary',
  success: 'bg-success-tint text-success',
  warning: 'bg-info-tint text-info',
  destructive: 'bg-destructive-tint text-destructive',
  muted: 'bg-fill-hover text-tertiary',
}

function GroupHeader({ children }: { children: React.ReactNode }) {
  return <div className="px-4 pt-3 pb-1 text-label-sm font-semibold text-tertiary">{children}</div>
}

/**
 * Playbooks, with the drafts in progress above them and the playbooks that build and change
 * playbooks (create-playbook, change-playbook) in their own quieter group below.
 */
export function PlaybooksList({ playbooks, drafts, selectedId, selectedDraftId, onSelect, onSelectDraft, now: fixedNow, className }: {
  playbooks: MwPlaybookSummary[] | null
  drafts?: MwDraftSummary[] | null
  selectedId?: string | null
  selectedDraftId?: string | null
  onSelect: (id: string) => void
  onSelectDraft?: (draftId: string) => void
  now?: number
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const now = useNow(fixedNow)
  if (playbooks === null) return <ListSkeleton />
  // A binding draft belongs to its plugin's page, not here
  const openDrafts = onSelectDraft ? sortDrafts((drafts ?? []).filter(d => isOpenDraft(d) && d.kind !== 'binding')) : []
  if (playbooks.length === 0 && openDrafts.length === 0) {
    return (
      <EntityListEmptyScreen
        icon={<BookOpen />}
        title={t('memwise.playbooks.emptyTitle')}
        description={t('memwise.playbooks.emptyDescription')}
        className={cn('flex-1', className)}
      />
    )
  }
  // The playbooks that build things (playbooks, plugin bindings) sit in their own quieter group
  const building = (id: string) => isMetaPlaybook(id) || id === 'bind-plugin'
  const regular = playbooks.filter(p => !building(p.id))
  const meta = playbooks.filter(p => building(p.id))
  const row = (p: MwPlaybookSummary, quiet: boolean) => (
    <EntityRow
      key={p.id}
      isSelected={selectedId === p.id}
      onClick={() => onSelect(p.id)}
      icon={quiet ? <Wrench className="h-3.5 w-3.5 text-foreground/40" /> : <BookOpen className="h-3.5 w-3.5 text-foreground/60" />}
      title={p.title}
      subtitle={[
        t('memwise.playbooks.steps', { count: p.stepCount }),
        t('memwise.playbooks.openCases', { count: p.open }),
        ...(p.origin ? [originLabel(p.origin, t)] : []),
      ].join(' · ')}
      titleTrailing={p.waitingOnMe > 0 ? (
        <EntityListBadge colorClass="bg-info-tint text-info" tooltip={t('memwise.playbooks.waitingOnMeTooltip')}>
          {t('memwise.playbooks.waitingOnMe', { count: p.waitingOnMe })}
        </EntityListBadge>
      ) : undefined}
      dataAttributes={{ 'data-playbook': p.id, ...(quiet ? { 'data-meta-playbook': 'true' } : {}) }}
    />
  )
  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="pt-1 pb-2" data-list-role="memwise-playbooks">
        {openDrafts.length > 0 && (
          <div data-list-group="drafts">
            <GroupHeader>{t('memwise.playbooks.draftsGroup')}</GroupHeader>
            {openDrafts.map(d => (
              <EntityRow
                key={d.id}
                isSelected={selectedDraftId === d.id}
                onClick={() => onSelectDraft!(d.id)}
                icon={<FilePen className="h-3.5 w-3.5 text-foreground/60" />}
                title={d.title}
                titleTrailing={
                  <span className="text-label-sm text-tertiary tabular-nums" title={absoluteTime(d.updatedAt, i18n.language)}>
                    {relativeTime(d.updatedAt, now, i18n.language)}
                  </span>
                }
                subtitle={
                  <SubtitleWithChips text={d.kind === 'create' ? t('memwise.draft.newPlaybook') : d.playbookTitle}>
                    {d.pendingEdits > 0 && <Sparkles className="h-3 w-3 text-accent" aria-label={t('memwise.draft.pendingCount', { count: d.pendingEdits })} />}
                    <EntityListBadge colorClass={STAGE_BADGE[stageTone(d.stage)]}>{stageLabel(d.stage, t)}</EntityListBadge>
                  </SubtitleWithChips>
                }
                dataAttributes={{ 'data-draft': d.id, 'data-draft-stage': d.stage }}
              />
            ))}
          </div>
        )}
        {regular.length > 0 && (
          <div data-list-group="playbooks">
            {(openDrafts.length > 0 || meta.length > 0) && <GroupHeader>{t('memwise.nav.playbooks')}</GroupHeader>}
            {regular.map(p => row(p, false))}
          </div>
        )}
        {meta.length > 0 && (
          <div data-list-group="building" className="opacity-80">
            <GroupHeader>{t('memwise.playbooks.buildingGroup')}</GroupHeader>
            {meta.map(p => row(p, true))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

export function PlaybooksListPanel({ selectedId, selectedDraftId, onSelect, onSelectDraft }: {
  selectedId?: string | null
  selectedDraftId?: string | null
  onSelect: (id: string) => void
  onSelectDraft?: (draftId: string) => void
}) {
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const drafts = useAtomValue(memwiseDraftsAtom)
  // Phase 6: the domain filter (the playbooks that build playbooks belong to no one domain and always show)
  const domainFilter = useDomainFilter(React.useMemo(() => (playbooks ?? []).filter(p => !isMetaPlaybook(p.id)).map(p => p.domain), [playbooks]))
  const shown = React.useMemo(() => (playbooks && domainFilter.value ? playbooks.filter(p => isMetaPlaybook(p.id) || p.id === 'bind-plugin' || domainFilter.matches(p.domain)) : playbooks), [playbooks, domainFilter])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MemwiseStatusBanner className="mx-3 mt-1 mb-2" />
      <DomainFilterRow filter={domainFilter} />
      <PlaybooksList
        playbooks={shown}
        drafts={drafts}
        selectedId={selectedId}
        selectedDraftId={selectedDraftId}
        onSelect={onSelect}
        onSelectDraft={onSelectDraft}
      />
    </div>
  )
}
