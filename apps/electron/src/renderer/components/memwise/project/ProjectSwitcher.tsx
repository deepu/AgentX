/**
 * The project switcher (doc 26 §2, mock `XSwitch`): the open project with its app above it, and a
 * menu with "Find a project", Waiting for you across all projects, the projects grouped by app
 * with their waiting counts (a draft tagged), the app home under each app ("All studies"), and
 * "+ New project" / "+ Add an app" (Stage 3).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, Folder, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { ALL_PROJECTS } from '../../../../shared/project-route'
import type { ShellApp, ShellProject } from './project-model'

export interface ProjectSwitcherProps {
  apps: ShellApp[]
  current: ShellProject
  totalWaiting: number
  /** Stage 3: "+ New project" and "+ Add an app"; shown disabled until then. */
  onNewProject?: () => void
  onAddApp?: () => void
}

export function ProjectSwitcher({ apps, current, totalWaiting, onNewProject, onAddApp }: ProjectSwitcherProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const q = query.trim().toLowerCase()
  const shown = apps
    .map(a => ({ ...a, projects: a.projects.filter(p => !q || p.name.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) }))
    .filter(a => a.projects.length > 0)
  const go = (route: string) => { setOpen(false); setQuery(''); navigate(route as Parameters<typeof navigate>[0]) }
  // The app line only says something when the project's name differs from its app's.
  const appLine = current.appName !== current.name ? current.appName : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="project-switcher"
          className="flex w-full items-center gap-2.5 rounded-[10px] border border-foreground/10 bg-background px-2.5 py-2 text-left shadow-minimal hover:bg-fill-hover"
        >
          <AppIcon name={current.appName} />
          <span className="min-w-0 flex-1">
            {appLine && <span className="block truncate text-caption text-tertiary">{appLine}</span>}
            <span className="block truncate text-label font-semibold text-foreground">{current.name}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-tertiary" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[310px] p-2" data-testid="project-switcher-menu">
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('memwise.shell.findProject')}
          className="mb-1 w-full rounded-md border border-foreground/10 bg-background px-2.5 py-1.5 text-label outline-none placeholder:text-tertiary focus:border-accent/50"
        />
        <button
          type="button"
          onClick={() => go(routes.view.project(ALL_PROJECTS, { type: 'waiting' }))}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-label font-semibold hover:bg-fill-hover"
        >
          <span className="flex-1">{t('memwise.shell.waitingAll')}</span>
          {totalWaiting > 0 && <Count n={totalWaiting} />}
        </button>
        <div className="my-1 h-px bg-foreground/8" />
        <div className="max-h-[50vh] overflow-y-auto">
          {shown.map(app => (
            <div key={app.id} className="mb-1">
              {(app.projects.length !== 1 || app.projects[0]?.name !== app.name || !!app.home) && (
                <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-label-sm font-medium text-secondary">
                  <AppIcon name={app.name} small />
                  <span className="truncate">{app.name}</span>
                </div>
              )}
              {app.projects.map(p => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`switch-project-${p.id}`}
                  onClick={() => go(routes.view.project(p.id))}
                  className={cn('flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left text-label hover:bg-fill-hover', p.id === current.id && 'bg-accent/10')}
                >
                  <span className="flex w-4 shrink-0 justify-center">{p.id === current.id && <Check className="size-3.5 text-accent" />}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.status === 'draft' && <Tag label={t('memwise.projects.status.draft')} />}
                  {p.status === 'archived' && <Tag label={t('memwise.projects.status.archived')} />}
                  {p.waiting > 0 && <Count n={p.waiting} />}
                </button>
              ))}
              {app.home && !q && (
                <button
                  type="button"
                  data-testid={`app-home-${app.id}`}
                  onClick={() => go(routes.view.project(ALL_PROJECTS, { type: 'app', appId: app.id }))}
                  className="flex w-full items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-left text-label text-accent hover:bg-fill-hover"
                >
                  {app.home.link ?? app.home.title}
                </button>
              )}
            </div>
          ))}
          {shown.length === 0 && <p className="px-2.5 py-2 text-label-sm text-tertiary">{t('memwise.shell.noProjectMatches')}</p>}
        </div>
        <div className="mt-1 flex gap-2 border-t border-foreground/8 pt-2">
          <SmallButton label={t('memwise.shell.newProject')} disabled={!onNewProject} title={onNewProject ? undefined : t('memwise.shell.newProjectSoon')} onClick={() => { setOpen(false); onNewProject?.() }} />
          <SmallButton label={t('memwise.shell.addApp')} disabled={!onAddApp} title={onAddApp ? undefined : t('memwise.shell.newProjectSoon')} onClick={() => { setOpen(false); onAddApp?.() }} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Tag({ label }: { label: string }) {
  return <span className="shrink-0 rounded-[4px] bg-fill-hover px-1.5 py-px text-caption text-secondary">{label}</span>
}

function Count({ n }: { n: number }) {
  return <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-caption font-semibold text-white tabular-nums">{n}</span>
}

function SmallButton({ label, disabled, title, onClick }: { label: string; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="flex items-center gap-1 rounded-md border border-foreground/12 px-2.5 py-1 text-label-sm text-foreground hover:bg-fill-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <Plus className="size-3" />
      {label}
    </button>
  )
}

/** A small tile for the app: its initials on a colour picked from its name. */
export function AppIcon({ name, small }: { name: string; small?: boolean }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md text-white', small ? 'size-4 rounded-[4px]' : 'size-6')}
      style={{ backgroundColor: `hsl(${hue} 55% 45%)` }}
      aria-hidden="true"
    >
      {small ? <span className="text-[8px] font-bold leading-none">{name.slice(0, 3).toUpperCase()}</span> : <Folder className="size-3.5" />}
    </span>
  )
}
