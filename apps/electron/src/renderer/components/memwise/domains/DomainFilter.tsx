/**
 * The domain filter on the cross-domain lists (inbox, cases, playbooks; 24 §14). It shows only
 * when the list holds items from more than one domain, so a one-domain project never sees it.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue } from 'jotai'
import type { MwInboxItem, MwPlaybookSummary } from '@memwise/shared/protocol'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { memwiseDomainFilterAtom, memwiseDomainsAtom, memwisePlaybooksAtom } from '@/atoms/memwise'
import { DEFAULT_DOMAIN, needsDomainFilter } from './DomainsSidebar'

/** An inbox item's domain: its own, else its playbook's. */
export function inboxItemDomain(item: MwInboxItem, playbooks?: MwPlaybookSummary[] | null): string | undefined {
  if ('domain' in item && typeof item.domain === 'string') return item.domain
  const wf = 'workflowId' in item ? item.workflowId : undefined
  return wf ? playbooks?.find(p => p.id === wf)?.domain : undefined
}

export interface DomainFilterState {
  /** The filter is shown (the list spans several domains). */
  shown: boolean
  value: string | null
  matches: (domain: string | undefined) => boolean
}

/** The filter for a list whose items are in these domains. */
export function useDomainFilter(itemDomains: (string | undefined)[]): DomainFilterState {
  const domains = useAtomValue(memwiseDomainsAtom)
  const value = useAtomValue(memwiseDomainFilterAtom)
  const shown = needsDomainFilter(domains, itemDomains)
  // A filter left set from a domain's sidebar entry still applies when the list shows one domain.
  const active = value && (domains ?? []).some(d => d.id === value) ? value : null
  return {
    shown: shown || !!active,
    value: active,
    matches: d => !active || (d ?? DEFAULT_DOMAIN) === active,
  }
}

export function DomainSelect({ className }: { className?: string }) {
  const { t } = useTranslation()
  const domains = useAtomValue(memwiseDomainsAtom)
  const [value, setValue] = useAtom(memwiseDomainFilterAtom)
  const ALL = '__all__'
  return (
    <Select value={value ?? ALL} onValueChange={v => setValue(v === ALL ? null : v)}>
      <SelectTrigger className={className ?? 'h-control text-label-sm'} aria-label={t('memwise.domains.filter')} data-domain-select={value ?? ''}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('memwise.domains.allDomains')}</SelectItem>
        {(domains ?? []).map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** One row with the domain select, for a list panel. */
export function DomainFilterRow({ filter }: { filter: DomainFilterState }) {
  if (!filter.shown) return null
  return <div className="px-3 pb-2"><DomainSelect /></div>
}

export function useInboxDomains(items: MwInboxItem[] | null): (string | undefined)[] {
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  return React.useMemo(() => (items ?? []).map(i => inboxItemDomain(i, playbooks)), [items, playbooks])
}
