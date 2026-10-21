/**
 * Project settings (doc 26 §2): what the project holds and its house rules, its automations, and
 * Advanced: the classic layout switch and every chat (the shell has no chat list of its own).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseDomainsAtom, memwisePlaybooksAtom } from '@/atoms/memwise'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import { Info_Page } from '@/components/info/Info_Page'
import { DomainView } from '../domains/DomainView'
import { AuditTrailScreen, InspectorSetup, RegulatedDomainLinks } from '../regulated'
import { AutomationsPage } from '../domains/DomainsPages'
import { relativeTime } from '../format'
import { useNow } from '../use-now'
import type { ShellProject } from './project-model'
import { saveShellLayout, shellLayoutAtom } from './useProjectShell'
import { setShellRouteRewriter } from './shell-routes'

const TABS = ['project', 'automations', 'inspectors', 'audit', 'advanced'] as const
type Tab = typeof TABS[number]
/** Tabs only a regulated project has (Stage 5): inspector access and the audit trail. */
const REGULATED_TABS: readonly Tab[] = ['inspectors', 'audit']
const CHATS_SHOWN = 60

export function ProjectSettingsPage({ project, tab }: { project: ShellProject; tab?: string }) {
  const { t } = useTranslation()
  const tabs = TABS.filter(k => project.regulated || !REGULATED_TABS.includes(k))
  const current: Tab = (tabs as readonly string[]).includes(tab ?? '') ? tab as Tab : 'project'
  const go = (next: Tab) => navigate(routes.view.project(project.id, { type: 'settings', ...(next === 'project' ? {} : { tab: next }) }))
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-settings">
      <div className="flex shrink-0 gap-1 border-b border-foreground/6 px-6 pt-3">
        {tabs.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => go(k)}
            className={cn('-mb-px border-b-2 px-2.5 pb-2 text-label', current === k ? 'border-foreground font-medium text-foreground' : 'border-transparent text-secondary hover:text-foreground')}
          >
            {t(`memwise.shell.settingsTab.${k}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {current === 'project' && <ProjectTab project={project} rules={tab === 'rules'} />}
        {current === 'automations' && <AutomationsPage domainId={project.id} />}
        {current === 'inspectors' && <InspectorSetup projectId={project.id} />}
        {current === 'audit' && <AuditTrailScreen projectId={project.id} />}
        {current === 'advanced' && <AdvancedTab />}
      </div>
    </div>
  )
}

function ProjectTab({ project, rules }: { project: ShellProject; rules: boolean }) {
  const domains = useAtomValue(memwiseDomainsAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const domain = domains?.find(d => d.id === project.id) ?? null
  return (
    <Info_Page loading={domains === null}>
      {domain && (
        <DomainView
          domain={domain}
          playbooks={playbooks}
          {...(rules ? { tab: 'rules' as const } : {})}
          onOpenEntities={entity => entity && navigate(routes.view.project(project.id, { type: 'records', entity }))}
          onOpenPlaybook={workflowId => navigate(routes.view.project(project.id, { type: 'playbook', workflowId }))}
          onOpenPage={pageId => navigate(routes.view.project(project.id, { type: 'dashboard', domain: domain.id, pageId }))}
          regulated={<RegulatedDomainLinks domain={domain} />}
        />
      )}
    </Info_Page>
  )
}

function AdvancedTab() {
  const { t } = useTranslation()
  const layout = useAtomValue(shellLayoutAtom)
  const setLayout = useSetAtom(shellLayoutAtom)
  const sessions = useAtomValue(sessionMetaMapAtom)
  const now = useNow()
  const chats = [...sessions.values()]
    .filter(s => !s.hidden)
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    .slice(0, CHATS_SHOWN)
  const classic = () => {
    saveShellLayout('classic')
    setLayout('classic')
    // The shell stops rewriting routes now, so the chat list opens as it is.
    setShellRouteRewriter(null)
    navigate(routes.view.allSessions())
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[680px] px-7 py-6">
        <h2 className="text-label font-semibold text-foreground">{t('memwise.shell.layoutTitle')}</h2>
        <p className="mt-1 text-label-sm text-secondary">{t('memwise.shell.layoutHint')}</p>
        <button
          type="button"
          data-testid="classic-layout"
          disabled={layout === 'classic'}
          onClick={classic}
          className="mt-3 rounded-md border border-foreground/15 px-3 py-1.5 text-label-sm hover:bg-fill-hover"
        >
          {t('memwise.shell.useClassic')}
        </button>

        <h2 className="mt-8 text-label font-semibold text-foreground">{t('memwise.shell.allChats')}</h2>
        <p className="mt-1 text-label-sm text-secondary">{t('memwise.shell.allChatsHint')}</p>
        <div className="mt-3 overflow-hidden rounded-[10px] border border-foreground/8">
          {chats.length === 0 && <p className="px-4 py-3 text-label-sm text-tertiary">{t('memwise.shell.noChats')}</p>}
          {chats.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => navigate(routes.view.allSessions(s.id))}
              className="flex w-full items-center gap-3 border-b border-foreground/6 px-4 py-2 text-left text-label last:border-b-0 hover:bg-fill-hover"
            >
              <span className="min-w-0 flex-1 truncate">{getSessionTitle(s)}</span>
              {s.lastMessageAt ? <span className="shrink-0 text-label-sm text-tertiary">{relativeTime(new Date(s.lastMessageAt).toISOString(), now)}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
