/**
 * A record type's list in the project shell (doc 26 §2, mocks `Sites` and `Documents`): List or
 * Cards. When the chat beside it filters the list (`records_filter`), the filter shows as chips
 * above it, × clears it, and "Save as a page" keeps it as a project page (Stage 2's pages, with a
 * `records` block), or as a saved view where pages aren't available.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type { MwRecordQueryResult, MwRecordsChatFilter } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseDomainsAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi } from '@/hooks/useMemwise'
import { useMemwiseRecordQuery } from '@/hooks/useMemwiseRecords'
import { useMemwiseRecordsChatFilter, useMemwiseShellCalls } from '@/hooks/useMemwiseShellPages'
import { formatCell, humanize } from '../../format'
import { statusLabel } from '../../records/record-model'
import { pluralTitle } from '../project-model'
import { useProjectShell } from '../shell-context'
import { ShellPageFrame } from '../WaitingPage'
import { listColumns, recordsFence } from './every-page-model'
import { RecordsBoard } from './RecordsBoard'
import { ChatChip, ShellButton, ShellTable } from './shell-ui'

type Layout = 'list' | 'cards'
const LAYOUT_KEY = 'memwise.records.layout.'

function readLayout(entity: string): Layout {
  try { return localStorage.getItem(LAYOUT_KEY + entity) === 'cards' ? 'cards' : 'list' } catch { return 'list' }
}

/** Stage 2's "Save as a page" (`memwise:pages:create`), when this build has it. */
type CreatePage = (workspaceId: string, input: { projectId: string; title: string; body?: string; status?: 'draft' | 'kept' }) =>
  Promise<{ applied: boolean; message?: string; page?: { id: string } }>

export function RecordsShellPage({ projectId, entity }: { projectId: string; entity: string }) {
  const { t, i18n } = useTranslation()
  const domains = useAtomValue(memwiseDomainsAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const domain = domains?.find(d => d.entities.some(e => e.key === entity))
  const type = domain?.entities.find(e => e.key === entity)
  const title = pluralTitle(type?.title ?? humanize(entity.split('.').pop() ?? entity))
  const [layout, setLayout] = React.useState<Layout>(() => readLayout(entity))
  const { data: chatFilter } = useMemwiseRecordsChatFilter(entity)
  const filter = chatFilter?.filter
  const { data: result, error } = useMemwiseRecordQuery({ entity, ...(filter ? { filter } : {}), ...(chatFilter?.sort?.length ? { sort: chatFilter.sort } : {}), limit: 200 })
  const calls = useMemwiseShellCalls()
  const shell = useProjectShell()
  const [saving, setSaving] = React.useState(false)
  const total = type?.count ?? result?.total ?? 0

  const choose = (l: Layout) => {
    setLayout(l)
    try { localStorage.setItem(LAYOUT_KEY + entity, l) } catch { /* the choice just isn't remembered */ }
  }

  const saveAsPage = async (f: MwRecordsChatFilter) => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) { toast.error(t('memwise.notAvailable')); return }
    setSaving(true)
    try {
      const pageTitle = `${title}: ${f.label}`
      const create = (api as unknown as { memwiseCreatePage?: CreatePage }).memwiseCreatePage
      if (typeof create === 'function') {
        const r = await create(workspaceId, { projectId, title: pageTitle, body: recordsFence({ entity, filter: f.filter, title: pageTitle, ...(f.columns ? { columns: f.columns } : {}), ...(f.sort ? { sort: f.sort } : {}) }), status: 'kept' })
        if (!r.applied || !r.page) { toast.error(r.message ?? t('memwise.inbox.notApplied')); return }
        toast.success(t('memwise.everyPage.savedAsPage', { title: pageTitle }))
        navigate(routes.view.project(shell?.projectId ?? projectId, { type: 'page', pageId: r.page.id }))
        return
      }
      // No pages in this build: keep it as a saved view of the list.
      const view = await api.memwiseSaveView(workspaceId, {
        domain: domain?.id ?? projectId,
        view: { id: '', title: pageTitle, entity, filter: f.filter, ...(f.sort ? { sort: f.sort } : {}), ...(f.columns ? { columns: f.columns } : {}), layout: 'table' },
      })
      toast.success(t('memwise.everyPage.savedAsView', { title: view.title }))
    } catch (err) {
      toast.error(t('memwise.inbox.notApplied'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const states = type?.lifecycle ?? []
  const rows = result?.rows ?? []
  const hidden = filter && result ? Math.max(0, total - result.total) : 0

  return (
    <ShellPageFrame
      crumb={<>{t('memwise.shell.records')} <span className="text-tertiary">›</span> {title}</>}
      title={title}
      count={total}
      subtitle={layout === 'cards' && states.length ? t('memwise.everyPage.cardsHint') : t('memwise.everyPage.listHint')}
      actions={states.length > 0 ? <LayoutToggle value={layout} onChange={choose} /> : undefined}
    >
      {chatFilter && (
        <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="chat-filter">
          {(chatFilter.chips.length ? chatFilter.chips : [chatFilter.label]).map((c, i) => (
            <ChatChip
              key={i}
              label={c}
              from={i === 0 ? t('memwise.everyPage.fromChat') : undefined}
              clearLabel={t('memwise.everyPage.clearFilter')}
              onClear={i === 0 ? () => void calls.clearChatFilter(entity) : undefined}
            />
          ))}
          <ShellButton className="ml-auto" onClick={() => void saveAsPage(chatFilter)} busy={saving} data-action="save-as-page">{t('memwise.everyPage.saveAsPage')}</ShellButton>
        </div>
      )}
      {error && <p className="mb-3 text-label text-destructive" role="alert">{error}</p>}
      {layout === 'cards' && states.length > 0 ? (
        <RecordsBoard
          entity={entity}
          entityName={type?.title ?? entity}
          states={states}
          rows={rows}
          regulated={!!domain?.regulated}
          detail={r => cardLines(r, result, t, i18n.language)}
        />
      ) : (
        <RecordsList result={result} entity={entity} projectId={shell?.projectId ?? projectId} title={title} />
      )}
      {hidden > 0 && <p className="mt-3 text-label-sm text-secondary" data-testid="hidden-by-filter">{t('memwise.everyPage.hiddenByFilter', { count: hidden, records: title.toLowerCase() })}</p>}
      <p className="mt-4 rounded-[10px] bg-fill-hover px-4 py-3 text-label text-secondary">{t('memwise.everyPage.recordsExplain')}</p>
    </ShellPageFrame>
  )
}

function LayoutToggle({ value, onChange }: { value: Layout; onChange: (l: Layout) => void }) {
  const { t } = useTranslation()
  return (
    <div role="group" className="inline-flex overflow-hidden rounded-[7px] border border-foreground/15 text-label" data-testid="layout-toggle">
      {(['list', 'cards'] as const).map(l => (
        <button
          key={l}
          type="button"
          aria-pressed={value === l}
          onClick={() => onChange(l)}
          className={cn('px-3 py-1', value === l ? 'bg-foreground text-background' : 'bg-background text-foreground hover:bg-fill-hover')}
          data-layout={l}
        >
          {l === 'list' ? t('memwise.everyPage.list') : t('memwise.everyPage.cards')}
        </button>
      ))}
    </div>
  )
}

/** Up to two short values for a card: its parent and a status-like value, as the columns hold them. */
function cardLines(row: MwRecordQueryResult['rows'][number], result: MwRecordQueryResult | null, t: (k: string) => string, locale: string): string[] {
  const out: string[] = []
  for (const c of listColumns(result ?? { columns: [] }, 6)) {
    if (out.length >= 2) break
    const ref = row.refs?.[c.name]
    const v = ref ? ref.title : row.values[c.name]
    if (v === null || v === undefined || v === '' || c.name === 'title') continue
    const text = typeof v === 'string' ? v : formatCell(c.name, v, t as never, locale)
    if (text && text !== row.title && text.length <= 40) out.push(text)
  }
  return out
}

function RecordsList({ result, entity, projectId, title }: { result: MwRecordQueryResult | null; entity: string; projectId: string; title: string }) {
  const { t, i18n } = useTranslation()
  if (!result) return <p className="text-label text-tertiary">{t('memwise.entities.loading')}</p>
  const columns = listColumns(result, 3)
  const hasStatus = result.rows.some(r => r.status)
  return (
    <ShellTable head={[pluralSingular(title), ...(hasStatus ? [t('memwise.everyPage.status')] : []), ...columns.map(c => c.label)]} testId="records-list">
      {result.rows.length === 0 && <tr><td colSpan={2 + columns.length} className="px-4 py-3 text-secondary">{t('memwise.everyPage.noRecords')}</td></tr>}
      {result.rows.map(r => (
        <tr key={r.id} className="cursor-pointer hover:bg-fill-hover" onClick={() => navigate(routes.view.project(projectId, { type: 'record', entity, recordId: r.id }))} data-row={r.id}>
          <td className="px-4 py-2.5 font-medium text-foreground">{r.title}</td>
          {hasStatus && <td className="px-4 py-2.5 text-foreground">{r.status ? statusLabel(r.status) : ''}</td>}
          {columns.map(c => {
            const ref = r.refs?.[c.name]
            const v = r.values[c.name]
            return <td key={c.name} className="px-4 py-2.5 text-secondary">{ref ? ref.title : r.hidden.includes(c.name) ? '' : formatCell(c.name, v, t, i18n.language)}</td>
          })}
        </tr>
      ))}
    </ShellTable>
  )
}

/** "Sites" → "Site", for the first column's header. */
function pluralSingular(title: string): string {
  if (/ies$/i.test(title)) return `${title.slice(0, -3)}y`
  if (/s$/i.test(title)) return title.slice(0, -1)
  return title
}
