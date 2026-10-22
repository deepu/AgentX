/**
 * Waiting for you, all projects (26 §3, mock XWaitingAll): one group per project ("eTMF · Study
 * MW-301 3"), its first rows with Open, then "N more in MW-301" which shows the rest. A project's
 * template update sits in its group with Review. Presentational; WaitingAllScreen fetches the
 * groups (memwise:waiting:all).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwInboxItem, MwTemplateUpdateItem, MwWaitingGroup } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { Button } from '@/components/ui/button'
import { absoluteDate } from '../format'
import { GROUP_SHOWN, groupCount, groupRows, itemDue, itemTitle, sortGroups } from './project-model'

export interface WaitingAllViewProps {
  groups: MwWaitingGroup[]
  /** A playbook's title by id ("From Review a visit report"). */
  playbookTitle?: (workflowId: string) => string | undefined
  onOpenProject?: (projectId: string) => void
  onOpenItem?: (item: MwInboxItem) => void
  onReviewUpdate?: (update: MwTemplateUpdateItem) => void
}

export function WaitingAllView({ groups, playbookTitle, onOpenProject, onOpenItem, onReviewUpdate }: WaitingAllViewProps) {
  const { t } = useTranslation()
  const shown = sortGroups(groups)
  const total = shown.reduce((n, g) => n + groupCount(g), 0)
  const apps = new Set(shown.map((g) => g.app)).size
  return (
    <Info_Page.Content>
      <div className="space-y-6" data-waiting-all>
        <div className="space-y-1">
          <div className="text-label-sm text-tertiary" data-breadcrumbs>
            {t('memwise.projects.waiting.allProjects')} › {t('memwise.projects.waiting.title')}
          </div>
          <h2 className="text-title text-foreground">{t('memwise.projects.waiting.title')}</h2>
          <p className="text-label-sm text-secondary" data-waiting-total={total}>
            {total === 0 ? t('memwise.projects.waiting.nothing') : t('memwise.projects.waiting.summary', { count: total, apps })}
          </p>
        </div>
        {shown.map((g) => (
          <WaitingGroup
            key={g.project || '-'}
            group={g}
            playbookTitle={playbookTitle}
            onOpenProject={onOpenProject}
            onOpenItem={onOpenItem}
            onReviewUpdate={onReviewUpdate}
          />
        ))}
      </div>
    </Info_Page.Content>
  )
}

function WaitingGroup({ group, playbookTitle, onOpenProject, onOpenItem, onReviewUpdate }: { group: MwWaitingGroup } & Omit<WaitingAllViewProps, 'groups'>) {
  const { t, i18n } = useTranslation()
  const [all, setAll] = React.useState(false)
  const rows = groupRows(group)
  const visible = all ? rows : rows.slice(0, GROUP_SHOWN)
  const more = rows.length - visible.length
  const heading = group.project ? `${group.appTitle} · ${group.projectName}` : t('memwise.projects.waiting.noProject')
  const short = group.projectName || group.appTitle
  return (
    <section className="space-y-2" data-waiting-group={group.project || '-'}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-fill-hover text-[10px] font-semibold text-secondary">
          {initials(group.appTitle)}
        </span>
        <h3 className="min-w-0 flex-1 text-label font-semibold text-foreground">
          {heading}
          <span className="ml-1.5 font-normal text-tertiary tabular-nums">{groupCount(group)}</span>
        </h3>
        {group.project && onOpenProject && (
          <Button variant="link" size="sm" onClick={() => onOpenProject(group.project)} data-action="open-project">
            {t('memwise.projects.waiting.openProject')}
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((row) => row.kind === 'update' ? (
          <WaitingRow
            key={row.update.id}
            id={row.update.id}
            title={t('memwise.projects.update.itemTitle', { app: row.update.appTitle, version: row.update.to })}
            detail={t('memwise.projects.update.itemDetail', { from: row.update.from, to: row.update.to })}
            action={t('memwise.projects.update.review')}
            onOpen={onReviewUpdate ? () => onReviewUpdate(row.update) : undefined}
          />
        ) : (
          <WaitingRow
            key={row.item.id}
            id={row.item.id}
            {...itemTitle(row.item, t)}
            from={row.item.workflowId ? playbookTitle?.(row.item.workflowId) : undefined}
            due={itemDue(row.item) ? t('memwise.projects.waiting.due', { date: absoluteDate(itemDue(row.item), i18n.language) }) : undefined}
            action={t('memwise.projects.waiting.open')}
            onOpen={onOpenItem ? () => onOpenItem(row.item) : undefined}
          />
        ))}
      </div>
      {more > 0 && (
        <button type="button" className="text-label-sm text-secondary underline underline-offset-2 hover:text-foreground" onClick={() => setAll(true)} data-action="show-more">
          {t('memwise.projects.waiting.more', { count: more, project: short })}
        </button>
      )}
    </section>
  )
}

function WaitingRow({ id, title, detail, from, due, action, onOpen }: {
  id: string
  title: string
  detail?: string
  from?: string
  due?: string
  action: string
  onOpen?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 rounded-lg bg-raised px-4 py-3 shadow-elev-1" data-waiting-item={id}>
      <div className="min-w-0 flex-1">
        <div className="text-label font-semibold text-foreground">{title}</div>
        {detail && <div className="text-label-sm text-secondary">{detail}</div>}
        {from && <div className="text-label-sm text-tertiary">{t('memwise.projects.waiting.from', { playbook: from })}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {due && <span className="text-label-sm font-medium text-destructive">{due}</span>}
        {onOpen && <Button variant="secondary" size="sm" onClick={onOpen} data-action="open-item">{action}</Button>}
      </div>
    </div>
  )
}

/** "eTMF", "EDC", "Literature search" → "LS": the app's mark. */
const initials = (s: string) => {
  const words = s.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean)
  if (words.length === 1 && words[0]!.length <= 4) return words[0]!
  return words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 3) || '·'
}
