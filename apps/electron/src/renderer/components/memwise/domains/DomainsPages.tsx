/**
 * The content panel for the `domains` navigator (Phase 6): the Pages overview, a record page,
 * a domain's entities, a dashboard, the automations, or a domain's own page. Each reads its data
 * through the Phase 6 hooks and hands it to the presentational views.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import type { MwSaveViewInput } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { navigate, routes } from '@/lib/navigate'
import { pagesAtom } from '@/atoms/pages'
import { memwiseDomainFilterAtom, memwiseDomainsAtom, memwiseWorkspaceIdAtom, memwiseEntityTypesAtom, memwisePlaybooksAtom } from '@/atoms/memwise'
import { getMemwiseApi, waitForSession } from '@/hooks/useMemwise'
import { reconcilePanelStackAtom } from '@/atoms/panel-stack'
import { toast } from 'sonner'
import { useMemwiseDashboard, useMemwiseRecordCalls, useMemwiseRecordQuery, useMemwiseTriggers, useMemwiseViews } from '@/hooks/useMemwiseRecords'
import type { DomainsDetails } from '../../../../shared/domains-route'
import { RecordPage } from '../records/RecordPages'
import { AutomationsView } from '../automations/AutomationsView'
import { DashboardView } from './DashboardView'
import { DomainHome } from './DomainHome'
import { DomainView, PagesOverview } from './DomainView'
import { EntitiesHome, EntityView, stateToQuery, viewToState, type RecordsViewState } from './EntitiesView'
import { NewRecordDialog } from './NewRecordDialog'

const openRecord = (entity: string, id: string) => navigate(routes.view.record(entity, id))
const openPlaybook = (workflowId: string) => navigate(routes.view.playbooks(workflowId))

export function DomainsPage({ details }: { details: DomainsDetails | null }) {
  if (!details) return <PagesOverviewPage />
  switch (details.type) {
    case 'record': return <RecordPage key={`${details.entity}:${details.recordId}`} entity={details.entity} recordId={details.recordId} />
    case 'entities': return <EntitiesPage key={`${details.domain}:${details.entity ?? ''}`} domainId={details.domain} entity={details.entity} />
    case 'dashboard': return <DashboardPage domainId={details.domain} pageId={details.pageId} params={details.params} />
    case 'automations': return <AutomationsPage domainId={details.domain} />
    case 'domain': return <DomainPage key={details.domain} domainId={details.domain} tab={details.tab} />
  }
}

function useDomain(domainId: string) {
  const domains = useAtomValue(memwiseDomainsAtom)
  return { domains, domain: domains?.find(d => d.id === domainId) ?? null, loading: domains === null }
}

// ---------------------------------------------------------------- pages overview

function PagesOverviewPage() {
  const { t } = useTranslation()
  const domains = useAtomValue(memwiseDomainsAtom)
  const pages = useAtomValue(pagesAtom)
  const [filter, setFilter] = useAtom(memwiseDomainFilterAtom)
  return (
    <Info_Page loading={domains === null}>
      <Info_Page.Header title={t('memwise.domains.pagesTitle')} />
      <PagesOverview
        domains={domains ?? []}
        workspacePages={pages.map(p => ({ slug: p.config.slug, name: p.config.name }))}
        domainFilter={filter}
        onDomainFilter={setFilter}
        onOpenDomainPage={(domain, pageId) => navigate(routes.view.domains({ type: 'dashboard', domain, pageId }))}
        onOpenEntities={(domain, entity) => navigate(routes.view.domains({ type: 'entities', domain, entity }))}
        onOpenWorkspacePage={slug => navigate(routes.view.pages(slug))}
        onOpenLibrary={() => navigate(routes.view.pages())}
      />
    </Info_Page>
  )
}

// ---------------------------------------------------------------- domain page

function DomainPage({ domainId, tab }: { domainId: string; tab?: 'rules' }) {
  const { t } = useTranslation()
  const { domain, loading } = useDomain(domainId)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  // A domain with a home (domain.yaml `home:`) opens on its question box; "About this domain" shows the rest.
  const [about, setAbout] = React.useState(false)
  const home = domain?.home
  const showHome = !!home && !tab && !about
  const ends = home ? [home.draftState, ...home.endStates].map(s => `'${s}'`).join(', ') : ''
  const watching = useMemwiseRecordQuery(showHome ? { entity: home.entity, domain: domainId, filter: `not (status in (${ends}))`, limit: 8 } : null)
  const drafts = useMemwiseRecordQuery(showHome ? { entity: home.entity, domain: domainId, filter: `status = '${home.draftState}'`, limit: 8 } : null)
  const store = useStore()
  const reconcile = useSetAtom(reconcilePanelStackAtom)
  // Asking: the draft and its chat are made together; the chat (answering) on the left, the
  // draft's page (filling in) on the right.
  const ask = async (question: string) => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api || typeof api.memwiseAsk !== 'function') { toast.error(t('memwise.notAvailable')); return }
    try {
      const r = await api.memwiseAsk(ws, { domain: domainId, question })
      await waitForSession(store, r.sessionId)
      reconcile({
        entries: [
          { route: routes.view.allSessions(r.sessionId), proportion: 0.55 },
          { route: routes.view.record(r.entity, r.recordId), proportion: 0.45 },
        ],
        focusedIndex: 0,
      })
    } catch (err) {
      toast.error(t('memwise.home.failed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }
  if (domain && home && showHome) {
    return (
      <Info_Page loading={loading}>
        <DomainHome
          domain={domain}
          home={home}
          watching={watching.data}
          drafts={drafts.data}
          ask={ask}
          onOpenRecord={openRecord}
          onAbout={() => setAbout(true)}
        />
      </Info_Page>
    )
  }
  return (
    <Info_Page loading={loading} empty={!loading && !domain ? t('memwise.domains.missing') : undefined}>
      <Info_Page.Header title={domain?.name ?? t('memwise.nav.domains')} />
      {home && about && (
        <button type="button" className="mx-6 mt-2 self-start text-label-sm text-tertiary hover:text-foreground" onClick={() => setAbout(false)}>
          ← {t('memwise.home.backToAsk')}
        </button>
      )}
      {domain && (
        <DomainView
          domain={domain}
          playbooks={playbooks}
          tab={tab}
          onOpenEntities={entity => navigate(routes.view.domains({ type: 'entities', domain: domain.id, ...(entity ? { entity } : {}) }))}
          onOpenPlaybook={openPlaybook}
          onOpenPage={pageId => navigate(routes.view.domains({ type: 'dashboard', domain: domain.id, pageId }))}
          onOpenAutomations={() => navigate(routes.view.domains({ type: 'automations', domain: domain.id }))}
        />
      )}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- entities

function EntitiesPage({ domainId, entity }: { domainId: string; entity?: string }) {
  const { t } = useTranslation()
  const { domain, loading } = useDomain(domainId)
  const types = useAtomValue(memwiseEntityTypesAtom)
  const type = entity ? types?.find(x => x.key === entity) ?? null : null
  const [tab, setTab] = React.useState<'records' | 'definition'>('records')
  const { data: views } = useMemwiseViews(entity ? domainId : null, entity ?? null)
  const [state, setState] = React.useState<RecordsViewState>({ filter: '', layout: 'table' })
  // Open on the first shared view of the type, when it has one.
  const opened = React.useRef(false)
  React.useEffect(() => {
    if (opened.current || !views) return
    opened.current = true
    const first = views.find(v => v.entity === entity && !v.personal)
    if (first) setState(viewToState(first))
  }, [views, entity])
  const query = useMemwiseRecordQuery(entity && tab === 'records' ? stateToQuery(entity, domainId, state) : null)
  const calls = useMemwiseRecordCalls()
  const saveView = React.useCallback((view: MwSaveViewInput['view']) => calls.saveView({ domain: domainId, view }), [calls, domainId])
  const [creating, setCreating] = React.useState(false)

  const title = entity ? domain?.entities.find(e => e.key === entity)?.title ?? entity : t('memwise.entities.title')
  return (
    <Info_Page loading={loading || (!!entity && types === null)} empty={!loading && !domain ? t('memwise.domains.missing') : undefined}>
      <Info_Page.Header title={title} />
      {domain && !entity && (
        <EntitiesHome domain={domain} types={types ?? []} onOpenEntity={key => navigate(routes.view.domains({ type: 'entities', domain: domain.id, entity: key }))} />
      )}
      {domain && entity && type && (
        <EntityView
          domain={domain}
          type={type}
          tab={tab}
          onTab={setTab}
          views={views ?? []}
          state={state}
          onState={setState}
          result={query.data}
          error={query.error}
          loading={query.loading}
          onOpenRecord={openRecord}
          onOpenPlaybook={openPlaybook}
          onSaveView={saveView}
          onCreate={() => setCreating(true)}
        />
      )}
      {type && (
        <NewRecordDialog open={creating} type={type} title={title} onClose={() => setCreating(false)} create={calls.create} onCreated={openRecord} />
      )}
      {domain && entity && types !== null && !type && <p className="p-6 text-label text-tertiary">{t('memwise.entities.missing')}</p>}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- dashboard

function DashboardPage({ domainId, pageId, params }: { domainId: string; pageId: string; params?: Record<string, string> }) {
  const { t } = useTranslation()
  const { data, error, loading, reload } = useMemwiseDashboard(domainId, pageId, params)
  return (
    <Info_Page loading={loading && !data} error={!data && error ? error : undefined}>
      <Info_Page.Header title={data?.title ?? t('memwise.dashboard.title')} />
      {data && <DashboardView dashboard={data} onOpenRecord={openRecord} onRefresh={reload} refreshing={loading} />}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- automations

function AutomationsPage({ domainId }: { domainId?: string }) {
  const { t } = useTranslation()
  const { data, error, loading, reload } = useMemwiseTriggers()
  const domains = useAtomValue(memwiseDomainsAtom)
  const calls = useMemwiseRecordCalls()
  const release = React.useCallback(async (trigger: string, decision: 'start' | 'discard') => {
    const r = await calls.releaseTrigger({ trigger, decision })
    if (r.applied) reload()
    return r
  }, [calls, reload])
  return (
    <Info_Page loading={loading && !data} error={!data && error ? error : undefined}>
      <Info_Page.Header title={t('memwise.nav.automations')} />
      {data && (
        <AutomationsView
          triggers={data}
          domains={domains}
          domain={domainId ?? null}
          onOpenPlaybook={openPlaybook}
          onOpenRecord={openRecord}
          release={release}
        />
      )}
    </Info_Page>
  )
}
