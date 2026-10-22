/**
 * A regulated domain's (a project's, for now) way into the Stage 5 screens, on its own page: its
 * change requests, the audit trail, inspector access and, when it keeps a TMF, the TMF index.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileCheck2, FolderTree, History, UserRoundCheck } from 'lucide-react'
import type { MwChangeRequestSummary, MwDomain } from '@memwise/shared/protocol'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { useMemwiseChangeRequests } from '@/hooks/useMemwiseRegulated'
import { changeStatusColor, changeStatusLabel } from './regulated-model'
import { defaultRegulatedNavigation, type RegulatedNavigation } from './screens'

/** Whether the domain keeps a TMF: documents and the documents expected of it. */
export function keepsTmf(domain: Pick<MwDomain, 'entities'>): boolean {
  const names = new Set(domain.entities.map(e => (e.entity.split('.').pop() ?? e.entity)))
  return names.has('Document') && names.has('ExpectedDocument')
}

export function RegulatedDomainLinksView({ domain, changeRequests, navigation }: {
  domain: MwDomain
  changeRequests: MwChangeRequestSummary[]
  navigation?: RegulatedNavigation
}) {
  const { t } = useTranslation()
  const go = { ...defaultRegulatedNavigation, ...navigation }
  const row = (icon: React.ReactNode, label: string, onClick: () => void, key: string, extra?: React.ReactNode) => (
    <li key={key}>
      <button type="button" className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-label hover:bg-fill-hover" onClick={onClick} data-open={key}>
        <span className="text-tertiary [&_svg]:size-3.5">{icon}</span>
        <span className="flex-1 font-medium text-foreground">{label}</span>
        {extra}
        <ChevronRight className="size-3.5 text-tertiary" />
      </button>
    </li>
  )
  const live = changeRequests.filter(c => c.status === 'open' || c.status === 'in_review')
  return (
    <div className="space-y-6" data-regulated-links>
      <Info_Section title={t('memwise.regulated.domain.title')}>
        <ul className="divide-y divide-separator">
          {keepsTmf(domain) && row(<FolderTree />, t('memwise.regulated.tmf.title'), () => go.openTmfZone(domain.id, null), 'tmf')}
          {row(<History />, t('memwise.regulated.audit.title'), () => go.openAuditTrail(domain.id), 'audit')}
          {row(<UserRoundCheck />, t('memwise.regulated.inspectors.title'), () => go.openInspectors(domain.id), 'inspectors')}
        </ul>
      </Info_Section>
      <Info_Section title={t('memwise.regulated.domain.changeRequests')} count={live.length} description={t('memwise.regulated.domain.changeRequestsHint')}>
        {changeRequests.length === 0 ? (
          <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.regulated.domain.noChangeRequests')}</p>
        ) : (
          <ul className="divide-y divide-separator">
            {changeRequests.slice(0, 12).map(c => row(
              <FileCheck2 />,
              `${c.label} · ${c.title}`,
              () => go.openChangeRequest(domain.id, c.label),
              c.id,
              <>
                <span className="text-label-sm text-tertiary">{c.playbookTitle}</span>
                <Info_Badge color={changeStatusColor(c.status)}>{changeStatusLabel(c.status, t)}</Info_Badge>
              </>,
            ))}
          </ul>
        )}
      </Info_Section>
    </div>
  )
}

export function RegulatedDomainLinks({ domain, navigation }: { domain: MwDomain; navigation?: RegulatedNavigation }) {
  const { data } = useMemwiseChangeRequests(domain.regulated ? domain.id : null)
  if (!domain.regulated) return null
  return <RegulatedDomainLinksView domain={domain} changeRequests={data ?? []} {...(navigation ? { navigation } : {})} />
}
