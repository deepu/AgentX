/**
 * MemWise data hooks.
 *
 * useMemwiseData (mounted once, by MemwiseHost) loads the status, people, inbox, cases and
 * playbooks for the active workspace and refetches them when `memwise:changed` says what
 * changed. Detail views (a case, a playbook, live counts, a step record) use the smaller
 * useMemwise* hooks below, which refetch on the same pushes through memwiseLastChangeAtom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import i18n from 'i18next'
import type {
  MwBindingView,
  MwBuildPlaybookInput,
  MwChannelsAvailable,
  MwExtractInput,
  MwExtractResult,
  MwIssuedLink,
  MwIssueLinkInput,
  MwNotifySettings,
  MwRelayStatus,
  MwResendInput,
  MwResendPreview,
  MwResendResult,
  MwSubmitResult,
  MwBuildPlaybookResult,
  MwCase,
  MwChange,
  MwDraft,
  MwDraftSummary,
  MwEntityRecord,
  MwEntityRow,
  MwLiveCounts,
  MwPlaybook,
  MwPluginDetail,
  MwStatus,
  MwStepRecord,
  MwVersion,
} from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import {
  memwiseAvailableAtom,
  memwiseCasesAtom,
  memwiseDomainsAtom,
  memwiseDraftsAtom,
  memwiseEntityTypesAtom,
  memwiseInboxAtom,
  memwiseLastChangeAtom,
  memwisePeopleAtom,
  memwisePlaybooksAtom,
  memwisePluginsAtom,
  memwiseRolesAtom,
  memwiseStatusAtom,
  memwiseWorkspaceIdAtom,
} from '@/atoms/memwise'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import type { ElectronAPI } from '../../shared/types'

type MemwiseMethod = Extract<keyof ElectronAPI, `memwise${string}` | 'onMemwiseChanged'>
export type MemwiseApi = Pick<ElectronAPI, MemwiseMethod>

/** The MemWise methods of this host, or null when it has none (an older server). */
export function getMemwiseApi(): MemwiseApi | null {
  const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as Partial<MemwiseApi> | undefined
  if (!api || typeof api.memwiseStatus !== 'function') return null
  return api as MemwiseApi
}

export interface AffectedLists { status: boolean; inbox: boolean; cases: boolean; playbooks: boolean; drafts: boolean; plugins: boolean; domains: boolean }

const NO_LISTS: AffectedLists = { status: false, inbox: false, cases: false, playbooks: false, drafts: false, plugins: false, domains: false }

/** Which lists a pushed change affects. */
export function affectedByChange(change: MwChange): AffectedLists {
  switch (change.kind) {
    case 'status': return { status: true, inbox: true, cases: true, playbooks: true, drafts: true, plugins: true, domains: true }
    // Publishing a draft changes the definitions; the draft's stage changes with it. A freeze
    // re-indexes too, which changes the plugins' binding state and their workflows.
    case 'definitions': return { ...NO_LISTS, status: true, playbooks: true, drafts: true, plugins: true, domains: true }
    case 'inbox': return { ...NO_LISTS, inbox: true, playbooks: true }
    case 'run':
    case 'case': return { ...NO_LISTS, inbox: true, cases: true, playbooks: true }
    // A conversation item carries its draft, so the inbox follows the drafts too.
    case 'drafts': return { ...NO_LISTS, inbox: true, drafts: true }
    // Installs, binding freezes and identity links; pending matches are inbox items.
    case 'plugins': return { ...NO_LISTS, inbox: true, plugins: true }
    // Phase 5: a link was issued, opened, saved or used; an external step is in the inbox only while it has no open link.
    case 'external': return { ...NO_LISTS, inbox: true, cases: true }
    // Phase 6: a record was written (the domains' counts and flags move; a flag is an inbox item).
    case 'records': return { ...NO_LISTS, inbox: true, domains: true }
    // Phase 6: a trigger fired, was held or released (held firings are inbox items; released ones start cases).
    case 'triggers': return { ...NO_LISTS, inbox: true, cases: true }
    default: return { ...NO_LISTS }
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Whether this connection is a person's own sign-in (server mode): the server then advertises
 * the playbook channels but not the chat ones. Meaningful once connected (after the first reply).
 */
export function isPersonOnlyConnection(api: Pick<ElectronAPI, 'isChannelAvailable'> | undefined = typeof window !== 'undefined' ? window.electronAPI : undefined): boolean {
  if (!api || typeof api.isChannelAvailable !== 'function') return false
  return api.isChannelAvailable(RPC_CHANNELS.memwise.STATUS) && !api.isChannelAvailable(RPC_CHANNELS.sessions.GET)
}

export function useMemwiseData(workspaceId: string | null | undefined): void {
  const store = useStore()
  const setWorkspaceId = useSetAtom(memwiseWorkspaceIdAtom)
  const setStatus = useSetAtom(memwiseStatusAtom)
  const setAvailable = useSetAtom(memwiseAvailableAtom)
  const setPeople = useSetAtom(memwisePeopleAtom)
  const setRoles = useSetAtom(memwiseRolesAtom)
  const setInbox = useSetAtom(memwiseInboxAtom)
  const setCases = useSetAtom(memwiseCasesAtom)
  const setPlaybooks = useSetAtom(memwisePlaybooksAtom)
  const setDrafts = useSetAtom(memwiseDraftsAtom)
  const setPlugins = useSetAtom(memwisePluginsAtom)
  const setEntityTypes = useSetAtom(memwiseEntityTypesAtom)
  const setDomains = useSetAtom(memwiseDomainsAtom)
  const setLastChange = useSetAtom(memwiseLastChangeAtom)

  const loadStatus = useCallback(async (ws: string, api: MemwiseApi) => {
    try {
      const status = await api.memwiseStatus(ws)
      setStatus(status)
      const [people, roles] = await Promise.all([
        api.memwiseListPeople(ws).catch(() => []),
        api.memwiseListRoles(ws).catch(() => []),
      ])
      setPeople(people)
      setRoles(roles)
      return status
    } catch (err) {
      setStatus({ ready: false, message: errorMessage(err), canActAs: false, modelConfigured: false, diagnostics: [] })
      return null
    }
  }, [setStatus, setPeople, setRoles])

  const loadInbox = useCallback(async (ws: string, api: MemwiseApi) => {
    try { setInbox(await api.memwiseListInbox(ws)) } catch (err) {
      console.warn('[memwise] inbox:', errorMessage(err))
      setInbox(prev => prev ?? [])
    }
  }, [setInbox])

  const loadCases = useCallback(async (ws: string, api: MemwiseApi) => {
    try { setCases(await api.memwiseListCases(ws, {})) } catch (err) {
      console.warn('[memwise] cases:', errorMessage(err))
      setCases(prev => prev ?? [])
    }
  }, [setCases])

  const loadPlaybooks = useCallback(async (ws: string, api: MemwiseApi) => {
    try { setPlaybooks(await api.memwiseListPlaybooks(ws)) } catch (err) {
      console.warn('[memwise] playbooks:', errorMessage(err))
      setPlaybooks(prev => prev ?? [])
    }
  }, [setPlaybooks])

  const loadDrafts = useCallback(async (ws: string, api: MemwiseApi) => {
    // An older server has no drafts: leave the list empty.
    if (typeof api.memwiseListDrafts !== 'function') { setDrafts([]); return }
    try { setDrafts(await api.memwiseListDrafts(ws, {})) } catch (err) {
      console.warn('[memwise] drafts:', errorMessage(err))
      setDrafts(prev => prev ?? [])
    }
  }, [setDrafts])

  const loadPlugins = useCallback(async (ws: string, api: MemwiseApi) => {
    // An older server has no plugins: leave the lists empty.
    if (typeof api.memwiseListPlugins !== 'function') { setPlugins([]); setEntityTypes([]); return }
    const [plugins, types] = await Promise.allSettled([api.memwiseListPlugins(ws), api.memwiseListEntityTypes(ws)])
    if (plugins.status === 'fulfilled') setPlugins(plugins.value)
    else {
      console.warn('[memwise] plugins:', errorMessage(plugins.reason))
      setPlugins(prev => prev ?? [])
    }
    setEntityTypes(prev => (types.status === 'fulfilled' ? types.value : prev ?? []))
  }, [setPlugins, setEntityTypes])

  const loadDomains = useCallback(async (ws: string, api: MemwiseApi) => {
    // An older server has no domains: leave the list empty (the sidebar then shows no Domains section).
    if (typeof api.memwiseListDomains !== 'function') { setDomains([]); return }
    try { setDomains(await api.memwiseListDomains(ws)) } catch (err) {
      console.warn('[memwise] domains:', errorMessage(err))
      setDomains(prev => prev ?? [])
    }
  }, [setDomains])

  // Initial load per workspace
  useEffect(() => {
    setWorkspaceId(workspaceId ?? null)
    setInbox(null)
    setCases(null)
    setPlaybooks(null)
    setDrafts(null)
    setPlugins(null)
    setEntityTypes(null)
    setDomains(null)
    setStatus(null)
    if (!workspaceId) return
    const api = getMemwiseApi()
    setAvailable(!!api)
    if (!api) {
      setInbox([])
      setCases([])
      setPlaybooks([])
      setDrafts([])
      setPlugins([])
      setEntityTypes([])
      setDomains([])
      return
    }
    let stale = false
    void (async () => {
      await loadStatus(workspaceId, api)
      if (stale) return
      await Promise.all([loadInbox(workspaceId, api), loadCases(workspaceId, api), loadPlaybooks(workspaceId, api), loadDrafts(workspaceId, api), loadPlugins(workspaceId, api), loadDomains(workspaceId, api)])
    })()
    return () => { stale = true }
  }, [workspaceId, setWorkspaceId, setAvailable, setStatus, setInbox, setCases, setPlaybooks, setDrafts, setPlugins, setEntityTypes, setDomains, loadStatus, loadInbox, loadCases, loadPlaybooks, loadDrafts, loadPlugins, loadDomains])

  // While the kernel starts, poll the status until it's ready (pushes may not flow yet). With no
  // answer at all yet (the first request was lost, e.g. while the connection moved to the workspace
  // right after onboarding), ask again too, or the app shows "Starting" until it is reloaded.
  const status = useAtomValue(memwiseStatusAtom)
  useEffect(() => {
    if (!workspaceId || status?.ready) return
    const api = getMemwiseApi()
    if (!api) return
    const timer = setTimeout(async () => {
      const next = await loadStatus(workspaceId, api)
      if (next?.ready) {
        await Promise.all([loadInbox(workspaceId, api), loadCases(workspaceId, api), loadPlaybooks(workspaceId, api), loadDrafts(workspaceId, api), loadPlugins(workspaceId, api), loadDomains(workspaceId, api)])
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [workspaceId, status, loadStatus, loadInbox, loadCases, loadPlaybooks, loadDrafts, loadPlugins, loadDomains])

  // Live updates: one subscription; bursts of pushes are coalesced into one refetch per list.
  const pending = useRef<AffectedLists>({ ...NO_LISTS })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    if (!workspaceId) return
    const api = getMemwiseApi()
    if (!api || typeof api.onMemwiseChanged !== 'function') return
    const flush = () => {
      timer.current = null
      const p = pending.current
      pending.current = { ...NO_LISTS }
      if (store.get(memwiseWorkspaceIdAtom) !== workspaceId) return
      if (p.status) void loadStatus(workspaceId, api)
      if (p.inbox) void loadInbox(workspaceId, api)
      if (p.cases) void loadCases(workspaceId, api)
      if (p.playbooks) void loadPlaybooks(workspaceId, api)
      if (p.drafts) void loadDrafts(workspaceId, api)
      if (p.plugins) void loadPlugins(workspaceId, api)
      if (p.domains) void loadDomains(workspaceId, api)
    }
    const off = api.onMemwiseChanged((change: MwChange) => {
      setLastChange({ seq: ++seq.current, change })
      const a = affectedByChange(change)
      const p = pending.current
      pending.current = {
        status: p.status || a.status,
        inbox: p.inbox || a.inbox,
        cases: p.cases || a.cases,
        playbooks: p.playbooks || a.playbooks,
        drafts: p.drafts || a.drafts,
        plugins: p.plugins || a.plugins,
        domains: p.domains || a.domains,
      }
      if (!timer.current) timer.current = setTimeout(flush, 150)
    })
    return () => {
      if (typeof off === 'function') off()
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [workspaceId, store, setLastChange, loadStatus, loadInbox, loadCases, loadPlaybooks, loadDrafts, loadPlugins, loadDomains])
}

/** Reload the inbox and cases now (after the person acted), without waiting for a push. */
export function useMemwiseRefresh(): () => Promise<void> {
  const store = useStore()
  const setInbox = useSetAtom(memwiseInboxAtom)
  const setCases = useSetAtom(memwiseCasesAtom)
  const setPlaybooks = useSetAtom(memwisePlaybooksAtom)
  const setDrafts = useSetAtom(memwiseDraftsAtom)
  const setPlugins = useSetAtom(memwisePluginsAtom)
  return useCallback(async () => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api) return
    const [inbox, cases, playbooks, drafts, plugins] = await Promise.allSettled([
      api.memwiseListInbox(ws),
      api.memwiseListCases(ws, {}),
      api.memwiseListPlaybooks(ws),
      typeof api.memwiseListDrafts === 'function' ? api.memwiseListDrafts(ws, {}) : Promise.resolve([]),
      typeof api.memwiseListPlugins === 'function' ? api.memwiseListPlugins(ws) : Promise.resolve([]),
    ])
    if (inbox.status === 'fulfilled') setInbox(inbox.value)
    if (cases.status === 'fulfilled') setCases(cases.value)
    if (playbooks.status === 'fulfilled') setPlaybooks(playbooks.value)
    if (drafts.status === 'fulfilled') setDrafts(drafts.value)
    if (plugins.status === 'fulfilled') setPlugins(plugins.value)
  }, [store, setInbox, setCases, setPlaybooks, setDrafts, setPlugins])
}

/** Switch who the desktop acts as, then reload what depends on it. */
export function useMemwiseActAs(): (personId: string) => Promise<MwStatus | null> {
  const store = useStore()
  const setStatus = useSetAtom(memwiseStatusAtom)
  const refresh = useMemwiseRefresh()
  return useCallback(async (personId: string) => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api) return null
    const status = await api.memwiseActAs(ws, personId)
    setStatus(status)
    await refresh()
    return status
  }, [store, setStatus, refresh])
}

// ---------------------------------------------------------------- detail queries

export interface MemwiseQuery<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Fetch one thing for a detail view; refetch when a push passes `refetchOn`.
 * `key` null means nothing to fetch.
 */
export function useMemwiseQuery<T>(
  key: string | null,
  fetcher: (api: MemwiseApi, workspaceId: string) => Promise<T>,
  refetchOn: (change: MwChange, current: T | null) => boolean,
): MemwiseQuery<T> {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const lastChange = useAtomValue(memwiseLastChangeAtom)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const refetchRef = useRef(refetchOn)
  refetchRef.current = refetchOn
  const dataRef = useRef<T | null>(null)
  dataRef.current = data
  const handledSeq = useRef<number | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
  }, [key, workspaceId])

  useEffect(() => {
    if (!key || !workspaceId) return
    const api = getMemwiseApi()
    if (!api) return
    let stale = false
    setLoading(true)
    fetcherRef.current(api, workspaceId)
      .then(result => { if (!stale) { setData(result); setError(null) } })
      .catch(err => { if (!stale) setError(errorMessage(err)) })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [key, workspaceId, nonce])

  useEffect(() => {
    if (!lastChange || handledSeq.current === lastChange.seq) return
    handledSeq.current = lastChange.seq
    if (key && refetchRef.current(lastChange.change, dataRef.current)) setNonce(n => n + 1)
  }, [lastChange, key])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { data, error, loading, reload }
}

/** Whether a push concerns this case. Matched on the case id, so it works before the first fetch lands. */
export function caseChangeMatches(c: MwChange, caseId: string, cur: { runId: string } | null): boolean {
  if (c.kind !== 'run' && c.kind !== 'case' && c.kind !== 'inbox' && c.kind !== 'external') return false
  if (c.caseId) return c.caseId === caseId
  return !c.id || c.id === caseId || c.id === cur?.runId
}

/** Whether a push concerns this step's run. Before the record is loaded any run change may be it. */
export function stepChangeMatches(c: MwChange, cur: { runId: string; caseId: string } | null): boolean {
  if (c.kind !== 'run' && c.kind !== 'case') return false
  if (!c.id && !c.caseId) return true
  if (!cur) return true
  return c.caseId === cur.caseId || c.id === cur.runId || c.id === cur.caseId
}

export function useMemwiseCase(caseId: string | null): MemwiseQuery<MwCase> {
  return useMemwiseQuery<MwCase>(
    caseId ? `case:${caseId}` : null,
    (api, ws) => api.memwiseGetCase(ws, caseId!),
    (c, cur) => caseChangeMatches(c, caseId!, cur),
  )
}

export function useMemwisePlaybook(playbookId: string | null): MemwiseQuery<MwPlaybook> {
  return useMemwiseQuery<MwPlaybook>(
    playbookId ? `playbook:${playbookId}` : null,
    (api, ws) => api.memwiseGetPlaybook(ws, playbookId!),
    c => c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useMemwiseLiveCounts(playbookId: string | null): MemwiseQuery<MwLiveCounts> {
  return useMemwiseQuery<MwLiveCounts>(
    playbookId ? `live:${playbookId}` : null,
    (api, ws) => api.memwiseGetLiveCounts(ws, playbookId!),
    c => (c.kind === 'run' || c.kind === 'case') && (!c.workflowId || c.workflowId === playbookId),
  )
}

// ---------------------------------------------------------------- drafts and versions (Phase 3)

/** Whether a push concerns a draft (or every draft when `draftId` is absent). */
export function draftChangeMatches(c: MwChange, draftId?: string | null): boolean {
  if (c.kind === 'status' || c.kind === 'definitions') return true
  if (c.kind !== 'drafts') return false
  return !draftId || !c.id || c.id === draftId
}

export function useMemwiseDraft(draftId: string | null): MemwiseQuery<MwDraft> {
  return useMemwiseQuery<MwDraft>(
    draftId ? `draft:${draftId}` : null,
    (api, ws) => api.memwiseGetDraft(ws, draftId!),
    // The change run moving on (review, publish) changes the draft's stage too.
    (c, cur) => draftChangeMatches(c, draftId) || (!!cur?.runId && (c.kind === 'run' || c.kind === 'case') && (c.id === cur.runId || c.caseId === cur.caseId)),
  )
}

/** Drafts, of one playbook or all. */
export function useMemwiseDrafts(workflowId?: string | null): MemwiseQuery<MwDraftSummary[]> {
  return useMemwiseQuery<MwDraftSummary[]>(
    workflowId === null ? null : `drafts:${workflowId ?? '*'}`,
    async (api, ws) => (typeof api.memwiseListDrafts === 'function' ? api.memwiseListDrafts(ws, workflowId ? { workflowId } : {}) : []),
    c => draftChangeMatches(c) || c.kind === 'run',
  )
}

export function useMemwiseVersions(workflowId: string | null): MemwiseQuery<MwVersion[]> {
  return useMemwiseQuery<MwVersion[]>(
    workflowId ? `versions:${workflowId}` : null,
    async (api, ws) => (typeof api.memwiseListVersions === 'function' ? api.memwiseListVersions(ws, workflowId!) : []),
    c => c.kind === 'definitions' || c.kind === 'status' || ((c.kind === 'run' || c.kind === 'case') && (!c.workflowId || c.workflowId === workflowId)),
  )
}

export function useMemwiseStepRecord(stepRunId: string | null): MemwiseQuery<MwStepRecord> {
  return useMemwiseQuery<MwStepRecord>(
    stepRunId ? `step:${stepRunId}` : null,
    (api, ws) => api.memwiseGetStepRecord(ws, stepRunId!),
    (c, cur) => stepChangeMatches(c, cur),
  )
}

// ---------------------------------------------------------------- plugins, bindings, records (Phase 4)

/** Whether a push may change a plugin or its binding (installs, freezes, the bind run moving on). */
export function pluginChangeMatches(c: MwChange): boolean {
  return c.kind === 'plugins' || c.kind === 'definitions' || c.kind === 'status'
}

export function useMemwisePlugin(pluginId: string | null): MemwiseQuery<MwPluginDetail> {
  return useMemwiseQuery<MwPluginDetail>(
    pluginId ? `plugin:${pluginId}` : null,
    (api, ws) => api.memwiseGetPlugin(ws, pluginId!),
    c => pluginChangeMatches(c) || c.kind === 'run',
  )
}

/** A plugin's binding for the review screen: a draft (being bound), else the live one. */
export function useMemwiseBinding(pluginId: string | null, draftId?: string): MemwiseQuery<MwBindingView> {
  return useMemwiseQuery<MwBindingView>(
    pluginId ? `binding:${pluginId}:${draftId ?? ''}` : null,
    (api, ws) => api.memwiseGetBinding(ws, { pluginId: pluginId!, ...(draftId ? { draftId } : {}) }),
    // The dry run writes its report into the case; the draft changes on every save.
    (c, cur) => pluginChangeMatches(c) || draftChangeMatches(c, draftId ?? cur?.draftId)
      || (!!cur?.run && (c.kind === 'run' || c.kind === 'case') && (c.id === cur.run.runId || c.caseId === cur.run.caseId)),
  )
}

export function useMemwiseEntityRows(entity: string | null): MemwiseQuery<MwEntityRow[]> {
  return useMemwiseQuery<MwEntityRow[]>(
    entity ? `rows:${entity}` : null,
    (api, ws) => api.memwiseListEntities(ws, entity!),
    c => c.kind === 'plugins' || c.kind === 'run' || c.kind === 'definitions',
  )
}

export function useMemwiseEntityRecord(entity: string | null, id: string | null): MemwiseQuery<MwEntityRecord> {
  return useMemwiseQuery<MwEntityRecord>(
    entity && id ? `record:${entity}:${id}` : null,
    (api, ws) => api.memwiseGetEntityRecord(ws, { entity: entity!, id: id! }),
    c => c.kind === 'plugins',
  )
}

// ---------------------------------------------------------------- uploads

/** Base64 of a browser File, without the data-URL prefix. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Upload a picked file to the case's file store; resolves to its Document value. */
export function useMemwiseUpload(): (file: File) => Promise<import('@memwise/shared/protocol').MwDocument> {
  const store = useStore()
  return useCallback(async (file: File) => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api) throw new Error(i18n.t('memwise.notAvailable'))
    const data = await fileToBase64(file)
    return api.memwiseUploadFile(ws, { name: file.name, mime: file.type || 'application/octet-stream', data })
  }, [store])
}

// ---------------------------------------------------------------- chat

/** Wait briefly for a session the server just created to reach the session list. */
async function waitForSession(store: ReturnType<typeof useStore>, sessionId: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!store.get(sessionMetaMapAtom).has(sessionId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * Build a new playbook (no workflowId) or change one by chat: starts the meta playbook and opens
 * its chat. Resolves once the chat's session is in the session list.
 */
export function useMemwiseBuildPlaybook(): (input: MwBuildPlaybookInput) => Promise<MwBuildPlaybookResult | null> {
  const store = useStore()
  return useCallback(async (input) => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api || typeof api.memwiseBuildPlaybook !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
    const result = await api.memwiseBuildPlaybook(ws, input)
    await waitForSession(store, result.sessionId)
    return result
  }, [store])
}

/**
 * Open the regular chat anchored to a case, step or playbook (09 §1). The server creates the
 * session; wait briefly for it to reach the session list so navigation doesn't drop the detail.
 */
export function useMemwiseOpenChat(): (anchor: import('@memwise/shared/protocol').MwOpenChatInput['anchor']) => Promise<string | null> {
  const store = useStore()
  return useCallback(async (anchor) => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api) return null
    const { sessionId } = await api.memwiseOpenChat(ws, { anchor })
    await waitForSession(store, sessionId)
    return sessionId
  }, [store])
}

// ---------------------------------------------------------------- external links, public address (Phase 5)

/** The Phase 5 calls, bound to the workspace; absent methods (an older server) answer "not available". */
export interface MemwiseExternalCalls {
  issue: (input: MwIssueLinkInput) => Promise<MwIssuedLink>
  revoke: (linkId: string) => Promise<MwSubmitResult>
  previewResend: (input: MwResendInput) => Promise<MwResendPreview | { message: string }>
  resend: (input: MwResendInput) => Promise<MwResendResult>
  extract: (input: MwExtractInput) => Promise<MwExtractResult>
}

/** Whether this host offers the Phase 5 link calls at all. */
export function hasExternalCalls(api: MemwiseApi | null = getMemwiseApi()): boolean {
  return !!api && typeof api.memwiseIssueExternalLink === 'function'
}

export function useMemwiseExternal(): MemwiseExternalCalls {
  const store = useStore()
  return useMemo(() => {
    const need = () => {
      const ws = store.get(memwiseWorkspaceIdAtom)
      const api = getMemwiseApi()
      if (!ws || !api || !hasExternalCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return { ws, api }
    }
    return {
      issue: async input => { const { ws, api } = need(); return api.memwiseIssueExternalLink(ws, input) },
      revoke: async linkId => { const { ws, api } = need(); return api.memwiseRevokeExternalLink(ws, linkId) },
      previewResend: async input => { const { ws, api } = need(); return api.memwisePreviewResend(ws, input) },
      resend: async input => { const { ws, api } = need(); return api.memwiseResendExternalLink(ws, input) },
      extract: async input => {
        const ws = store.get(memwiseWorkspaceIdAtom)
        const api = getMemwiseApi()
        if (!ws || !api || typeof api.memwiseExtract !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
        return api.memwiseExtract(ws, input)
      },
    }
  }, [store])
}

export interface MemwisePublicAddress {
  relay: MwRelayStatus | null
  channels: MwChannelsAvailable | null
  notify: MwNotifySettings | null
  /** This host has no Phase 5 calls (an older server). */
  unsupported: boolean
  error: string | null
  loading: boolean
  reload: () => void
}

/** Settings → Public address: the relay's state, the bound channels and the person's notifications. Refetches on `relay`, `external` and `status` pushes. */
export function useMemwisePublicAddress(): MemwisePublicAddress {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const api = getMemwiseApi()
  const unsupported = !api || typeof api.memwiseRelayStatus !== 'function'
  const query = useMemwiseQuery<{ relay: MwRelayStatus; channels: MwChannelsAvailable | null; notify: MwNotifySettings | null }>(
    workspaceId && !unsupported ? `public-address:${workspaceId}` : null,
    async (a, ws) => {
      const [relay, channels, notify] = await Promise.all([
        a.memwiseRelayStatus(ws),
        a.memwiseChannelsAvailable(ws).catch(() => null),
        a.memwiseGetNotifySettings(ws).catch(() => null),
      ])
      return { relay, channels, notify }
    },
    c => c.kind === 'relay' || c.kind === 'external' || c.kind === 'status' || c.kind === 'plugins',
  )
  return {
    relay: query.data?.relay ?? null,
    channels: query.data?.channels ?? null,
    notify: query.data?.notify ?? null,
    unsupported,
    error: query.error,
    loading: query.loading,
    reload: query.reload,
  }
}
