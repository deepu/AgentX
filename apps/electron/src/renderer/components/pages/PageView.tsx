import * as React from 'react'
import { AlertTriangle, ArrowLeft, Check, ExternalLink, FolderKanban, FolderOpen, Globe2, KeyRound, MoreHorizontal, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { isWebUI } from '@/lib/platform'
import { pagesAtom } from '@/atoms/pages'
import { LoadingIndicator, Spinner } from '@memwise/ui'
import { Info_Alert } from '@/components/info'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
} from '@/components/ui/styled-dropdown'
import { useProjects } from '@/hooks/useProjects'
import type { LoadedPage, PageDataSnapshot, PageRenderLease } from '@memwise/shared/pages/types'
import { PageFrame } from './PageFrame'
import { PageFreshness, PageKindBadge } from './page-visuals'
import { DeletePageDialog } from './DeletePageDialog'
import { PageGrantsDialog } from './PageGrantsDialog'
import { PageSourceAuthBanner } from './PageSourceAuthBanner'
import { SharePageDialog, usePageShareCapabilities } from './SharePageDialog'
import { isClaudeAccountConnection } from '@config/llm-connections'
import claudeIcon from '@/assets/provider-icons/claude.svg'

interface PageViewProps {
  pageSlug: string
}

interface LeaseState {
  lease: PageRenderLease
  content: string
}

/**
 * One page, rendered embedded in the main content area.
 *
 * Owns the render-lease lifecycle: a lease is created per (page, content
 * digest) and released on unmount or when the digest changes — a content
 * change (agent edit, refresh script rewriting index.html) re-leases and
 * remounts the frame with the new exact content. The data snapshot is
 * re-read whenever page.json is stamped (refresh completion), which for
 * live pages flows into the frame as a replacement snapshot.
 */
export function PageView({ pageSlug }: PageViewProps) {
  const { activeWorkspaceId, onOpenFile, enabledSources, llmConnections } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const pages = useAtomValue(pagesAtom)

  // Prefer the live atom copy; fall back to a direct fetch for deep links
  // that land before the initial pages load.
  const pageFromAtom = React.useMemo(
    () => pages.find(p => p.config.slug === pageSlug) ?? null,
    [pages, pageSlug],
  )
  const [fallback, setFallback] = React.useState<{ slug: string; page: LoadedPage | null } | null>(null)
  const page = pageFromAtom ?? (fallback?.slug === pageSlug ? fallback.page : null)
  const fallbackResolved = fallback?.slug === pageSlug

  React.useEffect(() => {
    if (pageFromAtom || !activeWorkspaceId) return
    let stale = false
    window.electronAPI
      .getPage(activeWorkspaceId, pageSlug)
      .then(loaded => { if (!stale) setFallback({ slug: pageSlug, page: loaded }) })
      .catch(() => { if (!stale) setFallback({ slug: pageSlug, page: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, pageSlug, pageFromAtom])

  // ------------------------------------------------------------------
  // Render lease (keyed by content digest; released on cleanup)
  // ------------------------------------------------------------------
  const contentDigest = page?.config.contentDigest
  const hasContent = Boolean(contentDigest)
  const pageLoaded = Boolean(page)
  const [leaseState, setLeaseState] = React.useState<LeaseState | null>(null)
  const [leaseError, setLeaseError] = React.useState<string | null>(null)
  const [leaseRetry, setLeaseRetry] = React.useState(0)

  React.useEffect(() => {
    if (!activeWorkspaceId || !pageLoaded || !hasContent) return
    let stale = false
    let heldLeaseId: string | null = null
    setLeaseState(null)
    setLeaseError(null)

    window.electronAPI
      .createPageLease(activeWorkspaceId, pageSlug)
      .then(result => {
        if (stale) {
          void window.electronAPI.releasePageLease(activeWorkspaceId, result.lease.leaseId)
          return
        }
        heldLeaseId = result.lease.leaseId
        setLeaseState(result)
      })
      .catch(err => {
        if (!stale) setLeaseError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      stale = true
      if (heldLeaseId) void window.electronAPI.releasePageLease(activeWorkspaceId, heldLeaseId)
    }
  }, [activeWorkspaceId, pageSlug, contentDigest, hasContent, pageLoaded, leaseRetry])

  // ------------------------------------------------------------------
  // Data snapshot (re-read when a refresh stamps page.json)
  // ------------------------------------------------------------------
  const refreshStamp = page?.config.lastRefresh?.at ?? 0
  const updatedStamp = page?.config.updatedAt ?? 0
  const [snapshotState, setSnapshotState] = React.useState<{
    slug: string
    loaded: boolean
    data: PageDataSnapshot | null
  }>({ slug: pageSlug, loaded: false, data: null })

  React.useEffect(() => {
    if (!activeWorkspaceId || !pageLoaded) return
    let stale = false
    window.electronAPI
      .getPageData(activeWorkspaceId, pageSlug)
      .then(data => { if (!stale) setSnapshotState({ slug: pageSlug, loaded: true, data }) })
      .catch(() => { if (!stale) setSnapshotState({ slug: pageSlug, loaded: true, data: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, pageSlug, pageLoaded, refreshStamp, updatedStamp])

  const snapshotReady = snapshotState.slug === pageSlug && snapshotState.loaded

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [grantsOpen, setGrantsOpen] = React.useState(false)
  const { sharingEnabled } = usePageShareCapabilities()
  const { projects } = useProjects(activeWorkspaceId)
  // Claude artifacts need a claude.ai account; the server picks the connection by the same rule.
  // Desktop only: in the Web UI the server's Claude account would publish, not the viewer's.
  const canPublishClaudeArtifact = React.useMemo(
    () => !isWebUI && llmConnections.some(isClaudeAccountConnection),
    [llmConnections],
  )
  const [publishingArtifact, setPublishingArtifact] = React.useState(false)

  // Inline rename: null = display mode, string = the draft being edited.
  const [nameDraft, setNameDraft] = React.useState<string | null>(null)

  const commitRename = React.useCallback(async () => {
    const next = (nameDraft ?? '').trim()
    setNameDraft(null)
    if (!activeWorkspaceId || !page || !next || next === page.config.name) return
    try {
      await window.electronAPI.updatePage(activeWorkspaceId, page.config.slug, { name: next })
    } catch (err) {
      toast.error(t('toast.pageUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nameDraft, activeWorkspaceId, page, t])

  const moveToProject = React.useCallback(async (projectId: string | null) => {
    if (!activeWorkspaceId || !page) return
    if ((page.config.projectId ?? null) === projectId) return
    try {
      // Explicit null clears the binding (updatePage normalizes null → absent).
      await window.electronAPI.updatePage(activeWorkspaceId, page.config.slug, { projectId })
    } catch (err) {
      toast.error(t('toast.pageUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, page, t])

  const handleDesignWithAgent = React.useCallback(() => {
    if (!page) return
    navigate(routes.action.newSession({
      input: t('pages.designWithAgentPrompt', { name: page.config.name, slug: page.config.slug }),
    }))
  }, [page, navigate, t])

  const handleBack = React.useCallback(() => navigate(routes.view.pages()), [navigate])

  const openClaudeArtifact = React.useCallback((url: string) => {
    void window.electronAPI.openUrl(url)
  }, [])

  // One click: publish (first time) or update the same artifact in place, with the
  // Claude account connection chats use. A rejected credential offers Reconnect.
  const handlePublishClaudeArtifact = React.useCallback(async (): Promise<void> => {
    if (!activeWorkspaceId || !page || publishingArtifact) return
    setPublishingArtifact(true)
    try {
      const updated = await window.electronAPI.publishPageAsClaudeArtifact(activeWorkspaceId, page.config.slug)
      const url = updated.claudeArtifact?.url
      toast.success(t('toast.pageClaudeArtifactPublished'), {
        description: url,
        ...(url ? { action: { label: t('common.open'), onClick: () => openClaudeArtifact(url) } } : {}),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('toast.pageClaudeArtifactFailed'), {
        description: message.replace(/^(Error: )?[A-Z_]+: /, ''),
        ...(message.includes('ARTIFACT_AUTH_REQUIRED')
          ? { action: { label: t('common.reconnect'), onClick: () => navigate(routes.view.settings('ai')) } }
          : {}),
      })
    } finally {
      setPublishingArtifact(false)
    }
  }, [activeWorkspaceId, page, publishingArtifact, t, openClaudeArtifact, navigate])

  const handleOpenFolder = React.useCallback(() => {
    if (page) onOpenFile(page.folderPath)
  }, [page, onOpenFile])

  const handleRefreshPreview = React.useCallback(() => {
    if (!activeWorkspaceId || !page) return
    void window.electronAPI
      .regeneratePageThumbnail(activeWorkspaceId, page.config.slug)
      .then((queued) => {
        if (queued) toast.success(t('toast.pagePreviewQueued'))
        else toast.error(t('toast.pagePreviewFailed'))
      })
      .catch(() => toast.error(t('toast.pagePreviewFailed')))
  }, [activeWorkspaceId, page, t])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !page) return
    setConfirmingDelete(false)
    try {
      const result = await window.electronAPI.deletePage(activeWorkspaceId, page.config.slug)
      if (result?.publicCopyMayRemain) {
        toast.warning(t('toast.pageDeleted', { name: page.config.name }), {
          description: t('toast.pagePublicCopyMayRemain'),
        })
      } else {
        toast.success(t('toast.pageDeleted', { name: page.config.name }))
      }
      navigate(routes.view.pages())
    } catch (err) {
      toast.error(t('toast.pageDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, page, t, navigate])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!page) {
    return (
      <div className="flex h-full items-center justify-center">
        {fallbackResolved ? (
          <div className="flex flex-col items-center gap-3 text-label text-tertiary">
            <span>{t('pages.notFound')}</span>
            <Button type="button" variant="secondary" onClick={handleBack}>
              <ArrowLeft /> {t('pages.backToPages')}
            </Button>
          </div>
        ) : (
          <LoadingIndicator label={t('common.loading')} />
        )}
      </div>
    )
  }

  const { config } = page
  const refreshFailed = config.lastRefresh && !config.lastRefresh.ok

  return (
    // No surface of its own: the panel card (paper) shows through.
    <div className="flex h-full flex-col">
      {/* Header (48px, like the panel headers): back, title, kind, freshness, share, overflow. The end
          glyphs sit on the 16px gutter (28px icon buttons pad 6px; 36px compact ones 10px). */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-2.5 @max-mobile/shell:px-1.5">
        <IconButton icon={<ArrowLeft />} aria-label={t('pages.backToPages')} tooltip onClick={handleBack} />
        {nameDraft !== null ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={e => {
              if (e.key === 'Enter') void commitRename()
              else if (e.key === 'Escape') setNameDraft(null)
            }}
            aria-label={t('pages.renamePage')}
            className="h-control flex-1 px-2 text-label-lg font-semibold md:text-label-lg"
          />
        ) : (
          <span
            className="min-w-0 truncate px-1 text-label-lg font-semibold"
            title={t('pages.renamePage')}
            onDoubleClick={() => setNameDraft(config.name)}
          >
            {config.name}
          </span>
        )}
        <PageKindBadge kind={config.kind} />
        <PageFreshness config={config} className="hidden @[28rem]/panel:inline-flex" />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canPublishClaudeArtifact && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handlePublishClaudeArtifact()}
              disabled={publishingArtifact}
              aria-label={config.claudeArtifact ? t('pages.claudeArtifact.update') : t('pages.claudeArtifact.publish')}
              title={publishingArtifact
                ? t('pages.claudeArtifact.publishing')
                : config.claudeArtifact ? `${t('pages.claudeArtifact.update')} — ${config.claudeArtifact.url}` : t('pages.claudeArtifact.publish')}
              className="px-1.5 text-secondary hover:text-foreground @max-mobile/shell:h-9 @max-mobile/shell:min-w-9"
            >
              {publishingArtifact
                ? <Spinner className="text-sm" />
                : <img src={claudeIcon} alt="" aria-hidden className="size-4" />}
              <span className="hidden pr-0.5 @[36rem]/panel:inline">
                {publishingArtifact
                  ? t('pages.claudeArtifact.publishing')
                  : config.claudeArtifact ? t('pages.claudeArtifact.update') : t('pages.claudeArtifact.publish')}
              </span>
            </Button>
          )}
          {(sharingEnabled || config.share) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShareOpen(true)}
              aria-label={t('pages.share.title')}
              title={config.share ? t('pages.shared') : t('pages.share.title')}
              className="px-1.5 text-secondary hover:text-foreground @max-mobile/shell:h-9 @max-mobile/shell:min-w-9"
            >
              <Globe2 className={config.share ? 'text-accent' : undefined} />
              {config.share && (
                <span className="hidden pr-0.5 @[28rem]/panel:inline">{t('pages.shared')}</span>
              )}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton icon={<MoreHorizontal />} aria-label={t('common.more')} />
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end">
              <StyledDropdownMenuItem onClick={() => setNameDraft(config.name)}>
                <Pencil />
                {t('pages.renamePage')}
              </StyledDropdownMenuItem>
              {projects.length > 0 && (
                <DropdownMenuSub>
                  <StyledDropdownMenuSubTrigger>
                    <FolderKanban />
                    <span className="flex-1">{t('pages.moveToProject')}</span>
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent>
                    {/* Unchecked rows indent by the check (16px) + the row gap (8px) so labels align */}
                    <StyledDropdownMenuItem onClick={() => void moveToProject(null)}>
                      {!config.projectId && <Check />}
                      <span className={config.projectId ? 'flex-1 ml-6' : 'flex-1'}>
                        {t('sessionMenu.noProject')}
                      </span>
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuSeparator />
                    {projects.map(p => {
                      const isBound = config.projectId === p.config.id
                      return (
                        <StyledDropdownMenuItem key={p.config.id} onClick={() => void moveToProject(p.config.id)}>
                          {isBound && <Check />}
                          <span className={isBound ? 'flex-1' : 'flex-1 ml-6'}>{p.config.name}</span>
                        </StyledDropdownMenuItem>
                      )
                    })}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {config.claudeArtifact && (
                <StyledDropdownMenuItem onClick={() => openClaudeArtifact(config.claudeArtifact!.url)}>
                  <ExternalLink />
                  {t('pages.claudeArtifact.open')}
                </StyledDropdownMenuItem>
              )}
              <StyledDropdownMenuItem onClick={handleOpenFolder}>
                <FolderOpen />
                {t('pages.openFolder')}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onClick={handleRefreshPreview}>
                <RefreshCw />
                {t('pages.refreshPreview')}
              </StyledDropdownMenuItem>
              {(config.grants?.length ?? 0) > 0 && (
                <StyledDropdownMenuItem onClick={() => setGrantsOpen(true)}>
                  <KeyRound />
                  {t('pages.grants.manage')}
                </StyledDropdownMenuItem>
              )}
              <StyledDropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                <Trash2 />
                {t('pages.deletePage')}
              </StyledDropdownMenuItem>
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Granted sources that lost auth get a reconnect row above the frame */}
      {activeWorkspaceId && (
        <PageSourceAuthBanner
          workspaceId={activeWorkspaceId}
          page={page}
          sources={enabledSources ?? []}
          className="mx-3 mt-2"
        />
      )}

      {/* Last-refresh failure surfaces above the frame, not inside it */}
      {refreshFailed && (
        <Info_Alert
          variant="error"
          inline
          icon={<AlertTriangle className="h-4 w-4" />}
          className="mx-3 mt-2"
        >
          <Info_Alert.Title>{t('pages.refreshFailed')}</Info_Alert.Title>
          {config.lastRefresh?.error && (
            <Info_Alert.Description className="break-all">
              {config.lastRefresh.error}
            </Info_Alert.Description>
          )}
        </Info_Alert>
      )}

      {/* Body: the sandboxed frame as a raised card on the paper */}
      <div className="relative min-h-0 flex-1 p-3">
        {!hasContent ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <span className="text-label font-medium text-foreground">{t('pages.noContentTitle')}</span>
            <span className="max-w-md text-label-sm text-tertiary">{t('pages.noContentDescription')}</span>
            <div className="mt-3 flex items-center gap-2">
              <Button type="button" variant="primary" onClick={handleDesignWithAgent}>
                <Sparkles />
                {t('pages.designWithAgent')}
              </Button>
              <Button type="button" variant="secondary" onClick={handleOpenFolder}>
                <FolderOpen />
                {t('pages.openFolder')}
              </Button>
            </div>
          </div>
        ) : leaseError ? (
          <div className="mx-auto max-w-xl pt-8">
            <Info_Alert variant="error" icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('pages.loadFailed')}</Info_Alert.Title>
              <Info_Alert.Description className="break-all">{leaseError}</Info_Alert.Description>
            </Info_Alert>
            <Button type="button" variant="secondary" className="mt-3" onClick={() => setLeaseRetry(n => n + 1)}>
              {t('common.retry')}
            </Button>
          </div>
        ) : !leaseState || !snapshotReady || !activeWorkspaceId ? (
          <div className="flex h-full items-center justify-center">
            <LoadingIndicator label={t('common.loading')} />
          </div>
        ) : (
          <div className="h-full w-full overflow-hidden rounded-lg shadow-elev-1">
            <PageFrame
              key={leaseState.lease.leaseId}
              workspaceId={activeWorkspaceId}
              page={page}
              lease={leaseState.lease}
              content={leaseState.content}
              snapshot={snapshotState.data}
            />
          </div>
        )}
      </div>

      <DeletePageDialog
        pageName={confirmingDelete ? config.name : null}
        shared={Boolean(config.share)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />

      {activeWorkspaceId && (
        <SharePageDialog
          workspaceId={activeWorkspaceId}
          page={page}
          hasSnapshot={snapshotState.data !== null}
          sharingEnabled={sharingEnabled}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}

      {activeWorkspaceId && (
        <PageGrantsDialog
          workspaceId={activeWorkspaceId}
          page={page}
          open={grantsOpen}
          onOpenChange={setGrantsOpen}
        />
      )}
    </div>
  )
}
