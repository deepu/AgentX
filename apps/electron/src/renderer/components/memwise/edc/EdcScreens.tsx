/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9): the EDC screens the shell mounts, each
 * reading its data through the MemWise API and refetching on the pushes that concern it.
 *
 * - `EdcHomeScreen({ projectId })`: the EDC study home (XEdcHome).
 * - `AlsoInOtherApps({ projectId })`: the same study in the other apps, for a project's home.
 * - `RecordOwnedFacts({ page })`: on a record page, each fact with the app that owns it and a jump
 *   to the other app (XSite, "Open in eTMF" / "Open in EDC").
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import type { MwEdcHome, MwLinkedRecord, MwRecordPage, MwStudyApps } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { navigate, routes } from '@/lib/navigate'
import { useMemwiseQuery, type MemwiseQuery } from '@/hooks/useMemwise'
import { useNow } from '../use-now'
import { AlsoInOtherAppsView, EdcHomeView } from './EdcHomeView'
import { RecordFactsByAppView } from './OwnerTags'

const openRecord = (entity: string, id: string) => navigate(routes.view.record(entity, id))
const openCase = (caseId: string) => navigate(routes.view.cases(caseId))

// ---------------------------------------------------------------- data

export function useEdcHome(projectId: string | null, domain?: string): MemwiseQuery<MwEdcHome> {
  return useMemwiseQuery<MwEdcHome>(
    projectId ? `edc:home:${projectId}:${domain ?? ''}` : null,
    async (api, ws) => {
      if (typeof api.memwiseGetEdcHome !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetEdcHome(ws, { projectId: projectId!, ...(domain ? { domain } : {}) })
    },
    // Rave's numbers change with a sync (records); what waits changes with the inbox and cases.
    c => c.kind === 'records' || c.kind === 'inbox' || c.kind === 'case' || c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useStudyApps(projectId: string | null, domain?: string): MemwiseQuery<MwStudyApps> {
  return useMemwiseQuery<MwStudyApps>(
    projectId ? `study:apps:${projectId}:${domain ?? ''}` : null,
    async (api, ws) => {
      if (typeof api.memwiseGetStudyApps !== 'function') return { study: { key: projectId! }, apps: [] }
      return api.memwiseGetStudyApps(ws, { projectId: projectId!, ...(domain ? { domain } : {}) })
    },
    c => c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useLinkedRecords(entity: string | null, id: string | null): MemwiseQuery<MwLinkedRecord[]> {
  return useMemwiseQuery<MwLinkedRecord[]>(
    entity && id ? `records:linked:${entity}:${id}` : null,
    async (api, ws) => (typeof api.memwiseGetLinkedRecords === 'function' ? api.memwiseGetLinkedRecords(ws, { entity: entity!, id: id! }) : []),
    c => c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status',
  )
}

// ---------------------------------------------------------------- screens

/** The EDC study home for a project (until projects exist, `projectId` is the study key, "MW-301"). */
export function EdcHomeScreen({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const now = useNow()
  const home = useEdcHome(projectId)
  const apps = useStudyApps(home.data ? projectId : null, home.data?.domain)
  return (
    <Info_Page loading={home.loading && !home.data} error={home.error ?? undefined} empty={home.loaded && !home.data ? t('memwise.edc.home.missing') : undefined}>
      {home.data && <EdcHomeView home={home.data} apps={apps.data} now={now} onOpenRecord={openRecord} onOpenCase={openCase} />}
    </Info_Page>
  )
}

/** "Also in other apps" for a project's home: the same study in each other app. */
export function AlsoInOtherApps({ projectId, domain }: { projectId: string; domain?: string }) {
  const apps = useStudyApps(projectId, domain)
  if (!apps.data) return null
  return <AlsoInOtherAppsView apps={apps.data} onOpenRecord={openRecord} />
}

/** On a record page: each fact with its owner app, and "Open in <app>" for the same record there. */
export function RecordOwnedFacts({ page }: { page: Pick<MwRecordPage, 'domain' | 'domainName' | 'entity' | 'id' | 'fields'> }) {
  const linked = useLinkedRecords(page.entity, page.id)
  return <RecordFactsByAppView page={page} linked={linked.data ?? []} onOpenRecord={openRecord} />
}
