/**
 * The content panel for the Inbox, Cases and Playbooks sections: each page reads its data
 * through the MemWise hooks and hands it to the presentational views.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { BookOpen, Briefcase, ClipboardCheck, MessageSquare, Play } from 'lucide-react'
import { Info_Page } from '@/components/info'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DetailEmptyState } from '@/components/app-shell/DetailEmptyState'
import { navigate, routes } from '@/lib/navigate'
import {
  memwiseInboxAtom,
  memwisePeopleAtom,
  memwisePlaybooksAtom,
  memwiseRolesAtom,
  memwiseStartCaseDialogAtom,
  memwiseWorkspaceIdAtom,
} from '@/atoms/memwise'
import {
  getMemwiseApi,
  useMemwiseCase,
  useMemwiseLiveCounts,
  useMemwiseOpenChat,
  useMemwisePlaybook,
  useMemwiseRefresh,
  useMemwiseUpload,
} from '@/hooks/useMemwise'
import type { MwOpenChatInput, MwSubmitResult } from '@memwise/shared/protocol'
import { CaseView } from './CaseView'
import { InboxItemView, type InboxActions } from './InboxItemView'
import { StepRecordDrawer } from './StepRecordDrawer'
import { MemwiseStatusBanner } from './MemwiseStatus'
import { PlaybookView } from './playbook'
import { WorkflowMap } from './map'
import { peopleById, sortInbox } from './format'

const notAvailable = (): MwSubmitResult => ({ applied: false, message: 'MemWise is not available' })

function useOpenChatAndGo() {
  const { t } = useTranslation()
  const openChat = useMemwiseOpenChat()
  return React.useCallback(async (anchor: MwOpenChatInput['anchor']) => {
    try {
      const sessionId = await openChat(anchor)
      if (sessionId) navigate(routes.view.allSessions(sessionId))
    } catch (err) {
      toast.error(t('memwise.step.openChatFailed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }, [openChat, t])
}

// ---------------------------------------------------------------- inbox

export function InboxDetailPage({ itemId }: { itemId: string | null }) {
  const { t } = useTranslation()
  const inbox = useAtomValue(memwiseInboxAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const people = peopleById(useAtomValue(memwisePeopleAtom))
  const roles = useAtomValue(memwiseRolesAtom)
  const refresh = useMemwiseRefresh()
  const upload = useMemwiseUpload()
  const item = itemId ? inbox?.find(i => i.id === itemId) ?? null : null

  const actions = React.useMemo<InboxActions>(() => {
    const api = getMemwiseApi()
    return {
      submitStep: input => (api && workspaceId ? api.memwiseSubmitStep(workspaceId, input) : Promise.resolve(notAvailable())),
      decideApproval: input => (api && workspaceId ? api.memwiseDecideApproval(workspaceId, input) : Promise.resolve(notAvailable())),
      sendEvent: input => (api && workspaceId ? api.memwiseSendEvent(workspaceId, input) : Promise.resolve(notAvailable())),
      uploadFile: upload,
      openCase: caseId => navigate(routes.view.cases(caseId)),
      onDone: result => {
        toast.success(result.message ?? t('memwise.inbox.done'))
        // Move on to the next item waiting, newest first.
        const rest = sortInbox((inbox ?? []).filter(i => i.id !== itemId))
        void refresh()
        navigate(routes.view.inbox(rest[0]?.id))
      },
    }
  }, [workspaceId, upload, inbox, itemId, refresh, t])

  if (!itemId) {
    return (
      <div className="flex h-full flex-col">
        <MemwiseStatusBanner className="m-4 mb-0" />
        <DetailEmptyState message={inbox && inbox.length === 0 ? t('memwise.inbox.allDone') : t('memwise.inbox.selectItem')} />
      </div>
    )
  }
  return (
    <Info_Page loading={inbox === null} empty={inbox !== null && !item ? t('memwise.inbox.itemGone') : undefined}>
      <Info_Page.Header title={t('memwise.nav.inbox')} />
      {item && <InboxItemView key={item.id} item={item} actions={actions} people={people} roles={roles} />}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- cases

export function CasePage({ caseId }: { caseId: string | null }) {
  const { t } = useTranslation()
  const { data: kase, error, loading } = useMemwiseCase(caseId)
  const { data: playbook } = useMemwisePlaybook(kase?.workflowId ?? null)
  const summaries = useAtomValue(memwisePlaybooksAtom)
  const people = peopleById(useAtomValue(memwisePeopleAtom))
  const roles = useAtomValue(memwiseRolesAtom)
  const [openStep, setOpenStep] = React.useState<string | null>(null)
  const openChatAndGo = useOpenChatAndGo()

  React.useEffect(() => setOpenStep(null), [caseId])

  if (!caseId) {
    return (
      <div className="flex h-full flex-col">
        <MemwiseStatusBanner className="m-4 mb-0" />
        <DetailEmptyState message={t('memwise.cases.selectCase')} />
      </div>
    )
  }
  return (
    <Info_Page loading={loading && !kase} error={!kase && error ? error : undefined}>
      <Info_Page.Header
        title={kase?.title ?? t('memwise.nav.cases')}
        actions={kase ? (
          <Button variant="ghost" size="sm" onClick={() => void openChatAndGo({ kind: 'case', id: kase.caseId })}>
            <MessageSquare />
            {t('memwise.case.openChat')}
          </Button>
        ) : undefined}
      />
      {kase && (
        <CaseView
          kase={kase}
          playbook={playbook}
          playbookTitle={summaries?.find(p => p.id === kase.workflowId)?.title}
          people={people}
          roles={roles}
          onOpenStep={setOpenStep}
          onOpenPlaybook={id => navigate(routes.view.playbooks(id))}
        />
      )}
      <StepRecordDrawer stepRunId={openStep} onClose={() => setOpenStep(null)} />
    </Info_Page>
  )
}

// ---------------------------------------------------------------- playbooks

export function PlaybookPage({ playbookId }: { playbookId: string | null }) {
  const { t } = useTranslation()
  const { data: playbook, error, loading } = useMemwisePlaybook(playbookId)
  const roles = useAtomValue(memwiseRolesAtom)
  const summaries = useAtomValue(memwisePlaybooksAtom)
  const setStartCase = useSetAtom(memwiseStartCaseDialogAtom)
  const [tab, setTab] = React.useState<'playbook' | 'map'>('playbook')
  const [mapMode, setMapMode] = React.useState<'design' | 'live'>('design')
  const { data: live } = useMemwiseLiveCounts(tab === 'map' && mapMode === 'live' ? playbookId : null)
  const [selectedStep, setSelectedStep] = React.useState<string | undefined>()

  React.useEffect(() => {
    setSelectedStep(undefined)
    setTab('playbook')
  }, [playbookId])

  if (!playbookId) {
    return (
      <div className="flex h-full flex-col">
        <MemwiseStatusBanner className="m-4 mb-0" />
        <DetailEmptyState message={summaries && summaries.length === 0 ? t('memwise.playbooks.none') : t('memwise.playbooks.selectPlaybook')} />
      </div>
    )
  }
  const summary = summaries?.find(p => p.id === playbookId)
  return (
    <Info_Page loading={loading && !playbook} error={!playbook && error ? error : undefined}>
      <Info_Page.Header
        title={playbook?.title ?? summary?.title ?? t('memwise.nav.playbooks')}
        actions={
          <Button variant="primary" size="sm" onClick={() => setStartCase({ open: true, workflowId: playbookId })}>
            <Play />
            {t('memwise.cases.startCase')}
          </Button>
        }
      />
      {playbook && (
        <Info_Page.Content>
          <Tabs value={tab} onValueChange={v => setTab(v as 'playbook' | 'map')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="playbook"><BookOpen />{t('memwise.playbooks.tabPlaybook')}</TabsTrigger>
                <TabsTrigger value="map">{t('memwise.playbooks.tabMap')}</TabsTrigger>
              </TabsList>
              {tab === 'map' && (
                <Tabs value={mapMode} onValueChange={v => setMapMode(v as 'design' | 'live')}>
                  <TabsList>
                    <TabsTrigger value="design">{t('memwise.playbooks.mapDesign')}</TabsTrigger>
                    <TabsTrigger value="live">{t('memwise.playbooks.mapLive')}</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>
            <TabsContent value="playbook" className="mt-4">
              <PlaybookView playbook={playbook} roles={roles} selectedStepId={selectedStep} onSelectStep={setSelectedStep} />
            </TabsContent>
            <TabsContent value="map" className="mt-4">
              <div className="overflow-x-auto rounded-lg bg-raised p-3 shadow-elev-1">
                <WorkflowMap
                  playbook={playbook}
                  mode={mapMode}
                  live={mapMode === 'live' ? live ?? undefined : undefined}
                  roles={roles}
                  selectedStateId={selectedStep}
                  onSelectState={id => {
                    const state = playbook.states.find(s => s.id === id)
                    if (state?.stepId) {
                      setSelectedStep(state.stepId)
                      setTab('playbook')
                    }
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}

/** Shown in place of a section's page when the host has no MemWise API. */
export function MemwiseSectionIcon({ section }: { section: 'inbox' | 'cases' | 'playbooks' }) {
  const Icon = section === 'inbox' ? ClipboardCheck : section === 'cases' ? Briefcase : BookOpen
  return <Icon className="h-3.5 w-3.5" />
}
