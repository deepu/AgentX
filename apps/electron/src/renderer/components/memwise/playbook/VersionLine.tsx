/**
 * A playbook's version line ("Version 2 · published 2 Oct by Ravi Menon"), with every version and
 * the cases still running on each a click away, and the playbook's drafts in progress.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ChevronDown, FilePen, Sparkles } from 'lucide-react'
import type { MwDraftSummary, MwVersion } from '@memwise/shared/protocol'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { relativeTime } from '../format'
import { isOpenDraft, sortDrafts, stageLabel, stageTone } from '../draft/draft-model'
import { originLabel } from '../plugins/plugin-model'

/** "2 Oct", with the year when it is not this year. */
export function shortDate(iso: string, locale?: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(at)
}

/** How a version came to be, in words: "published 2 Oct by Ravi", "changed in the files 12 Sep", "from Client intake 1.0.0 · binding 2". */
export function versionOrigin(v: MwVersion, t: TFunction, locale?: string, now?: number): string {
  if (v.origin) {
    return v.origin.bindingVersion !== undefined
      ? t('memwise.versions.fromBinding', { title: v.origin.pluginTitle, version: v.origin.pluginVersion, binding: v.origin.bindingVersion })
      : originLabel(v.origin, t)
  }
  const date = shortDate(v.publishedAt, locale, now)
  const by = v.publishedByName ?? v.publishedBy
  if (v.source === 'files') return t('memwise.versions.fromFiles', { date })
  if (v.source === 'cli') return by ? t('memwise.versions.pushedBy', { date, name: by }) : t('memwise.versions.pushed', { date })
  return by ? t('memwise.versions.publishedBy', { date, name: by }) : t('memwise.versions.published', { date })
}

export function VersionLine({ versions, version, now, className }: {
  versions: MwVersion[] | null | undefined
  /** The playbook's version, shown alone until the versions arrive. */
  version?: number
  now?: number
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const live = versions?.find(v => v.live) ?? versions?.[0]
  if (!live) {
    return version !== undefined
      ? <span className={cn('text-label-sm text-secondary', className)} data-version-line>{t('memwise.playbook.version', { version })}</span>
      : null
  }
  const older = (versions ?? []).filter(v => v !== live)
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-label-sm text-secondary', className)} data-version-line>
      <span className="font-medium text-foreground">{t('memwise.playbook.version', { version: live.version })}</span>
      <span aria-hidden>·</span>
      <span>{versionOrigin(live, t, i18n.language, now)}</span>
      {(versions?.length ?? 0) > 1 || live.openCases > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-0.5 rounded-sm px-1 text-secondary hover:bg-fill-hover hover:text-foreground" data-action="versions">
              {t('memwise.versions.all', { count: versions?.length ?? 1 })}
              <ChevronDown className="size-3" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <VersionList versions={[live, ...older]} now={now} />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

/** Every version, newest first, with the cases still running on each. */
export function VersionList({ versions, now }: { versions: MwVersion[]; now?: number }) {
  const { t, i18n } = useTranslation()
  return (
    <ul className="divide-y divide-separator" data-version-list>
      {versions.map(v => (
        <li key={v.hash} className="px-3 py-2" data-version={v.version}>
          <div className="flex items-center gap-2 text-label">
            <span className="font-medium text-foreground">{t('memwise.playbook.version', { version: v.version })}</span>
            {v.live && <Info_Badge color="success">{t('memwise.versions.live')}</Info_Badge>}
          </div>
          <p className="text-label-sm text-secondary">{versionOrigin(v, t, i18n.language, now)}</p>
          <p className="text-label-sm text-tertiary">
            {v.openCases > 0
              ? t(v.live ? 'memwise.versions.casesRunning' : 'memwise.versions.casesStillRunning', { count: v.openCases })
              : t('memwise.versions.noCases')}
          </p>
        </li>
      ))}
    </ul>
  )
}

const TONE_TO_BADGE = { default: 'default', success: 'success', warning: 'warning', destructive: 'destructive', muted: 'muted' } as const

/** A playbook's drafts in progress (published and discarded ones are left out). */
export function PlaybookDrafts({ drafts, onOpen, now }: { drafts: MwDraftSummary[] | null | undefined; onOpen: (draftId: string) => void; now?: number }) {
  const { t, i18n } = useTranslation()
  const open = sortDrafts((drafts ?? []).filter(isOpenDraft))
  if (open.length === 0) return null
  return (
    <section className="space-y-2" data-playbook-drafts>
      <h3 className="text-label-sm font-semibold text-secondary">
        {t('memwise.draft.inProgress')}
        <span className="ml-1.5 font-normal text-tertiary tabular-nums">{open.length}</span>
      </h3>
      <ul className="overflow-hidden rounded-lg bg-raised shadow-elev-1 divide-y divide-separator">
        {open.map(d => (
          <li key={d.id}>
            <button type="button" onClick={() => onOpen(d.id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-fill-hover" data-draft={d.id}>
              <FilePen className="size-4 shrink-0 text-tertiary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label font-medium text-foreground">{d.title}</span>
                <span className="block truncate text-label-sm text-secondary">
                  {[d.createdByName, relativeTime(d.updatedAt, now, i18n.language)].filter(Boolean).join(' · ')}
                </span>
              </span>
              {d.pendingEdits > 0 && (
                <Info_Badge className="bg-accent-tint text-accent" icon={<Sparkles />}>{t('memwise.draft.pendingCount', { count: d.pendingEdits })}</Info_Badge>
              )}
              <Info_Badge color={TONE_TO_BADGE[stageTone(d.stage)]} dot>{stageLabel(d.stage, t)}</Info_Badge>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
