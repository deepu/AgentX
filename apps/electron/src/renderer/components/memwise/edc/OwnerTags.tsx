/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9, XSite): pieces for a record shared across
 * apps. Each fact carries a tag naming the app that owns it; a fact another app owns is read only
 * here, with a button that opens the record there ("Open in eTMF", "Open in EDC"). Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight } from 'lucide-react'
import type { MwLinkedRecord, MwRecordPage } from '@memwise/shared/protocol'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FieldValue } from '../records/RecordBlocks'
import { factsByApp, otherApps, ownerTone, type OwnerApp } from './edc-model'

/** The app that owns a fact: "EDC", "eTMF". */
export function OwnerTag({ app, className }: { app: OwnerApp; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-label-sm font-medium', ownerTone(app.domain), className)}
      title={t('memwise.edc.owner.title', { app: app.name })}
      data-owner={app.domain}
    >
      {app.name}
    </span>
  )
}

/** "Open in eTMF": the same record in the app that owns the fact. */
export function OpenInAppButton({ app, onOpen, size = 'sm', variant = 'secondary' }: {
  app: OwnerApp
  onOpen: () => void
  size?: 'sm' | 'default'
  variant?: 'secondary' | 'ghost'
}) {
  const { t } = useTranslation()
  return (
    <Button variant={variant} size={size} onClick={onOpen} data-open-in={app.domain}>
      {t('memwise.edc.owner.openIn', { app: app.name })}
      <ArrowUpRight />
    </Button>
  )
}

export interface RecordFactsByAppViewProps {
  page: Pick<MwRecordPage, 'domain' | 'domainName' | 'entity' | 'id' | 'fields'>
  linked: MwLinkedRecord[]
  onOpenRecord: (entity: string, id: string) => void
}

/**
 * "One record, each fact owned by one app": the record's facts and those the same record holds in
 * the other apps, each with its owner's tag. Only facts this app owns can be changed here.
 */
export function RecordFactsByAppView({ page, linked, onOpenRecord }: RecordFactsByAppViewProps) {
  const { t } = useTranslation()
  const facts = factsByApp(page, linked)
  const others = otherApps(page, linked)
  if (!others.length) return null
  return (
    <Info_Section
      title={t('memwise.edc.owner.sectionTitle')}
      description={t('memwise.edc.owner.sectionHint')}
      actions={
        <div className="flex flex-wrap gap-2">
          {others.map(o => <OpenInAppButton key={o.domain} app={o} onOpen={() => onOpenRecord(o.entity, o.id)} />)}
        </div>
      }
    >
      <div className="overflow-x-auto" data-owned-facts>
        <table className="w-full text-label">
          <thead>
            <tr className="border-b border-separator text-left text-label-sm text-tertiary">
              <th className="px-3.5 py-2 font-medium">{t('memwise.edc.owner.fact')}</th>
              <th className="px-3.5 py-2 font-medium">{t('memwise.edc.owner.now')}</th>
              <th className="px-3.5 py-2 text-right font-medium">{t('memwise.edc.owner.ownedBy')}</th>
            </tr>
          </thead>
          <tbody>
            {facts.map(f => (
              <tr key={`${f.owner.domain}:${f.name}`} className="border-b border-separator last:border-0" data-fact={f.name} data-fact-owner={f.owner.domain} data-elsewhere={f.elsewhere || undefined}>
                <td className="px-3.5 py-2 text-secondary">{f.label}</td>
                <td className="px-3.5 py-2 text-foreground"><FieldValue field={f} onOpenRecord={onOpenRecord} /></td>
                <td className="px-3.5 py-2 text-right">
                  {f.elsewhere && f.open
                    ? (
                      <button type="button" className="inline-flex items-center gap-1 rounded-full hover:opacity-80" onClick={() => onOpenRecord(f.open!.entity, f.open!.id)} title={t('memwise.edc.owner.openIn', { app: f.owner.name })}>
                        <OwnerTag app={f.owner} />
                      </button>
                    )
                    : <OwnerTag app={f.owner} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-separator px-3.5 py-2 text-label-sm text-tertiary">{t('memwise.edc.owner.note')}</p>
    </Info_Section>
  )
}
