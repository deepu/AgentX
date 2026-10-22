/**
 * A domain's own page (its sidebar entry), and the cross-domain Pages overview.
 *
 * DomainView: what the domain is, whether it is regulated and how long records are kept, its
 * entities, playbooks and pages, the house rules (with the workspace's above them), which
 * domains it takes records from, and its intake address. PagesOverview: every domain's
 * dashboards and pages, with a domain filter, then the workspace's own pages. Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Boxes, Clock, Inbox, LayoutDashboard, Link2, PanelsTopLeft, Scale, ShieldCheck } from 'lucide-react'
import type { MwDomain, MwPlaybookSummary } from '@memwise/shared/protocol'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { cn } from '@/lib/utils'
import { entityTitle, retentionLabel } from '../records/record-model'

export interface DomainViewProps {
  domain: MwDomain
  playbooks?: MwPlaybookSummary[] | null
  /** Open on the house rules. */
  tab?: 'rules'
  onOpenEntities?: (entity?: string) => void
  onOpenPlaybook?: (workflowId: string) => void
  onOpenPage?: (pageId: string) => void
  onOpenAutomations?: () => void
  /** Stage 5: a regulated domain's change requests, audit trail, inspector access and TMF index. */
  regulated?: React.ReactNode
}

export function DomainView({ domain, playbooks, tab, onOpenEntities, onOpenPlaybook, onOpenPage, onOpenAutomations, regulated }: DomainViewProps) {
  const { t } = useTranslation()
  const rulesRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (tab === 'rules') rulesRef.current?.scrollIntoView?.({ block: 'start' })
  }, [tab, domain.id])
  const mine = (playbooks ?? []).filter(p => domain.workflows.includes(p.id) || p.domain === domain.id)
  const detail = domain.detail
  const retention = retentionLabel(domain.retentionDays, t)
  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><Boxes className="size-4" /></div>}
        title={domain.name}
        tagline={domain.description}
        meta={
          <>
            {domain.regulated && <Info_Badge color="muted" icon={<ShieldCheck className="size-3" />} data-regulated>{t('memwise.domains.regulated')}</Info_Badge>}
            {retention && <span>{retention}</span>}
            {domain.flags > 0 && <Info_Badge color="destructive">{t('memwise.domains.flags', { count: domain.flags })}</Info_Badge>}
          </>
        }
        actions={onOpenAutomations ? <Button variant="ghost" size="sm" onClick={onOpenAutomations}><Clock />{t('memwise.nav.automations')}</Button> : undefined}
      />
      {domain.regulated && (
        <p className="rounded-md bg-fill-hover/60 px-3.5 py-2.5 text-label-sm text-secondary" data-regulated-note>{t('memwise.domains.regulatedNote')}</p>
      )}
      {domain.regulated && regulated}

      <Info_Section title={t('memwise.entities.title')} count={domain.entities.length} actions={onOpenEntities ? <Button size="sm" variant="ghost" onClick={() => onOpenEntities()}>{t('memwise.domains.openEntities')}</Button> : undefined}>
        <div className="flex flex-wrap gap-1.5 p-3">
          {domain.entities.map(e => (
            <Button key={e.key} size="sm" variant="ghost" onClick={() => onOpenEntities?.(e.key)} disabled={!onOpenEntities}>
              {e.title}<span className="tabular-nums text-tertiary">{e.count}</span>
            </Button>
          ))}
        </div>
      </Info_Section>

      {mine.length > 0 && (
        <Info_Section title={t('memwise.nav.playbooks')} count={mine.length}>
          <ul className="divide-y divide-separator">
            {mine.map(p => (
              <li key={p.id}>
                <button type="button" className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-label hover:bg-fill-hover" onClick={() => onOpenPlaybook?.(p.id)}>
                  <BookOpen className="size-3.5 text-tertiary" />
                  <span className="flex-1 font-medium text-foreground">{p.title}</span>
                  <span className="text-label-sm text-tertiary">{t('memwise.domains.openCases', { count: p.open })}</span>
                </button>
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      {domain.pages.length > 0 && (
        <Info_Section title={t('memwise.domains.pages')} count={domain.pages.length}>
          <ul className="divide-y divide-separator">
            {domain.pages.map(p => (
              <li key={p.id}>
                <button type="button" className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-label hover:bg-fill-hover disabled:hover:bg-transparent" onClick={() => onOpenPage?.(p.id)} disabled={!!p.under || !onOpenPage}>
                  <LayoutDashboard className="size-3.5 text-tertiary" />
                  <span className="flex-1 font-medium text-foreground">{p.title}</span>
                  {p.under && <span className="text-label-sm text-tertiary">{t('memwise.domains.onEach', { entity: entityTitle(domain.entities, p.under.entity) })}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      <div ref={rulesRef} className="space-y-6" data-house-rules>
        <Info_Section title={t('memwise.domains.houseRules')} description={t('memwise.domains.houseRulesHint')}>
          {detail && detail.houseRules.length > 0 ? (
            <PolicyRows lines={detail.houseRules} />
          ) : (
            <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.domains.noHouseRules')}</p>
          )}
        </Info_Section>
        {detail && detail.workspaceRules.length > 0 && (
          <Info_Section title={t('memwise.domains.workspaceRules')} description={t('memwise.domains.workspaceRulesHint')}>
            <PolicyRows lines={detail.workspaceRules} />
          </Info_Section>
        )}
        {detail && (detail.acceptsFrom.length > 0 || detail.intake) && (
          <Info_Section title={t('memwise.domains.handOffs')}>
            <dl className="divide-y divide-separator text-label">
              {detail.acceptsFrom.length > 0 && (
                <div className="flex items-center gap-2 px-3.5 py-2"><Link2 className="size-3.5 text-tertiary" /><dt className="text-secondary">{t('memwise.domains.acceptsFrom')}</dt><dd className="font-medium text-foreground">{detail.acceptsFrom.join(', ')}</dd></div>
              )}
              {detail.intake && (
                <div className="flex items-center gap-2 px-3.5 py-2"><Inbox className="size-3.5 text-tertiary" /><dt className="text-secondary">{t('memwise.domains.intake')}</dt><dd className="font-mono text-label-sm text-foreground">{detail.intake}</dd></div>
              )}
            </dl>
          </Info_Section>
        )}
      </div>
    </Info_Page.Content>
  )
}

function PolicyRows({ lines }: { lines: { subject: string; value: string }[] }) {
  return (
    <ul className="divide-y divide-separator">
      {lines.map((l, i) => (
        <li key={i} className="flex items-start gap-2 px-3.5 py-2 text-label">
          <Scale className="mt-0.5 size-3.5 shrink-0 text-tertiary" />
          <span className="font-medium text-foreground">{l.subject}</span>
          <span className="text-secondary">{l.value}</span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- pages overview

export interface PagesOverviewProps {
  domains: MwDomain[]
  /** The workspace's own pages (the Pages library). */
  workspacePages?: { slug: string; name: string }[]
  domainFilter?: string | null
  onDomainFilter?: (domain: string | null) => void
  onOpenDomainPage?: (domain: string, pageId: string) => void
  /** A page that sits on each record of a type: open where its records are. */
  onOpenEntities?: (domain: string, entity: string) => void
  onOpenWorkspacePage?: (slug: string) => void
  onOpenLibrary?: () => void
}

export function PagesOverview({ domains, workspacePages = [], domainFilter, onDomainFilter, onOpenDomainPage, onOpenEntities, onOpenWorkspacePage, onOpenLibrary }: PagesOverviewProps) {
  const { t } = useTranslation()
  const withPages = domains.filter(d => d.pages.length > 0)
  const shown = domainFilter ? withPages.filter(d => d.id === domainFilter) : withPages
  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><PanelsTopLeft className="size-4" /></div>}
        title={t('memwise.domains.pagesTitle')}
        tagline={t('memwise.domains.pagesDescription')}
      />
      {withPages.length > 1 && onDomainFilter && (
        <DomainFilterChips domains={withPages} value={domainFilter ?? null} onChange={onDomainFilter} />
      )}
      {shown.map(d => (
        <Info_Section key={d.id} title={d.name} count={d.pages.length}>
          <ul className="divide-y divide-separator" data-domain-pages={d.id}>
            {d.pages.map(p => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-label hover:bg-fill-hover"
                  onClick={() => (p.under ? onOpenEntities?.(d.id, p.under.entity) : onOpenDomainPage?.(d.id, p.id))}
                >
                  <LayoutDashboard className="size-3.5 text-tertiary" />
                  <span className="flex-1 font-medium text-foreground">{p.title}</span>
                  {p.under && <span className="text-label-sm text-tertiary">{t('memwise.domains.onEach', { entity: entityTitle(d.entities, p.under.entity) })}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Info_Section>
      ))}
      {(workspacePages.length > 0 || onOpenLibrary) && !domainFilter && (
        <Info_Section
          title={t('memwise.domains.workspacePages')}
          count={workspacePages.length}
          actions={onOpenLibrary ? <Button size="sm" variant="ghost" onClick={onOpenLibrary}>{t('memwise.domains.openLibrary')}</Button> : undefined}
        >
          {workspacePages.length === 0 ? (
            <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.domains.noWorkspacePages')}</p>
          ) : (
            <ul className="divide-y divide-separator">
              {workspacePages.map(p => (
                <li key={p.slug}>
                  <button type="button" className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-label hover:bg-fill-hover" onClick={() => onOpenWorkspacePage?.(p.slug)}>
                    <PanelsTopLeft className="size-3.5 text-tertiary" />
                    <span className="font-medium text-foreground">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Info_Section>
      )}
      {withPages.length === 0 && workspacePages.length === 0 && !onOpenLibrary && (
        <EntityListEmptyScreen icon={<PanelsTopLeft />} title={t('memwise.domains.noPagesTitle')} description={t('memwise.domains.noPagesDescription')} />
      )}
    </Info_Page.Content>
  )
}

/** "All domains" and one chip per domain: the filter on cross-domain lists. */
export function DomainFilterChips({ domains, value, onChange, className }: { domains: Pick<MwDomain, 'id' | 'name'>[]; value: string | null; onChange: (domain: string | null) => void; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-wrap gap-1', className)} role="group" aria-label={t('memwise.domains.filter')} data-domain-filter={value ?? ''}>
      <Button size="sm" variant={value === null ? 'secondary' : 'ghost'} onClick={() => onChange(null)} aria-pressed={value === null}>{t('memwise.domains.allDomains')}</Button>
      {domains.map(d => (
        <Button key={d.id} size="sm" variant={value === d.id ? 'secondary' : 'ghost'} onClick={() => onChange(d.id)} aria-pressed={value === d.id}>{d.name}</Button>
      ))}
    </div>
  )
}
