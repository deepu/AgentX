/**
 * The Stage 3 screens the shell mounts in the right column (26 §3): each fetches through the
 * project hooks, calls the host through useMemwiseProjectCalls, and goes elsewhere through the
 * MwProjectsNav the shell provides.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type { MwProjectPerson, MwTakeTemplateUpdateResult } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { memwisePlaybooksAtom, memwiseRolesAtom } from '@/atoms/memwise'
import {
  useMemwiseAppHome,
  useMemwiseProject,
  useMemwiseProjectCalls,
  useMemwiseProjects,
  useMemwiseTemplateReview,
  useMemwiseWaitingAll,
} from '@/hooks/useMemwiseProjects'
import { humanize } from '../format'
import { AppHomeView } from './AppHomeView'
import { NewProjectView, type NewProjectBusy, type NewProjectInput } from './NewProjectView'
import { ProjectSettingsView, type ProjectSettingsBusy } from './ProjectSettingsView'
import { TemplateUpdateView, type TemplateUpdateBusy } from './TemplateUpdateView'
import { WaitingAllView } from './WaitingAllView'
import { useProjectsNav } from './nav'
import { parseUpdateItemId } from './project-model'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Runs one call at a time with its busy flag; failures land in `error`. */
function useBusy<B extends string>() {
  const [busy, setBusy] = React.useState<B | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const run = React.useCallback(async <T,>(what: B, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(what)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(message(err))
      return undefined
    } finally {
      setBusy(null)
    }
  }, [])
  return { busy, error, run }
}

// ---------------------------------------------------------------- app home

export function AppHomeScreen({ appId }: { appId: string }) {
  const nav = useProjectsNav()
  const apps = useMemwiseProjects()
  const { data, error, loading } = useMemwiseAppHome(appId)
  const app = apps.data?.find((a) => a.id === appId)
  return (
    <Info_Page loading={loading && !data} error={!data && error ? error : undefined}>
      {data && <AppHomeView home={data} appTitle={app?.title} onOpenProject={nav.openProject} />}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- waiting, all projects

export function WaitingAllScreen() {
  const nav = useProjectsNav()
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const { data, error, loading } = useMemwiseWaitingAll()
  const title = React.useCallback((id: string) => playbooks?.find((p) => p.id === id)?.title, [playbooks])
  return (
    <Info_Page loading={loading && !data} error={!data && error ? error : undefined}>
      {data && (
        <WaitingAllView
          groups={data}
          playbookTitle={title}
          onOpenProject={nav.openProject}
          onOpenItem={nav.openItem}
          onReviewUpdate={(u) => nav.openTemplateUpdate(u.project, u.id)}
        />
      )}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- new project

export function NewProjectScreen({ appId, draftId: openDraft }: { appId: string; draftId?: string }) {
  const { t } = useTranslation()
  const nav = useProjectsNav()
  const calls = useMemwiseProjectCalls()
  const roles = useAtomValue(memwiseRolesAtom)
  const apps = useMemwiseProjects()
  const app = apps.data?.find((a) => a.id === appId)
  const [draftId, setDraftId] = React.useState<string | null>(openDraft ?? null)
  const [describing, setDescribing] = React.useState(false)
  // A draft this person makes while the page is open (here, or by describing it in the chat beside it).
  const [since] = React.useState(() => new Date(Date.now() - 1000).toISOString())
  const draft = useMemwiseProject(draftId)
  const { busy, error, run } = useBusy<NewProjectBusy>()

  React.useEffect(() => setDraftId(openDraft ?? null), [openDraft, appId])

  // "Describe it": the chat's first project_draft makes the draft; pick it up when it appears.
  React.useEffect(() => {
    if (draftId || !app) return
    const made = app.projects.find((p) => p.status === 'draft' && !!p.createdAt && p.createdAt >= since)
    if (made) { setDraftId(made.id); setDescribing(false) }
  }, [app, since, draftId])

  if (!app) {
    return <Info_Page loading={apps.loading || !apps.data} error={apps.data ? t('memwise.projects.notFound') : apps.error ?? undefined}>{null}</Info_Page>
  }
  const roleTitle = (id: string) => roles.find((r) => r.id === id)?.title ?? humanize(id)

  const create = (input: NewProjectInput) => void run('create', async () => {
    const p = await calls.create({ app: appId, ...input })
    setDraftId(p.id)
  })
  const describe = (request: string) => void run('describe', async () => {
    const r = await calls.describe({ app: appId, request })
    setDescribing(true)
    if (r.sessionId) nav.openChat(r.sessionId)
  })
  const start = () => void run('start', async () => {
    const p = await calls.start(draftId!)
    toast.success(t('memwise.projects.started', { name: p.name }))
    nav.openProject(p.id)
  })
  const discard = () => void run('discard', async () => {
    await calls.discard(draftId!)
    setDraftId(null)
    nav.openAppHome(appId)
  })

  return (
    <Info_Page loading={!!draftId && draft.loading && !draft.data} error={draftId && !draft.data && draft.error ? draft.error : undefined}>
      <NewProjectView
        app={app}
        draft={draftId ? draft.data : null}
        describing={describing}
        busy={busy}
        error={error}
        roleTitle={roleTitle}
        onCreate={create}
        onDescribe={describe}
        onDiscard={discard}
        onStart={start}
        onOpenSettings={draftId ? () => nav.openSettings(draftId) : undefined}
      />
    </Info_Page>
  )
}

// ---------------------------------------------------------------- project settings

export function ProjectSettingsScreen({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const nav = useProjectsNav()
  const calls = useMemwiseProjectCalls()
  const roles = useAtomValue(memwiseRolesAtom)
  const apps = useMemwiseProjects()
  const { data, error: loadError, loading, loaded, reload } = useMemwiseProject(projectId)
  const { busy, error, run } = useBusy<ProjectSettingsBusy>()
  const appTitle = (id: string) => apps.data?.find((a) => a.id === id)?.title ?? humanize(id)

  if (!data) {
    return <Info_Page loading={loading || !loaded} error={loadError ?? (loaded ? t('memwise.projects.notFound') : undefined)}>{null}</Info_Page>
  }
  const changePeople = (people: Omit<MwProjectPerson, 'personId'>[]) => void run('people', async () => {
    await calls.update({ projectId, people })
    reload()
  })
  return (
    <Info_Page>
      <ProjectSettingsView
        project={data}
        roles={roles}
        appTitle={appTitle}
        busy={busy}
        error={error}
        onReviewUpdate={data.update ? () => nav.openTemplateUpdate(projectId, `template-update:${projectId}:${data.update!.to}`) : undefined}
        onChangePeople={changePeople}
        onStart={() => void run('start', async () => { await calls.start(projectId); reload() })}
        onArchive={() => void run('archive', async () => { await calls.archive(projectId); reload() })}
        onDiscard={() => void run('discard', async () => { await calls.discard(projectId); nav.openAppHome(data.app) })}
        onSaveAsTemplate={() => void run('template', async () => {
          const r = await calls.saveAsTemplate({ projectId })
          toast.success(t('memwise.projects.settings.savedAsTemplate', { app: appTitle(r.app), version: r.version }))
        })}
      />
    </Info_Page>
  )
}

// ---------------------------------------------------------------- template update

export function TemplateUpdateScreen({ projectId, inboxItemId }: { projectId: string; inboxItemId: string }) {
  const { t } = useTranslation()
  const nav = useProjectsNav()
  const calls = useMemwiseProjectCalls()
  const [test, setTest] = React.useState(false)
  const [taken, setTaken] = React.useState<MwTakeTemplateUpdateResult | null>(null)
  const parsed = parseUpdateItemId(inboxItemId)
  const id = parsed && parsed.projectId !== projectId ? null : projectId
  const { data, error: loadError, loading, loaded } = useMemwiseTemplateReview(taken ? null : id, test)
  const [shown, setShown] = React.useState(data)
  const { busy, error, run } = useBusy<TemplateUpdateBusy>()
  React.useEffect(() => { if (data) setShown(data) }, [data])
  React.useEffect(() => { setTest(false); setTaken(null); setShown(null) }, [projectId, inboxItemId])

  const review = shown ?? data
  if (!review) {
    const gone = loaded && !loading && !loadError
    return <Info_Page loading={!gone && !loadError && (loading || !loaded || test)} error={loadError ?? (gone || !id ? t('memwise.projects.update.gone') : undefined)}>{null}</Info_Page>
  }
  return (
    <Info_Page>
      <TemplateUpdateView
        review={review}
        busy={test && loading ? 'test' : busy}
        error={error ?? (test && loadError ? loadError : null)}
        taken={taken}
        onTest={() => setTest(true)}
        onTake={() => void run('take', async () => {
          const r = await calls.takeUpdate(projectId)
          setTaken(r)
          toast.success(t('memwise.projects.update.taken', { version: r.version }))
        })}
        onSkip={() => void run('skip', async () => {
          await calls.skipUpdate(projectId)
          nav.openProject(projectId)
        })}
        onOpenProject={() => nav.openProject(projectId)}
      />
    </Info_Page>
  )
}
