import * as React from 'react'
import { Globe2, Lock, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import type { LoadedPage } from '@memwise/shared/pages/types'
import { PageFreshness, PageKindBadge, PagePosterPlaceholder } from './page-visuals'
import { useInView } from '@/hooks/useInView'

export interface PageTileProject {
  name: string
  color?: string
}

interface PageTileProps {
  page: LoadedPage
  /** Resolved owning project (undefined when the page is unassigned) */
  project?: PageTileProject
  onOpen: () => void
  onDelete: () => void
}

/**
 * One tile in the Pages library grid (design spec §7.13): a raised card with a 16:10 poster on a
 * sunken well, then title and a meta row. Shows the cached preview poster when one is fresh
 * (lazily fetched once the tile scrolls into view); otherwise the kind placeholder. "Fresh" = the
 * poster's digest matches the current content digest, mirroring `isThumbnailFresh` server-side
 * (inlined here — the renderer must not import Node-backed `@memwise/shared` code).
 *
 * Hover lifts the card 2px (× --motion-scale, so 0 under reduced motion) onto elev-2 over 150ms.
 */
export function PageTile({ page, project, onOpen, onDelete }: PageTileProps) {
  const { t } = useTranslation()
  const { config } = page

  const posterDigest =
    config.thumbnail && config.contentDigest && config.thumbnail.digest === config.contentDigest
      ? config.contentDigest
      : null

  const [thumbRef, inView] = useInView<HTMLDivElement>()
  const [posterUrl, setPosterUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Reset when the page has no fresh poster (e.g. content just changed).
    if (!posterDigest) {
      setPosterUrl(null)
      return
    }
    if (!inView) return
    let cancelled = false
    void window.electronAPI
      .getPageThumbnail(page.workspaceId, config.slug)
      .then((result) => {
        // Guard against a stale response after another content change.
        if (!cancelled && result && result.digest === posterDigest) setPosterUrl(result.dataUrl)
      })
      .catch(() => { /* posterless → placeholder stays */ })
    return () => { cancelled = true }
  }, [page.workspaceId, config.slug, posterDigest, inView])

  const refreshPreview = React.useCallback(() => {
    void window.electronAPI
      .regeneratePageThumbnail(page.workspaceId, config.slug)
      .then((queued) => {
        if (queued) toast.success(t('toast.pagePreviewQueued'))
        else toast.error(t('toast.pagePreviewFailed'))
      })
      .catch(() => toast.error(t('toast.pagePreviewFailed')))
  }, [page.workspaceId, config.slug, t])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          aria-label={config.name}
          className={cn(
            'group relative flex min-w-0 flex-col overflow-hidden rounded-lg bg-raised text-left shadow-elev-1',
            'cursor-pointer transition-[translate,box-shadow] duration-fast ease-out',
            'hover:translate-y-[calc(-2px*var(--motion-scale))] hover:shadow-elev-2',
          )}
        >
          {/* Preview poster when fresh, else the kind placeholder (16:10 on the sunken well) */}
          <div
            ref={thumbRef}
            className="relative aspect-[16/10] w-full overflow-hidden border-b border-subtle bg-sunken"
          >
            {posterUrl ? (
              <img
                src={posterUrl}
                alt=""
                aria-hidden
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
            ) : (
              <PagePosterPlaceholder kind={config.kind} />
            )}
          </div>

          {/* Footer: title, then metadata (kind chip · freshness · project … shared) */}
          <div className="flex min-w-0 flex-col gap-1 px-3 pt-2.5 pb-3">
            <span className="truncate text-label-lg font-medium text-foreground">{config.name}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-label-sm text-tertiary">
              <PageKindBadge kind={config.kind} />
              <PageFreshness config={config} />
              {project && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: project.color ?? 'var(--text-tertiary)' }}
                    aria-hidden
                  />
                  <span className="truncate">{project.name}</span>
                </span>
              )}
              {config.share && (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1" title={t('pages.shared')}>
                  {config.share.passwordProtected
                    ? <Lock className="size-3.5" aria-hidden />
                    : <Globe2 className="size-3.5" aria-hidden />}
                  {t('pages.shared')}
                </span>
              )}
            </span>
          </div>
        </button>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onClick={onOpen}>
          {t('common.open')}
        </StyledContextMenuItem>
        <StyledContextMenuItem onClick={refreshPreview}>
          <RefreshCw />
          {t('pages.refreshPreview')}
        </StyledContextMenuItem>
        <StyledContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 />
          {t('pages.deletePage')}
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}
