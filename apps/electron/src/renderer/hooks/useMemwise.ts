/**
 * MemWise data hooks.
 *
 * useMemwiseData (mounted once, by MemwiseHost) loads the status, people, inbox, cases and
 * playbooks for the active workspace and refetches them when `memwise:changed` says what
 * changed. Detail views (a case, a playbook, live counts, a step record) use the smaller
 * useMemwise* hooks below, which refetch on the same pushes through memwiseLastChangeAtom.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type {
  MwCase,
  MwChange,
  MwLiveCounts,
  MwPlaybook,
  MwStatus,
  MwStepRecord,
} from '@memwise/shared/protocol'
import {
  memwiseAvailableAtom,
  memwiseCasesAtom,
  memwiseInboxAtom,
  memwiseLastChangeAtom,
  memwisePeopleAtom,
  memwisePlaybooksAtom,
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

/** Which lists a pushed change affects. */
export function affectedByChange(change: MwChange): { status: boolean; inbox: boolean; cases: boolean; playbooks: boolean } {
  switch (change.kind) {
    case 'status': return { status: true, inbox: true, cases: true, playbooks: true }
    case 'definitions': return { status: true, inbox: false, cases: false, playbooks: true }
    case 'inbox': return { status: false, inbox: true, cases: false, playbooks: true }
    case 'run':
    case 'case': return { status: false, inbox: true, cases: true, playbooks: true }
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

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

  // Initial load per workspace
  useEffect(() => {
    setWorkspaceId(workspaceId ?? null)
    setInbox(null)
    setCases(null)
    setPlaybooks(null)
    setStatus(null)
    if (!workspaceId) return
    const api = getMemwiseApi()
    setAvailable(!!api)
    if (!api) {
      setInbox([])
      setCases([])
      setPlaybooks([])
      return
    }
    let stale = false
    void (async () => {
      await loadStatus(workspaceId, api)
      if (stale) return
      await Promise.all([loadInbox(workspaceId, api), loadCases(workspaceId, api), loadPlaybooks(workspaceId, api)])
    })()
    return () => { stale = true }
  }, [workspaceId, setWorkspaceId, setAvailable, setStatus, setInbox, setCases, setPlaybooks, loadStatus, loadInbox, loadCases, loadPlaybooks])

  // While the kernel starts, poll the status until it's ready (pushes may not flow yet).
  const status = useAtomValue(memwiseStatusAtom)
  useEffect(() => {
    if (!workspaceId || !status || status.ready) return
    const api = getMemwiseApi()
    if (!api) return
    const timer = setTimeout(async () => {
      const next = await loadStatus(workspaceId, api)
      if (next?.ready) {
        await Promise.all([loadInbox(workspaceId, api), loadCases(workspaceId, api), loadPlaybooks(workspaceId, api)])
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [workspaceId, status, loadStatus, loadInbox, loadCases, loadPlaybooks])

  // Live updates: one subscription; bursts of pushes are coalesced into one refetch per list.
  const pending = useRef({ status: false, inbox: false, cases: false, playbooks: false })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    if (!workspaceId) return
    const api = getMemwiseApi()
    if (!api || typeof api.onMemwiseChanged !== 'function') return
    const flush = () => {
      timer.current = null
      const p = pending.current
      pending.current = { status: false, inbox: false, cases: false, playbooks: false }
      if (store.get(memwiseWorkspaceIdAtom) !== workspaceId) return
      if (p.status) void loadStatus(workspaceId, api)
      if (p.inbox) void loadInbox(workspaceId, api)
      if (p.cases) void loadCases(workspaceId, api)
      if (p.playbooks) void loadPlaybooks(workspaceId, api)
    }
    const off = api.onMemwiseChanged((change: MwChange) => {
      setLastChange({ seq: ++seq.current, change })
      const a = affectedByChange(change)
      const p = pending.current
      pending.current = { status: p.status || a.status, inbox: p.inbox || a.inbox, cases: p.cases || a.cases, playbooks: p.playbooks || a.playbooks }
      if (!timer.current) timer.current = setTimeout(flush, 150)
    })
    return () => {
      if (typeof off === 'function') off()
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [workspaceId, store, setLastChange, loadStatus, loadInbox, loadCases, loadPlaybooks])
}

/** Reload the inbox and cases now (after the person acted), without waiting for a push. */
export function useMemwiseRefresh(): () => Promise<void> {
  const store = useStore()
  const setInbox = useSetAtom(memwiseInboxAtom)
  const setCases = useSetAtom(memwiseCasesAtom)
  const setPlaybooks = useSetAtom(memwisePlaybooksAtom)
  return useCallback(async () => {
    const ws = store.get(memwiseWorkspaceIdAtom)
    const api = getMemwiseApi()
    if (!ws || !api) return
    const [inbox, cases, playbooks] = await Promise.allSettled([
      api.memwiseListInbox(ws),
      api.memwiseListCases(ws, {}),
      api.memwiseListPlaybooks(ws),
    ])
    if (inbox.status === 'fulfilled') setInbox(inbox.value)
    if (cases.status === 'fulfilled') setCases(cases.value)
    if (playbooks.status === 'fulfilled') setPlaybooks(playbooks.value)
  }, [store, setInbox, setCases, setPlaybooks])
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

export function useMemwiseCase(caseId: string | null): MemwiseQuery<MwCase> {
  return useMemwiseQuery<MwCase>(
    caseId ? `case:${caseId}` : null,
    (api, ws) => api.memwiseGetCase(ws, caseId!),
    (c, cur) => (c.kind === 'run' || c.kind === 'case' || c.kind === 'inbox')
      && (!c.id || c.id === caseId || c.id === cur?.runId),
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

export function useMemwiseStepRecord(stepRunId: string | null): MemwiseQuery<MwStepRecord> {
  return useMemwiseQuery<MwStepRecord>(
    stepRunId ? `step:${stepRunId}` : null,
    (api, ws) => api.memwiseGetStepRecord(ws, stepRunId!),
    (c, cur) => (c.kind === 'run' || c.kind === 'case') && (!c.id || c.id === cur?.runId || c.id === cur?.caseId),
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
    if (!ws || !api) throw new Error('MemWise is not available')
    const data = await fileToBase64(file)
    return api.memwiseUploadFile(ws, { name: file.name, mime: file.type || 'application/octet-stream', data })
  }, [store])
}

// ---------------------------------------------------------------- chat

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
    const deadline = Date.now() + 3000
    while (!store.get(sessionMetaMapAtom).has(sessionId) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return sessionId
  }, [store])
}
