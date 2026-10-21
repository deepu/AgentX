/**
 * The Stage 5 screens the shell mounts in its right column (docs/memwise/26-projects-and-pages.md
 * §7, §8): each loads its data through the Stage 5 hooks and hands it to its presentational view.
 * A project is a domain for now (`projectId` is the domain id). Until the shell's `mw/{projectId}/…`
 * routes land, they open each other through the `domains` navigator's `regulated` detail; every
 * navigation is a prop the shell can replace.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type { MwAuditQuery, MwChangeSignResult } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { navigate, routes } from '@/lib/navigate'
import { memwiseDomainsAtom, memwiseRolesAtom, memwiseStatusAtom } from '@/atoms/memwise'
import { downloadBase64 } from '@/hooks/useMemwiseRecords'
import {
  useMemwiseAuditLog, useMemwiseChangeRequest, useMemwiseInspectorLinks, useMemwiseInspectorQuestions, useMemwiseRegulatedCalls, useMemwiseTmfIndex,
} from '@/hooks/useMemwiseRegulated'
import { humanize, resultMessage, roleTitle } from '../format'
import { AuditTrailView } from './AuditTrailView'
import { ChangeRequestView } from './ChangeRequestView'
import { InspectorSetupView } from './InspectorSetupView'
import { TmfIndexView } from './TmfIndexView'
import { signResultForForm } from './regulated-model'

/** Where the screens go: each defaults to the interim `domains` routes. */
export interface RegulatedNavigation {
  openChangeRequest?: (projectId: string, crId: string) => void
  openAuditTrail?: (projectId: string, record?: { entity: string; recordId: string }) => void
  openInspectors?: (projectId: string) => void
  openTmfZone?: (projectId: string, zoneId: string | null) => void
  openRecord?: (entity: string, recordId: string) => void
  openCase?: (caseId: string) => void
  openPlaybook?: (workflowId: string) => void
  openSession?: (sessionId: string) => void
}

export const defaultRegulatedNavigation: Required<RegulatedNavigation> = {
  openChangeRequest: (domain, crId) => navigate(routes.view.domains({ type: 'regulated', domain, screen: 'change', id: crId })),
  openAuditTrail: (domain, record) => navigate(routes.view.domains({ type: 'regulated', domain, screen: 'audit', ...(record ? { id: `${record.entity}:${record.recordId}` } : {}) })),
  openInspectors: domain => navigate(routes.view.domains({ type: 'regulated', domain, screen: 'inspectors' })),
  openTmfZone: (domain, zone) => navigate(routes.view.domains({ type: 'regulated', domain, screen: 'tmf', ...(zone ? { id: zone } : {}) })),
  openRecord: (entity, recordId) => navigate(routes.view.record(entity, recordId)),
  openCase: caseId => navigate(routes.view.cases(caseId)),
  openPlaybook: workflowId => navigate(routes.view.playbooks(workflowId)),
  openSession: sessionId => navigate(routes.view.allSessions(sessionId), { newPanel: true }),
}

const nav = (given?: RegulatedNavigation): Required<RegulatedNavigation> => ({ ...defaultRegulatedNavigation, ...given })

/** The project's name: the domain's, for now. */
function useProjectName(projectId: string): string {
  const domains = useAtomValue(memwiseDomainsAtom)
  return domains?.find(d => d.id === projectId)?.name ?? humanize(projectId)
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------- change request (EChange)

export interface ChangeRequestScreenProps {
  projectId: string
  /** The request's id or its label (`CR-014`). */
  crId: string
  navigation?: RegulatedNavigation
}

export function ChangeRequestScreen({ projectId, crId, navigation }: ChangeRequestScreenProps) {
  const { t } = useTranslation()
  const go = React.useMemo(() => nav(navigation), [navigation])
  const { data: cr, error, loading, reload } = useMemwiseChangeRequest(projectId, crId)
  const calls = useMemwiseRegulatedCalls()
  const roles = useAtomValue(memwiseRolesAtom)
  const me = useAtomValue(memwiseStatusAtom)?.me
  const signer = React.useMemo(() => (me ? { name: me.name, ...(me.roles[0] ? { role: roleTitle(me.roles[0], roles) ?? me.roles[0] } : {}) } : undefined), [me, roles])
  const id = cr?.id

  const actions = React.useMemo(() => (id ? {
    saveReason: async (reason: string) => { await calls.updateChange({ crId: id, reason }); reload() },
    validate: async () => {
      const v = await calls.validateChange({ crId: id })
      reload()
      return v
    },
    sign: async (password: string): Promise<MwChangeSignResult> => {
      const r = await calls.signChange({ crId: id, password })
      if (r.applied) {
        toast.success(r.published
          ? t('memwise.regulated.change.publishedToast', { version: r.published.version })
          : t('memwise.regulated.change.sentToast'))
        reload()
      } else if (!['signature-failed', 'locked', 'password-not-set'].includes(r.status)) {
        // The dialog words its own codes; the rest close it and show here.
        toast.error(resultMessage(signResultForForm(r), t) ?? r.status)
      }
      return r
    },
    withdraw: async () => { await calls.withdrawChange({ crId: id }); reload() },
    openChat: () => {
      void calls.changeChat({ crId: id }).then(r => go.openSession(r.sessionId), err => toast.error(t('memwise.regulated.change.chatFailed'), { description: errorText(err) }))
    },
    openPlaybook: go.openPlaybook,
    openCase: go.openCase,
  } : undefined), [id, calls, reload, t, go])

  return (
    <Info_Page loading={loading && !cr} error={!cr && error ? error : undefined} empty={!loading && !error && !cr ? t('memwise.regulated.change.missing') : undefined}>
      {cr && <ChangeRequestView cr={cr} {...(actions ? { actions } : {})} {...(signer ? { signer } : {})} />}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- audit trail (EAudit)

export interface AuditTrailScreenProps {
  projectId: string
  /** One record's trail (both, or neither). */
  entity?: string
  recordId?: string
  navigation?: RegulatedNavigation
}

export function AuditTrailScreen({ projectId, entity, recordId, navigation }: AuditTrailScreenProps) {
  const go = React.useMemo(() => nav(navigation), [navigation])
  const projectName = useProjectName(projectId)
  const [peopleAndAi, setPeopleAndAi] = React.useState(false)
  const query = React.useMemo<MwAuditQuery>(() => ({
    project: projectId,
    ...(entity && recordId ? { entity, recordId } : {}),
    ...(peopleAndAi ? { actorKinds: ['person', 'ai'] } : {}),
    limit: 500,
  }), [projectId, entity, recordId, peopleAndAi])
  const { data, error, loading } = useMemwiseAuditLog(query)
  const calls = useMemwiseRegulatedCalls()
  const scoped = !!(entity && recordId)
  const label = scoped ? data?.entries.find(e => e.recordTitle)?.recordTitle ?? recordId! : ''

  return (
    <Info_Page loading={loading && !data} error={!data && error ? error : undefined}>
      {data && (
        <AuditTrailView
          projectName={projectName}
          log={data}
          {...(scoped ? { scope: { label, onClear: () => go.openAuditTrail(projectId) } } : {})}
          peopleAndAi={peopleAndAi}
          onPeopleAndAi={setPeopleAndAi}
          onExport={async () => {
            const { actorKinds: _all, ...whole } = query
            const file = await calls.exportAuditLog(whole)
            downloadBase64(file.name, file.mime, file.dataBase64)
          }}
          onVerify={() => calls.verifyAuditLog({ project: projectId })}
          openRecord={go.openRecord}
        />
      )}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- inspector access (EInspector setup)

export interface InspectorSetupProps {
  projectId: string
  /** The name the new link's form offers ("MHRA inspection"). */
  suggestedName?: string
  navigation?: RegulatedNavigation
}

export function InspectorSetup({ projectId, suggestedName, navigation }: InspectorSetupProps) {
  const { t } = useTranslation()
  const go = React.useMemo(() => nav(navigation), [navigation])
  const projectName = useProjectName(projectId)
  const links = useMemwiseInspectorLinks(projectId)
  const questions = useMemwiseInspectorQuestions(projectId)
  const calls = useMemwiseRegulatedCalls()
  const reload = React.useCallback(() => { links.reload(); questions.reload() }, [links, questions])
  const actions = React.useMemo(() => ({
    create: async (input: { name: string; inspectors: { name: string; email?: string; organisation?: string }[]; expiresAt: string }) => {
      const r = await calls.createInspectorLink({ project: projectId, ...input })
      reload()
      return r
    },
    revoke: async (linkId: string) => { await calls.revokeInspectorLink({ linkId }); reload() },
    extend: async (linkId: string, expiresAt: string) => { await calls.extendInspectorLink({ linkId, expiresAt }); reload() },
    answer: async (questionId: string, answer: string) => {
      await calls.answerInspectorQuestion({ questionId, answer })
      toast.success(t('memwise.regulated.inspectors.answered'))
      reload()
    },
    copy: (text: string) => navigator.clipboard.writeText(text),
    openPublicAddress: () => navigate(routes.view.settings('publicAddress')),
    openRecord: go.openRecord,
  }), [calls, projectId, reload, t, go])

  const loading = (links.loading && !links.data) || (questions.loading && !questions.data)
  const error = links.error ?? questions.error
  return (
    <Info_Page loading={loading} error={!links.data && error ? error : undefined}>
      {links.data && (
        <InspectorSetupView
          projectName={projectName}
          links={links.data}
          questions={questions.data ?? []}
          actions={actions}
          {...(suggestedName ? { suggestedName } : {})}
        />
      )}
    </Info_Page>
  )
}

// ---------------------------------------------------------------- TMF index (EIndex)

export interface TmfIndexScreenProps {
  projectId: string
  /** A zone's sub-page (`site-management`). */
  zoneId?: string | null
  navigation?: RegulatedNavigation
}

export function TmfIndexScreen({ projectId, zoneId, navigation }: TmfIndexScreenProps) {
  const go = React.useMemo(() => nav(navigation), [navigation])
  const { data, error, loading } = useMemwiseTmfIndex(projectId, zoneId ?? null)
  return (
    <Info_Page loading={loading && !data} error={!data && error ? error : undefined}>
      {data && <TmfIndexView index={data} onZone={zone => go.openTmfZone(projectId, zone)} openRecord={go.openRecord} />}
    </Info_Page>
  )
}
