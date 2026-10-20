/**
 * The Plugins navigator: installed plugins with their binding state, the domain's records (one
 * row per entity type, opening the records with their outside links), and the Install dialog.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Database, FolderOpen, Plus, Puzzle } from 'lucide-react'
import type { MwEntityType, MwInstallableSource, MwInstallChoices, MwPluginSummary } from '@memwise/shared/protocol'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseEntityTypesAtom, memwiseInstallPluginDialogAtom, memwisePluginsAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseRefresh } from '@/hooks/useMemwise'
import { MemwiseStatusBanner } from '../MemwiseStatus'
import { humanize } from '../format'
import { bindingBadge, sortPlugins, trustLabel, type BadgeTone } from './plugin-model'

const TONE_BADGE: Record<BadgeTone, string> = {
  default: 'bg-fill-hover text-secondary',
  success: 'bg-success-tint text-success',
  warning: 'bg-info-tint text-info',
  destructive: 'bg-destructive-tint text-destructive',
  muted: 'bg-fill-hover text-tertiary',
}

function GroupHeader({ children }: { children: React.ReactNode }) {
  return <div className="px-4 pt-3 pb-1 text-label-sm font-semibold text-tertiary">{children}</div>
}

function ListSkeleton() {
  return (
    <div className="space-y-3 px-4 py-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  )
}

export interface PluginsListProps {
  plugins: MwPluginSummary[] | null
  entityTypes?: MwEntityType[] | null
  selectedPluginId?: string | null
  selectedEntity?: string | null
  onSelect: (pluginId: string) => void
  onSelectEntity?: (entity: string) => void
  /** Absent: no Install button (the connection may not install). */
  onInstall?: () => void
  className?: string
}

/** One line under a plugin's title: "v1.0.0 · Verified · 4 tools · provides crm.contacts". */
function pluginSubtitle(p: MwPluginSummary, t: ReturnType<typeof useTranslation>['t']): string {
  return [
    t('memwise.plugins.versionShort', { version: p.version }),
    trustLabel(p.trust, t),
    t('memwise.plugins.toolCount', { count: p.tools }),
    ...(p.provides.length ? [t('memwise.plugins.providesList', { list: p.provides.join(', ') })] : []),
    ...(p.requires.length ? [t('memwise.plugins.requiresList', { list: p.requires.join(', ') })] : []),
  ].join(' · ')
}

export function PluginsList({ plugins, entityTypes, selectedPluginId, selectedEntity, onSelect, onSelectEntity, onInstall, className }: PluginsListProps) {
  const { t } = useTranslation()
  if (plugins === null) return <ListSkeleton />
  const types = entityTypes ?? []
  if (plugins.length === 0 && types.length === 0) {
    return (
      <EntityListEmptyScreen
        icon={<Puzzle />}
        title={t('memwise.plugins.emptyTitle')}
        description={t('memwise.plugins.emptyDescription')}
        className={cn('flex-1', className)}
      >
        {onInstall && (
          <Button variant="secondary" onClick={onInstall} data-action="install-plugin">
            <Plus />
            {t('memwise.plugins.install')}
          </Button>
        )}
      </EntityListEmptyScreen>
    )
  }
  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="pt-1 pb-2" data-list-role="memwise-plugins">
        <div data-list-group="plugins">
          <div className="flex items-center justify-between pr-2">
            <GroupHeader>{t('memwise.nav.plugins')}</GroupHeader>
            {onInstall && (
              <Button variant="ghost" size="sm" className="mt-2" onClick={onInstall} data-action="install-plugin">
                <Plus />
                {t('memwise.plugins.install')}
              </Button>
            )}
          </div>
          {plugins.length === 0 && <p className="px-4 py-2 text-label text-tertiary">{t('memwise.plugins.none')}</p>}
          {sortPlugins(plugins).map(p => {
            const badge = bindingBadge(p, t)
            return (
              <EntityRow
                key={p.id}
                isSelected={selectedPluginId === p.id}
                onClick={() => onSelect(p.id)}
                icon={<Puzzle className="h-3.5 w-3.5 text-foreground/60" />}
                title={p.title}
                subtitle={pluginSubtitle(p, t)}
                titleTrailing={<EntityListBadge colorClass={TONE_BADGE[badge.tone]}>{badge.label}</EntityListBadge>}
                dataAttributes={{ 'data-plugin': p.id, 'data-binding-status': p.binding.status }}
              />
            )
          })}
        </div>
        {onSelectEntity && types.length > 0 && (
          <div data-list-group="records">
            <GroupHeader>{t('memwise.records.group')}</GroupHeader>
            {types.map(e => (
              <EntityRow
                key={e.name}
                isSelected={selectedEntity === e.name}
                onClick={() => onSelectEntity(e.name)}
                icon={<Database className="h-3.5 w-3.5 text-foreground/60" />}
                title={humanize(e.name)}
                subtitle={t('memwise.records.fieldCount', { count: e.fields.length })}
                dataAttributes={{ 'data-entity': e.name }}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

export function PluginsListPanel({ selectedPluginId, selectedEntity }: { selectedPluginId?: string | null; selectedEntity?: string | null }) {
  const plugins = useAtomValue(memwisePluginsAtom)
  const entityTypes = useAtomValue(memwiseEntityTypesAtom)
  const [, setInstall] = useAtom(memwiseInstallPluginDialogAtom)
  const api = getMemwiseApi()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MemwiseStatusBanner className="mx-3 mt-1 mb-2" />
      <PluginsList
        plugins={plugins}
        entityTypes={entityTypes}
        selectedPluginId={selectedPluginId}
        selectedEntity={selectedEntity}
        onSelect={id => navigate(routes.view.plugins(id))}
        onSelectEntity={entity => navigate(routes.view.records(entity))}
        onInstall={typeof api?.memwiseInstallPlugin === 'function' ? () => setInstall(true) : undefined}
      />
      <InstallPluginDialog />
    </div>
  )
}

// ---------------------------------------------------------------- install

export interface InstallPluginDialogViewProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null while loading. */
  choices: MwInstallChoices | null
  error?: string | null
  /** Installs the plugin folder; resolves to an error message, or null when it was installed. */
  install: (path: string) => Promise<string | null>
}

function SourceRow({ source, selected, onSelect }: { source: MwInstallableSource; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-fill-hover',
        selected && 'bg-fill-selected ring-1 ring-accent/40',
      )}
      data-install-source={source.slug}
    >
      <Puzzle className="mt-0.5 size-4 shrink-0 text-secondary" />
      <span className="min-w-0 flex-1">
        <span className="block text-label font-medium text-foreground">{source.name}</span>
        {source.description && <span className="block text-label-sm text-secondary">{source.description}</span>}
        {source.pluginId && <span className="block font-mono text-label-sm text-tertiary">{source.pluginId}</span>}
      </span>
      {source.installed && (
        <EntityListBadge colorClass="bg-fill-hover text-tertiary">{t('memwise.plugins.installedVersion', { version: source.installed })}</EntityListBadge>
      )}
    </button>
  )
}

/** "Install a plugin": the examples shipped with the app, the workspace's MCP connectors, or (desktop) a folder. */
export function InstallPluginDialogView({ open, onOpenChange, choices, error, install }: InstallPluginDialogViewProps) {
  const { t } = useTranslation()
  const [picked, setPicked] = React.useState<string | null>(null)
  const [path, setPath] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setPicked(null)
    setPath('')
    setFailed(null)
  }, [open])

  const target = path.trim() || picked
  const run = async () => {
    if (!target) return
    setBusy(true)
    setFailed(null)
    try {
      const message = await install(target)
      if (message) setFailed(message)
    } finally {
      setBusy(false)
    }
  }

  const group = (title: string, list: MwInstallableSource[], kind: string) => list.length > 0 && (
    <div className="space-y-1" data-install-group={kind}>
      <div className="px-1 text-label-sm font-semibold text-tertiary">{title}</div>
      {list.map(s => (
        <SourceRow key={`${kind}:${s.slug}`} source={s} selected={!path.trim() && picked === s.dir} onSelect={() => { setPicked(s.dir); setPath('') }} />
      ))}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('memwise.plugins.installTitle')}</DialogTitle>
          <DialogDescription>{t('memwise.plugins.installDescription')}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-label text-destructive" role="alert">{error}</p>
        ) : !choices ? (
          <ListSkeleton />
        ) : !choices.canInstall ? (
          <p className="text-label text-secondary">{t('memwise.plugins.ownerOnly')}</p>
        ) : (
          <div className="max-h-[50vh] space-y-4 overflow-y-auto">
            {group(t('memwise.plugins.examples'), choices.examples, 'examples')}
            {group(t('memwise.plugins.connectors'), choices.sources, 'sources')}
            {choices.examples.length === 0 && choices.sources.length === 0 && !choices.canInstallPath && (
              <p className="text-label text-tertiary">{t('memwise.plugins.nothingToInstall')}</p>
            )}
            {choices.canInstallPath && (
              <div className="space-y-1.5">
                <label htmlFor="memwise-plugin-path" className="flex items-center gap-1.5 text-label-sm font-semibold text-tertiary">
                  <FolderOpen className="size-3.5" />
                  {t('memwise.plugins.fromFolder')}
                </label>
                <Input
                  id="memwise-plugin-path"
                  value={path}
                  onChange={e => setPath(e.target.value)}
                  placeholder={t('memwise.plugins.folderPlaceholder')}
                  className="font-mono text-label-sm"
                />
              </div>
            )}
          </div>
        )}
        {failed && <p className="text-label-sm text-destructive" role="alert">{failed}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void run()} disabled={!target || busy || !choices?.canInstall} data-action="confirm-install">
            {busy ? t('memwise.plugins.installing') : t('memwise.plugins.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InstallPluginDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useAtom(memwiseInstallPluginDialogAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const refresh = useMemwiseRefresh()
  const [choices, setChoices] = React.useState<MwInstallChoices | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    const api = getMemwiseApi()
    setChoices(null)
    setError(null)
    if (!api || !workspaceId || typeof api.memwiseListInstallChoices !== 'function') {
      setError(t('memwise.notAvailable'))
      return
    }
    let stale = false
    api.memwiseListInstallChoices(workspaceId)
      .then(c => { if (!stale) setChoices(c) })
      .catch(err => { if (!stale) setError(err instanceof Error ? err.message : String(err)) })
    return () => { stale = true }
  }, [open, workspaceId, t])

  const install = async (path: string): Promise<string | null> => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) return t('memwise.notAvailable')
    try {
      const plugin = await api.memwiseInstallPlugin(workspaceId, { path })
      toast.success(t('memwise.plugins.installed', { title: plugin.title, version: plugin.version }))
      setOpen(false)
      void refresh()
      navigate(routes.view.plugins(plugin.id))
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  return <InstallPluginDialogView open={open} onOpenChange={setOpen} choices={choices} error={error} install={install} />
}
