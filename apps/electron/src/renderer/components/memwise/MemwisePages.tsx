/**
 * The content panel for the Inbox, Cases and Playbooks sections: each page reads its data
 * through the MemWise hooks and hands it to the presentational views.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { BookmarkPlus, BookOpen, FilePen, MessageSquare, MessagesSquare, PencilLine, Play } from 'lucide-react'
import { Info_Page } from '@/components/info/Info_Page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DetailEmptyState } from '@/components/app-shell/DetailEmptyState'
import { navigate, routes } from '@/lib/navigate'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import {
  memwiseDraftOpenTabAtom,
  memwiseInboxAtom,
  memwisePeopleAtom,
  memwisePeopleOnlyAtom,
  memwisePlaybooksAtom,
  memwiseRolesAtom,
  memwiseStartCaseDialogAtom,
  memwiseWorkspaceIdAtom,
} from '@/atoms/memwise'
import {
  getMemwiseApi,
  useMemwiseBuildPlaybook,
  useMemwiseCase,
  useMemwiseDraft,
  useMemwiseDrafts,
  useMemwiseLiveCounts,
  useMemwiseOpenChat,
  useMemwisePlaybook,
  useMemwiseRefresh,
  useMemwiseUpload,
  useMemwiseVersions,
} from '@/hooks/useMemwise'
import type { MwCase, MwInboxItem, MwOpenChatInput, MwSubmitResult } from '@memwise/shared/protocol'
import { CaseView } from './CaseView'
import { InboxItemView, type InboxActions } from './InboxItemView'
import { StepRecordDrawer } from './StepRecordDrawer'
import { MemwiseStatusBanner } from './MemwiseStatus'
import { PlaybookView } from './playbook'
import { PlaybookDrafts, VersionLine } from './playbook/VersionLine'
import { WorkflowMap } from './map'
import { peopleById, resultMessage, sortInbox } from './format'
import { DraftView, type DraftActions, type DraftTab } from './draft'
import { isMetaPlaybook } from './draft/draft-model'
import { SaveAsExampleDialog, openBuildChat } from './BuildDialogs'

const notAvailable = (): MwSubmitResult => ({ applied: false, message: i18n.t('memwise.notAvailable') })

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

/** Opens a chat anchored to a case or step in a new panel beside the current one. */
function useOpenChatBeside() {
  const { t } = useTranslation()
  const openChat = useMemwiseOpenChat()
  return React.useCallback(async (anchor: MwOpenChatInput['anchor']) => {
    try {
      const sessionId = await openChat(anchor)
      if (sessionId) navigate(routes.view.allSessions(sessionId), { newPanel: true })
    } catch (err) {
      toast.error(t('memwise.step.openChatFailed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }, [openChat, t])
}

/** The draft a playbook change's case is about (its `draft` value). */
function caseDraftId(kase: Pick<MwCase, 'workflowId' | 'values'> | null | undefined): string | undefined {
  if (!kase || !isMetaPlaybook(kase.workflowId)) return undefined
  const value = kase.values.draft?.value
  return typeof value === 'string' && value ? value : undefined
}

/** The conversation step of a build or change case: the step run its chat answers. */
function conversationStepRun(kase: MwCase | null | undefined): string | undefined {
  if (!kase) return undefined
  const runs = [...kase.timeline].reverse()
  return (runs.find(r => r.status === 'waiting' && r.performer === 'agent') ?? runs.find(r => r.stepId === 'interview' || r.stepId === 'edit'))?.stepRunId
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
  const store = useStore()
  const openChatBeside = useOpenChatBeside()
  const item = itemId ? inbox?.find(i => i.id === itemId) ?? null : null
  // A playbook change's review whose card does not name its draft: read it from the case.
  const needsCase = item?.kind === 'decision' && isMetaPlaybook(item.workflowId) && typeof item.context.draft?.value !== 'string'
  const { data: reviewCase } = useMemwiseCase(needsCase ? item!.caseId : null)

  const actions = React.useMemo<InboxActions>(() => {
    const api = getMemwiseApi()
    return {
      submitStep: input => (api && workspaceId ? api.memwiseSubmitStep(workspaceId, input) : Promise.resolve(notAvailable())),
      decideApproval: input => (api && workspaceId ? api.memwiseDecideApproval(workspaceId, input) : Promise.resolve(notAvailable())),
      sendEvent: input => (api && workspaceId ? api.memwiseSendEvent(workspaceId, input) : Promise.resolve(notAvailable())),
      ...(api?.memwiseDismissInboxItem ? {
        dismiss: (id: string) => (workspaceId ? api.memwiseDismissInboxItem(workspaceId, id) : Promise.resolve(notAvailable())),
      } : {}),
      uploadFile: upload,
      openCase: caseId => navigate(routes.view.cases(caseId)),
      openDraft: draftId => navigate(routes.view.draft(draftId)),
      continueChat: (conv: Extract<MwInboxItem, { kind: 'conversation' }>) => {
        if (conv.sessionId && store.get(sessionMetaMapAtom).has(conv.sessionId)) {
          navigate(routes.view.allSessions(conv.sessionId), { newPanel: true })
        } else {
          void openChatBeside({ kind: 'step', id: conv.stepRunId })
        }
      },
      onDone: result => {
        toast.success(result.message ?? (item ? t('memwise.inbox.doneWith', { title: item.caseTitle }) : t('memwise.inbox.done')))
        // Move on to the next item waiting, newest first.
        const rest = sortInbox((inbox ?? []).filter(i => i.id !== itemId))
        void refresh()
        navigate(routes.view.inbox(rest[0]?.id))
      },
    }
  }, [workspaceId, upload, inbox, itemId, item, refresh, t, store, openChatBeside])

  if (!itemId) {
    return (
      <div className="flex h-full flex-col">
        <MemwiseStatusBanner className="m-4 mb-0" />
        <div className="min-h-0 flex-1"><DetailEmptyState message={inbox && inbox.length === 0 ? t('memwise.inbox.allDone') : t('memwise.inbox.selectItem')} /></div>
      </div>
    )
  }
  return (
    <Info_Page loading={inbox === null} empty={inbox !== null && !item ? t('memwise.inbox.itemGone') : undefined}>
      <Info_Page.Header title={t('memwise.nav.inbox')} />
      {item && <InboxItemView key={item.id} item={item} actions={actions} people={people} roles={roles} reviewDraftId={caseDraftId(reviewCase)} />}
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
  const [savingExample, setSavingExample] = React.useState(false)
  const openChatAndGo = useOpenChatAndGo()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  // A person's own sign-in has no chats
  const peopleOnly = useAtomValue(memwisePeopleOnlyAtom)
  const api = getMemwiseApi()
  const canSaveExample = !!kase && !isMetaPlaybook(kase.workflowId) && typeof api?.memwiseExampleFromCase === 'function'
  const draftId = caseDraftId(kase)

  React.useEffect(() => setOpenStep(null), [caseId])

  if (!caseId) {
    return (
      <div className="flex h-full flex-col">
        <MemwiseStatusBanner className="m-4 mb-0" />
        <div className="min-h-0 flex-1"><DetailEmptyState message={t('memwise.cases.selectCase')} /></div>
      </div>
    )
  }
  return (
    <Info_Page loading={loading && !kase} error={!kase && error ? error : undefined}>
      <Info_Page.Header
        title={kase?.title ?? t('memwise.nav.cases')}
        actions={kase ? (
          <div className="flex items-center gap-1">
            {draftId && (
              <Button variant="ghost" size="sm" onClick={() => navigate(routes.view.draft(draftId))} data-action="open-draft">
                <FilePen />
                {t('memwise.case.openDraft')}
              </Button>
            )}
            {canSaveExample && (
              <Button variant="ghost" size="sm" onClick={() => setSavingExample(true)} data-action="save-example">
                <BookmarkPlus />
                {t('memwise.example.title')}
              </Button>
            )}
            {!peopleOnly && (
              <Button variant="ghost" size="sm" onClick={() => void openChatAndGo({ kind: 'case', id: kase.caseId })}>
                <MessageSquare />
                {t('memwise.case.openChat')}
              </Button>
            )}
          </div>
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
      {kase && canSaveExample && (
        <SaveAsExampleDialog
          open={savingExample}
          onOpenChange={setSavingExample}
          kase={kase}
          playbook={playbook}
          save={input => (api && workspaceId ? api.memwiseExampleFromCase(workspaceId, input) : Promise.resolve({ applied: false, message: t('memwise.notAvailable') }))}
        />
      )}
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
  const setDraftTab = useSetAtom(memwiseDraftOpenTabAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const peopleOnly = useAtomValue(memwisePeopleOnlyAtom)
  const { data: versions } = useMemwiseVersions(playbookId)
  const { data: drafts } = useMemwiseDrafts(playbookId)
  const build = useMemwiseBuildPlaybook()
  const [starting, setStarting] = React.useState<'chat' | 'edit' | null>(null)
  const api = getMemwiseApi()
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
        <div className="min-h-0 flex-1"><DetailEmptyState message={summaries && summaries.length === 0 ? t('memwise.playbooks.none') : t('memwise.playbooks.selectPlaybook')} /></div>
      </div>
    )
  }
  const summary = summaries?.find(p => p.id === playbookId)
  const meta = isMetaPlaybook(playbookId)

  const changeWithChat = async () => {
    setStarting('chat')
    try {
      const result = await build({ workflowId: playbookId })
      if (result) openBuildChat(result, { stay: true })
    } catch (err) {
      toast.error(t('memwise.build.failed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setStarting(null)
    }
  }

  const edit = async () => {
    if (!api || !workspaceId || typeof api.memwiseCreateDraft !== 'function') return
    setStarting('edit')
    try {
      const title = playbook?.title ?? summary?.title ?? playbookId
      const created = await api.memwiseCreateDraft(workspaceId, { workflowId: playbookId, title: t('memwise.draft.editTitle', { title }), kind: 'change' })
      setDraftTab({ draftId: created.id, tab: 'steps' })
      navigate(routes.view.draft(created.id))
    } catch (err) {
      toast.error(t('memwise.draft.createFailed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setStarting(null)
    }
  }

  return (
    <Info_Page loading={loading && !playbook} error={!playbook && error ? error : undefined}>
      <Info_Page.Header
        title={playbook?.title ?? summary?.title ?? t('memwise.nav.playbooks')}
        actions={
          <div className="flex items-center gap-1">
            {!meta && !peopleOnly && typeof api?.memwiseBuildPlaybook === 'function' && (
              <Button variant="ghost" size="sm" onClick={() => void changeWithChat()} disabled={!!starting} data-action="change-with-chat">
                <MessagesSquare />
                {starting === 'chat' ? t('memwise.build.starting') : t('memwise.build.changeWithChat')}
              </Button>
            )}
            {!meta && typeof api?.memwiseCreateDraft === 'function' && (
              <Button variant="ghost" size="sm" onClick={() => void edit()} disabled={!!starting} data-action="edit-playbook">
                <PencilLine />
                {t('memwise.draft.editPlaybook')}
              </Button>
            )}
            {!meta && (
              <Button variant="primary" size="sm" onClick={() => setStartCase({ open: true, workflowId: playbookId })}>
                <Play />
                {t('memwise.cases.startCase')}
              </Button>
            )}
          </div>
        }
      />
      {playbook && (
        <Info_Page.Content wide={tab === 'map'}>
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
            <TabsContent value="playbook" className="mt-4 space-y-6">
              <PlaybookDrafts drafts={drafts} onOpen={id => navigate(routes.view.draft(id))} />
              <PlaybookView
                playbook={playbook}
                roles={roles}
                selectedStepId={selectedStep}
                onSelectStep={setSelectedStep}
                versionLine={<VersionLine versions={versions} version={playbook.version} />}
              />
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

// ---------------------------------------------------------------- drafts

export function DraftPage({ draftId }: { draftId: string }) {
  const { t } = useTranslation()
  const { data: draft, error, loading, reload } = useMemwiseDraft(draftId)
  const { data: live } = useMemwisePlaybook(draft?.kind === 'change' ? draft.workflowId : null)
  const { data: changeCase } = useMemwiseCase(draft?.caseId ?? null)
  const roles = useAtomValue(memwiseRolesAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const peopleOnly = useAtomValue(memwisePeopleOnlyAtom)
  const [openTab, setOpenTab] = useAtom(memwiseDraftOpenTabAtom)
  const [tab, setTab] = React.useState<DraftTab>(() => (openTab?.draftId === draftId ? openTab.tab : 'changes'))
  const [checking, setChecking] = React.useState<{ startedAt: number } | null>(null)
  const [busy, setBusy] = React.useState<'submit' | 'discard' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)
  const openChatBeside = useOpenChatBeside()
  const refresh = useMemwiseRefresh()

  React.useEffect(() => {
    if (openTab?.draftId === draftId) setOpenTab(null)
  }, [openTab, draftId, setOpenTab])

  const api = getMemwiseApi()
  const ready = !!api && !!workspaceId
  const fail = React.useCallback((title: string, r: { code?: string; message?: string }) => {
    toast.error(title, { description: resultMessage(r, t) })
  }, [t])

  const actions = React.useMemo<DraftActions>(() => {
    if (!api || !workspaceId || !draft) return {}
    const conversation = conversationStepRun(changeCase)
    return {
      check: async () => {
        setChecking({ startedAt: Date.now() })
        try {
          const report = await api.memwiseCheckDraft(workspaceId, { draftId })
          if (report.outcome === 'passed') toast.success(t('memwise.draft.checks.passed'), { description: report.summary })
          else toast.error(t('memwise.draft.checks.failed'), { description: report.summary })
        } catch (err) {
          fail(t('memwise.draft.checkFailed'), { message: err instanceof Error ? err.message : String(err) })
        } finally {
          setChecking(null)
          reload()
        }
      },
      submit: async () => {
        setBusy('submit')
        try {
          const r = await api.memwiseSubmitDraft(workspaceId, draftId)
          if (r.applied) {
            toast.success(t('memwise.draft.submitted'), { description: t('memwise.draft.submittedDescription') })
            void refresh()
          } else fail(t('memwise.draft.submitFailed'), r)
        } catch (err) {
          fail(t('memwise.draft.submitFailed'), { message: err instanceof Error ? err.message : String(err) })
        } finally {
          setBusy(null)
          reload()
        }
      },
      discard: () => setConfirmDiscard(true),
      ...(!peopleOnly && (conversation || draft.caseId) ? {
        openChat: () => void openChatBeside(conversation ? { kind: 'step', id: conversation } : { kind: 'case', id: draft.caseId! }),
      } : {}),
      keepEdit: async editId => {
        const r = await api.memwiseKeepDraftEdit(workspaceId, { draftId, editId })
        reload()
        return r
      },
      discardEdit: async editId => {
        const r = await api.memwiseDiscardDraftEdit(workspaceId, { draftId, editId })
        reload()
        return r
      },
      saveStep: async ({ path, content, summary }) => {
        const r = await api.memwiseWriteDraft(workspaceId, { draftId, files: [{ path, content }], summary })
        if (r.applied) toast.success(t('memwise.editor.saved'))
        reload()
        return r
      },
      openCase: caseId => navigate(routes.view.cases(caseId)),
      openPlaybook: id => navigate(routes.view.playbooks(id)),
    }
  }, [api, workspaceId, draft, draftId, changeCase, peopleOnly, openChatBeside, reload, refresh, fail, t])

  const discard = async () => {
    if (!api || !workspaceId || !draft) return
    setBusy('discard')
    try {
      const r = await api.memwiseDiscardDraft(workspaceId, draftId)
      if (r.applied) {
        setConfirmDiscard(false)
        toast.success(t('memwise.draft.discarded'))
        void refresh()
        navigate(draft.kind === 'change' ? routes.view.playbooks(draft.workflowId) : routes.view.playbooks())
      } else fail(t('memwise.draft.discardFailed'), r)
    } catch (err) {
      fail(t('memwise.draft.discardFailed'), { message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Info_Page loading={loading && !draft} error={!draft && error ? error : !ready ? t('memwise.notAvailable') : undefined}>
      <Info_Page.Header title={draft?.title ?? t('memwise.draft.title')} />
      {draft && (
        <DraftView
          draft={draft}
          live={live}
          roles={roles}
          actions={actions}
          checking={checking}
          busy={busy}
          tab={tab}
          onTabChange={setTab}
        />
      )}
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('memwise.draft.discardTitle')}</DialogTitle>
            <DialogDescription>{t('memwise.draft.discardDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>{t('common.cancel')}</Button>
            <Button variant="danger-solid" onClick={() => void discard()} disabled={busy === 'discard'} data-action="confirm-discard">
              {t('memwise.draft.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Info_Page>
  )
}
