import * as React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { DatabaseZap } from 'lucide-react'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { deriveConnectionStatus } from '@/components/ui/source-status-indicator'
import { EntityPanel } from '@/components/ui/entity-panel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import type { LoadedSource, SourceConnectionStatus, SourceFilter } from '../../../shared/types'

/** Source type, shown as the row's trailing meta (MCP · API · Folder) */
const SOURCE_TYPE_LABEL_KEYS: Record<string, string> = {
  mcp: 'sourcesList.typeMcp',
  api: 'sourcesList.typeApi',
  local: 'sourcesList.typeLocal',
}

/** A state other than connected replaces the description on the second line, in its status color */
const SOURCE_STATUS_CONFIG: Record<SourceConnectionStatus, { labelKey: string; textClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', textClass: 'text-info' },
  failed: { labelKey: 'sourcesList.statusDisconnected', textClass: 'text-destructive' },
  untested: { labelKey: 'sourcesList.statusNotTested', textClass: 'text-tertiary' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', textClass: 'text-tertiary' },
}

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
}

export interface SourcesListPanelProps {
  sources: LoadedSource[]
  sourceFilter?: SourceFilter | null
  workspaceRootPath?: string
  onDeleteSource: (sourceSlug: string) => void
  onSourceClick: (source: LoadedSource) => void
  selectedSourceSlug?: string | null
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesListPanel({
  sources,
  sourceFilter,
  workspaceRootPath,
  onDeleteSource,
  onSourceClick,
  selectedSourceSlug,
  localMcpEnabled = true,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  const filteredSources = React.useMemo(() => {
    if (!sourceFilter) return sources
    return sources.filter(s => s.config.type === sourceFilter.sourceType)
  }, [sources, sourceFilter])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      const filterLabel = filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType
      return t('sourcesList.noSourcesOfType', { type: filterLabel })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  return (
    <>
    <EntityPanel<LoadedSource>
      items={filteredSources}
      getId={(s) => s.config.slug}
      selection={sourceSelection}
      selectedId={selectedSourceSlug}
      onItemClick={onSourceClick}
      className={className}
      containerProps={{ 'data-list-role': 'sources' }}
      emptyState={
        <EntityListEmptyScreen
          icon={<DatabaseZap />}
          title={emptyMessage}
          description={t('sourcesList.emptyDescription')}
          docKey="sources"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <Button variant="secondary">
                  {t('sourcesList.addSource')}
                </Button>
              }
              {...getEditConfig(
                sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                workspaceRootPath
              )}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(source) => {
        const connectionStatus = deriveConnectionStatus(source, localMcpEnabled)
        const typeLabelKey = SOURCE_TYPE_LABEL_KEYS[source.config.type]
        const statusConfig = SOURCE_STATUS_CONFIG[connectionStatus]
        const description = source.config.tagline || source.config.provider || ''
        const connectionError = source.config.connectionError
        return {
          icon: <SourceAvatar source={source} size="sm" />,
          title: source.config.name,
          titleTrailing: typeLabelKey ? t(typeLabelKey) : undefined,
          subtitle: statusConfig ? (
            connectionError ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn('cursor-default', statusConfig.textClass)}>{t(statusConfig.labelKey)}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">{connectionError}</TooltipContent>
              </Tooltip>
            ) : (
              <span className={statusConfig.textClass}>{t(statusConfig.labelKey)}</span>
            )
          ) : description || undefined,
          menu: (
            <SourceMenu
              sourceSlug={source.config.slug}
              sourceName={source.config.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`memwise://sources/source/${source.config.slug}?window=focused`)}
              onShowInFinder={() => window.electronAPI.showInFolder(source.folderPath)}
              onDelete={() => onDeleteSource(source.config.slug)}
              onSendToWorkspace={hasOtherWorkspaces ? () => {
                setSendResourceSlug(source.config.slug)
                setSendResourceLabel(source.config.name)
                setSendDialogOpen(true)
              } : undefined}
            />
          ),
        }
      }}
    />

    {/* Send to Workspace dialog */}
    {sendResourceSlug && (
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType="source"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}
