/**
 * New project (26 §3, mock NewProject): a name, the study, and where it starts from: one of the
 * app's template cards, a copy of a project ("Start from MW-301", its way of working and never its
 * records), or blank ("Describe it", which opens the app's create-project chat). Making it gives a
 * draft; the draft shows its pages (what it leaves out struck through), playbooks, record types
 * and people, and nothing runs until "Start study". Presentational; NewProjectScreen calls the host.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { PenLine } from 'lucide-react'
import type { MwApp, MwProjectDetail } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { humanize } from '../format'
import { capital, draftLists, peopleLine, type ProjectSource } from './project-model'

export type NewProjectBusy = 'create' | 'describe' | 'start' | 'discard'

export interface NewProjectInput {
  name: string
  study?: string
  template?: string
  copyFrom?: string
}

export interface NewProjectViewProps {
  app: MwApp
  /** The draft once made (or opened); the form until then. */
  draft?: MwProjectDetail | null
  /** A "Describe it" chat is open and its draft has not come back yet. */
  describing?: boolean
  busy?: NewProjectBusy | null
  error?: string | null
  roleTitle?: (roleId: string) => string
  onCreate?: (input: NewProjectInput) => void
  onDescribe?: (request: string) => void
  onDiscard?: () => void
  onStart?: () => void
  onOpenSettings?: () => void
}

export function NewProjectView({ app, draft, describing, busy, error, roleTitle = humanize, onCreate, onDescribe, onDiscard, onStart, onOpenSettings }: NewProjectViewProps) {
  const { t } = useTranslation()
  const copyable = app.projects.filter((p) => !p.implicit && p.status !== 'draft')
  const [name, setName] = React.useState('')
  const [study, setStudy] = React.useState('')
  const [request, setRequest] = React.useState('')
  const [source, setSource] = React.useState<ProjectSource>(() => initialSource(app))
  const [copyFrom, setCopyFrom] = React.useState(copyable[0]?.id ?? '')
  const one = app.nouns.one
  const chosen: ProjectSource = draft ? sourceOf(draft) : source

  const canCreate = !draft && !busy && name.trim().length > 0 && (chosen.kind !== 'copy' || !!copyFrom)
  const submit = () => {
    if (!canCreate || !onCreate) return
    onCreate({
      name: name.trim(),
      ...(study.trim() ? { study: study.trim() } : {}),
      ...(chosen.kind === 'template' ? { template: chosen.id } : {}),
      ...(chosen.kind === 'copy' ? { copyFrom } : {}),
    })
  }

  return (
    <Info_Page.Content>
      <div className="space-y-6" data-new-project={app.id} data-draft={draft?.id}>
        <div className="space-y-1">
          <div className="text-label-sm text-tertiary" data-breadcrumbs>
            {app.title} › {t('memwise.projects.new.title', { one })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-title text-foreground">{draft ? draft.name : capital(t('memwise.projects.new.title', { one }))}</h2>
            {draft && <StatusPill status={draft.status} />}
          </div>
          <p className="text-label-sm text-secondary">{t('memwise.projects.new.intro')}</p>
        </div>

        {!draft && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-label-sm font-medium text-secondary">{t('memwise.projects.new.name')}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('memwise.projects.new.namePlaceholder', { one: capital(one) })} data-field="name" />
            </label>
            <label className="space-y-1">
              <span className="text-label-sm font-medium text-secondary">{capital(one)}</span>
              <Input value={study} onChange={(e) => setStudy(e.target.value)} placeholder={t('memwise.projects.new.studyPlaceholder')} data-field="study" />
            </label>
          </div>
        )}

        <section className="space-y-2">
          <h3 className="text-label font-semibold text-foreground">{t('memwise.projects.new.startFrom')}</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" data-start-from>
            {app.templates.map((tpl) => (
              <SourceCard
                key={tpl.id}
                selected={chosen.kind === 'template' && chosen.id === tpl.id}
                disabled={!!draft}
                title={tpl.title}
                detail={tpl.description}
                data-source={`template:${tpl.id}`}
                onSelect={() => setSource({ kind: 'template', id: tpl.id })}
              />
            ))}
            {copyable.length > 0 && (
              <SourceCard
                selected={chosen.kind === 'copy'}
                disabled={!!draft}
                title={t('memwise.projects.new.copy', { one })}
                detail={t('memwise.projects.new.copyFrom', { project: projectLabel(app, draft && chosen.kind === 'copy' ? chosen.project : copyFrom) })}
                data-source="copy"
                onSelect={() => setSource({ kind: 'copy', project: copyFrom })}
              />
            )}
            <SourceCard
              selected={chosen.kind === 'blank'}
              disabled={!!draft}
              dashed
              title={t('memwise.projects.new.blank')}
              detail={t('memwise.projects.new.describeIt')}
              data-source="blank"
              onSelect={() => setSource({ kind: 'blank' })}
            />
          </div>
          {!draft && chosen.kind === 'copy' && copyable.length > 1 && (
            <select
              className="h-control rounded-md bg-raised px-2 text-label shadow-elev-1"
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value)}
              aria-label={t('memwise.projects.new.copy', { one })}
              data-field="copy-from"
            >
              {copyable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </section>

        {!draft && chosen.kind === 'blank' && (
          <section className="space-y-2" data-describe>
            <p className="text-label-sm text-secondary">{t('memwise.projects.new.describeHint', { one })}</p>
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder={t('memwise.projects.new.describePlaceholder', { one })}
              rows={4}
              data-field="request"
            />
            {describing && <p className="text-label-sm text-tertiary" data-describing>{t('memwise.projects.new.describing')}</p>}
          </section>
        )}

        {draft && <DraftContents draft={draft} roleTitle={roleTitle} />}

        {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}

        <div className="flex flex-wrap items-center gap-2 border-t border-separator pt-4">
          <p className="min-w-0 flex-1 text-label-sm text-secondary">{t('memwise.projects.new.nothingRuns')}</p>
          {draft ? (
            <>
              {onOpenSettings && <Button variant="ghost" onClick={onOpenSettings} data-action="open-settings">{t('memwise.projects.settings.title')}</Button>}
              {draft.canEdit && onDiscard && <Button variant="secondary" onClick={onDiscard} disabled={!!busy} data-action="discard">{t('memwise.projects.new.discard')}</Button>}
              {draft.canEdit && onStart && draft.status === 'draft' && (
                <Button onClick={onStart} disabled={!!busy} data-action="start">{t('memwise.projects.new.start', { one })}</Button>
              )}
            </>
          ) : chosen.kind === 'blank' ? (
            <Button onClick={() => onDescribe?.(request.trim())} disabled={!!busy || !request.trim() || !onDescribe} data-action="describe">
              <PenLine />
              {t('memwise.projects.new.describeInChat')}
            </Button>
          ) : (
            <Button onClick={submit} disabled={!canCreate} data-action="create">{t('memwise.projects.new.makeDraft')}</Button>
          )}
        </div>
      </div>
    </Info_Page.Content>
  )
}

/** Pages, playbooks, records and people of a draft: what starting it would run. */
export function DraftContents({ draft, roleTitle }: { draft: MwProjectDetail; roleTitle: (roleId: string) => string }) {
  const { t } = useTranslation()
  const lists = draftLists(draft)
  return (
    <div className="space-y-5" data-draft-contents>
      <div className="grid gap-5 sm:grid-cols-3">
        <DraftList title={t('memwise.projects.new.pages')} count={lists.pages.length} kept={lists.pages} left={lists.pagesLeftOut} data="pages" />
        <DraftList title={t('memwise.projects.new.playbooks')} count={lists.playbooks.length} kept={lists.playbooks} left={lists.playbooksLeftOut} limit={3} data="playbooks" />
        <DraftList title={t('memwise.projects.new.records')} kept={lists.records} left={[]} data="records" />
      </div>
      {draft.people.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-label font-semibold text-foreground">{t('memwise.projects.settings.people')}</h4>
          <p className="text-label text-secondary" data-people>{peopleLine(draft.people, roleTitle)}</p>
        </div>
      )}
    </div>
  )
}

function DraftList({ title, count, kept, left, limit, data }: { title: string; count?: number; kept: string[]; left: string[]; limit?: number; data: string }) {
  const { t } = useTranslation()
  const shown = limit ? kept.slice(0, limit) : kept
  const more = kept.length - shown.length
  return (
    <div className="space-y-1" data-list={data}>
      <h4 className="text-label font-semibold text-foreground">
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal text-tertiary tabular-nums">{count}</span>}
      </h4>
      <ul className="space-y-0.5 text-label text-secondary">
        {shown.map((x) => <li key={x}>{x}</li>)}
        {left.map((x) => <li key={`-${x}`} className="text-tertiary line-through" data-left-out>{x}</li>)}
        {more > 0 && <li className="text-tertiary">{t('memwise.projects.new.more', { count: more })}</li>}
        {kept.length === 0 && left.length === 0 && <li className="text-tertiary">{t('memwise.projects.new.none')}</li>}
      </ul>
    </div>
  )
}

function SourceCard({ selected, disabled, dashed, title, detail, onSelect, ...rest }: {
  selected: boolean
  disabled?: boolean
  dashed?: boolean
  title: string
  detail?: string
  onSelect: () => void
  'data-source': string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled && !selected}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        'rounded-lg border px-3 py-2.5 text-left transition-colors',
        dashed ? 'border-dashed' : '',
        selected ? 'border-accent ring-1 ring-accent' : 'border-separator hover:bg-fill-hover',
        disabled && !selected && 'opacity-60',
      )}
      data-selected={selected || undefined}
      {...rest}
    >
      <div className="text-label font-semibold text-foreground">{title}</div>
      {detail && <div className="text-label-sm text-secondary">{detail}</div>}
    </button>
  )
}

export function StatusPill({ status }: { status: MwProjectDetail['status'] }) {
  const { t } = useTranslation()
  if (status === 'active') return null
  return (
    <span className="rounded-md bg-fill-hover px-1.5 py-0.5 text-label-sm font-medium text-secondary" data-status={status}>
      {status === 'draft' ? t('memwise.projects.status.draft') : t('memwise.projects.status.archived')}
    </span>
  )
}

/** "MW-301": a project by its study, else its name, else its id. */
function projectLabel(app: MwApp, id: string): string {
  const p = app.projects.find((x) => x.id === id)
  return p?.study ?? p?.name ?? id
}

function initialSource(app: MwApp): ProjectSource {
  const first = app.templates[0]
  return first ? { kind: 'template', id: first.id } : { kind: 'blank' }
}

function sourceOf(p: MwProjectDetail): ProjectSource {
  if (p.from && 'template' in p.from) return { kind: 'template', id: p.from.template }
  if (p.from && 'project' in p.from) return { kind: 'copy', project: p.from.project }
  return { kind: 'blank' }
}
