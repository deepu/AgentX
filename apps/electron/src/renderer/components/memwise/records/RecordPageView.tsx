/**
 * A record's page, drawn from its layout (24 §6): breadcrumbs from its parents, the header
 * (title, status, the header fields, the moves it can make), its flags, then the layout's
 * areas (single, split or sidebar; the columns stack when the panel is narrow) and `below`.
 *
 * Literature (25 §4–§6): KPI tiles, charts drawn with the @memwise/ui kit, a Text field shown with
 * the quotes its values were read from (a value with a quote can scroll to it), and "Ask about
 * this <record>".
 *
 * In review mode (`page.review`, 24 §11) the same page puts the document beside the review:
 * the proposed values, the checks, a comment and "Approve and sign". Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, Database, MessageSquare, ShieldCheck } from 'lucide-react'
import { mwPageBlockKey, type MwPageBlock, type MwRecordPage, type MwTransitionOption } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { absoluteTime } from '../format'
import { ShellButton } from '../project/pages/shell-ui'
import { DocumentViewer, type ViewerQuote } from './DocumentViewer'
import { TextViewer } from './TextViewer'
import { ReviewPanel, type ReviewPanelProps } from './DocumentReview'
import {
  CasesBlock,
  ChartBlock,
  ChatBlock,
  ChecksBlock,
  FieldRows,
  HistoryBlock,
  KpisBlock,
  LifecycleBlock,
  MentionsBlock,
  NotesBlock,
  ReasonBox,
  RelatedBlock,
  StartBlock,
  StatusPill,
  TransitionButtons,
  useReasonedWrite,
  writeResultMessage,
  type RecordPageActions,
} from './RecordBlocks'
import { Info_Section } from '@/components/info/Info_Section'
import { Markdown } from '@memwise/ui'
import { areaBlocks, blockFields, detailFields, formatFieldValue, headerFields, layoutColumns, splitRelated, textQuotes, valueQuoteTargets, type AreaName } from './record-model'

export interface ViewerFile { data?: Uint8Array | null; loading?: boolean; error?: string | null }

export interface RecordPageViewProps {
  page: MwRecordPage
  actions?: RecordPageActions & { openChat?: () => void }
  /** The viewer blocks' bytes, by field (loaded by the container). */
  files?: Record<string, ViewerFile>
  /** Review mode: how to submit the review step, and what happens after. */
  review?: Omit<ReviewPanelProps, 'review' | 'activeField' | 'onPick'>
  /** Shown found/missing quotes in tests and the playground (the viewer works them out from the PDF). */
  missingQuotes?: number[]
  now?: number
  /**
   * In the project shell (doc 26 §2, mocks `Site`, `Document`, `Sign`): the shell's header (a
   * crumb, the title, one line of facts, Export audit trail) in place of the hero, and the
   * layout's columns side by side at the narrower width of the shell's page column.
   */
  shell?: { crumb: React.ReactNode; /** Facts after the record's own (the step a review comes from). */ subtitle?: React.ReactNode }
  /** Stage 6: blocks the container adds below the columns (the same record in other apps). */
  extra?: React.ReactNode
}

const LAYOUT_GRID: Record<MwRecordPage['layout']['layout'], string> = {
  single: '',
  split: '@3xl/record:grid-cols-2',
  sidebar: '@3xl/record:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]',
}

const SHELL_LAYOUT_GRID: Record<MwRecordPage['layout']['layout'], string> = {
  single: '',
  split: '@xl/record:grid-cols-2',
  // A sidebar's field rows need room: in the shell's page column it stays under the main column.
  sidebar: '@3xl/record:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]',
}

function ShellFrame({ children }: { children: React.ReactNode; wide?: boolean }) {
  return <div className="mx-auto max-w-[1080px] px-7 pb-16 pt-6">{children}</div>
}

export function RecordPageView({ page, actions, files = {}, review, missingQuotes, now, shell, extra }: RecordPageViewProps) {
  const { t, i18n } = useTranslation()
  const [activeField, setActiveField] = React.useState<string | null>(null)
  const move = useReasonedWrite(page.regulated)
  const reviewing = !!page.review && !!review
  const { columns, below } = layoutColumns(page.layout)

  // The quote picked in a Text viewer (25 §4): which viewer, and which of its highlights.
  const [exporting, setExporting] = React.useState(false)
  const exportAudit = actions?.exportAudit
  const [textActive, setTextActive] = React.useState<{ field: string; index: number } | null>(null)
  React.useEffect(() => { setActiveField(null); setTextActive(null) }, [page.id, page.review?.stepRunId])
  const quoteTargets = React.useMemo(() => valueQuoteTargets(page), [page])
  const quotedFields = React.useMemo(() => new Set(quoteTargets.keys()), [quoteTargets])
  const showQuote = React.useCallback((field: string) => setTextActive(quoteTargets.get(field) ?? null), [quoteTargets])

  const quotes = React.useMemo<ViewerQuote[]>(() => (page.review?.proposed ?? [])
    .filter(p => p.quote)
    .map(p => ({ quote: p.quote!, page: p.page, label: p.label })), [page.review])
  const quoteFields = React.useMemo(() => (page.review?.proposed ?? []).filter(p => p.quote).map(p => p.field), [page.review])
  const activeQuote = activeField ? quoteFields.indexOf(activeField) : -1

  const onTransition = actions?.transition ? (tr: MwTransitionOption) => move.write(reason => actions.transition!(tr.name, reason)) : undefined
  const transitions = page.lifecycle?.transitions ?? []
  const openFlags = page.flags.filter(f => !f.closedAt)

  const quoteProps = quotedFields.size > 0 ? { quotedFields, onShowQuote: showQuote } : {}

  const renderBlock = (block: MwPageBlock, key: string, at?: { area: AreaName; index: number }): React.ReactNode => {
    switch (block.kind) {
      case 'fields':
        return (
          <Info_Section key={key} title={t('memwise.record.fields')}>
            <FieldRows fields={blockFields(page, block.fields)} regulated={page.regulated} actions={actions} {...quoteProps} />
          </Info_Section>
        )
      case 'details': {
        const rest = detailFields(page)
        if (rest.length === 0) return null
        return (
          <Info_Section key={key} title={t('memwise.record.details')} count={rest.length}>
            <FieldRows fields={rest} regulated={page.regulated} actions={actions} {...quoteProps} />
          </Info_Section>
        )
      }
      case 'viewer': {
        const text = page.texts?.[block.field]
        if (text) {
          const quotesHere = textQuotes(page, text, t, i18n.language)
          return (
            <TextViewer
              key={key}
              title={page.fields.find(f => f.name === block.field)?.label ?? block.field}
              text={text.text}
              quotes={quotesHere}
              active={textActive?.field === block.field ? textActive.index : null}
              onPick={i => {
                const h = text.highlights[i]
                if (h?.record && actions?.openRecord) actions.openRecord(h.record.entity, h.record.id)
                else setTextActive({ field: block.field, index: i })
              }}
            />
          )
        }
        const f = files[block.field] ?? {}
        return (
          <DocumentViewer
            key={key}
            document={page.documents[block.field] ?? null}
            data={f.data}
            loading={f.loading}
            error={f.error}
            quotes={quotes}
            active={activeQuote >= 0 ? activeQuote : null}
            missing={missingQuotes}
          />
        )
      }
      case 'markdown': {
        const value = page.fields.find(f => f.name === block.field)?.value
        if (typeof value === 'string' && value.trim()) {
          return <article key={key} className="min-w-0 px-1 text-label-lg leading-relaxed [&_table]:text-label-sm" data-markdown-page><Markdown mode="full">{value}</Markdown></article>
        }
        // A draft whose chat is still writing it: say so, rather than an empty box.
        const lc = page.lifecycle
        if (!lc || lc.current !== lc.states[0]) return null
        return (
          <p key={key} className="flex items-center gap-2 px-1 py-6 text-label text-tertiary">
            <span className="size-2 animate-pulse rounded-full bg-foreground/40" />
            {t('memwise.record.pageBeingWritten')}
          </p>
        )
      }
      case 'related': {
        const { relationships, history } = splitRelated(page.layout, block.relationships)
        return (
          <React.Fragment key={key}>
            {relationships.length > 0 && <RelatedBlock page={page} names={relationships} actions={actions} />}
            {history && <HistoryBlock page={page} actions={actions} now={now} />}
          </React.Fragment>
        )
      }
      case 'cases': return <CasesBlock key={key} page={page} actions={actions} now={now} />
      case 'lifecycle': return <LifecycleBlock key={key} page={page} onTransition={onTransition} busy={move.busy} />
      case 'chart': return <ChartBlock key={key} page={page} block={block} chart={at ? page.charts?.[mwPageBlockKey(at.area, at.index)] : undefined} />
      case 'kpis': return <KpisBlock key={key} page={page} fields={block.fields} kpis={page.kpis} />
      case 'chat': return <ChatBlock key={key} page={page} onOpenChat={actions?.openChat} />
      case 'checks': return <ChecksBlock key={key} page={page} />
      case 'notes': return <NotesBlock key={key} page={page} actions={actions} now={now} />
      case 'mentions': return <MentionsBlock key={key} page={page} actions={actions} now={now} />
      case 'start': return <StartBlock key={key} page={page} actions={actions} />
      case 'history': return <HistoryBlock key={key} page={page} actions={actions} now={now} />
    }
  }

  const Frame = shell ? ShellFrame : Info_Page.Content
  const area = (name: AreaName) => areaBlocks(page.layout, name).map((b, i) => renderBlock(b, `${name}:${i}:${b.kind}`, { area: name, index: i }))

  // Review mode: the document (the layout's viewer blocks) on one side, the review on the other.
  const viewerBlocks = Object.values(page.layout.areas).flat().filter((b): b is Extract<MwPageBlock, { kind: 'viewer' }> => b?.kind === 'viewer')

  return (
    <Frame wide={page.layout.layout !== 'single' || reviewing}>
      <div className="@container/record space-y-6" data-record-page={`${page.entity}:${page.id}`} data-layout={page.layout.layout} data-mode={reviewing ? 'review' : 'page'} data-shell={shell ? '' : undefined}>
        {shell ? (
          <header data-shell-header>
            <div className="mb-1.5 text-label-sm text-secondary" data-breadcrumbs>{shell.crumb}</div>
            <div className="flex items-start gap-3">
              <h1 className="min-w-0 flex-1 text-[24px] font-semibold leading-tight tracking-[-0.01em] text-foreground">{page.title}</h1>
              {page.regulated && exportAudit && !reviewing && (
                <ShellButton
                  busy={exporting}
                  onClick={() => {
                    setExporting(true)
                    exportAudit('pdf').catch(() => undefined).finally(() => setExporting(false))
                  }}
                  data-action="export-audit"
                >
                  {t('memwise.record.exportAudit')}
                </ShellButton>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-label text-secondary">
              {headerFields(page).map((f, i) => (
                <span key={f.name} data-header-field={f.name}>{i > 0 && <span className="mr-1.5 text-tertiary">·</span>}{t('memwise.record.headerField', { label: f.label, value: formatFieldValue(f, t, i18n.language) })}</span>
              ))}
              {page.status && <StatusPill status={page.status} />}
              {shell.subtitle}
            </div>
          </header>
        ) : (
        <>
        <nav className="flex flex-wrap items-center gap-1 text-label-sm text-tertiary" aria-label={t('memwise.record.breadcrumbs')} data-breadcrumbs>
          <span>{page.domainName}</span>
          {page.parents.map(p => (
            <React.Fragment key={`${p.entity}:${p.id}`}>
              <ChevronRight className="size-3" />
              {actions?.openRecord
                ? <button type="button" className="hover:text-foreground hover:underline" onClick={() => actions.openRecord!(p.entity, p.id)}>{p.title}</button>
                : <span>{p.title}</span>}
            </React.Fragment>
          ))}
          <ChevronRight className="size-3" />
          <span className="text-secondary">{page.entityName}</span>
        </nav>

        <Info_Page.Hero
          className="mt-0"
          avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><Database className="size-4" /></div>}
          title={page.title}
          meta={
            <>
              <StatusPill status={page.status} />
              {page.regulated && <Info_Badge color="muted" icon={<ShieldCheck className="size-3" />} data-regulated>{t('memwise.domains.regulated')}</Info_Badge>}
              {headerFields(page).map(f => (
                <span key={f.name} data-header-field={f.name}>{t('memwise.record.headerField', { label: f.label, value: formatFieldValue(f, t, i18n.language) })}</span>
              ))}
            </>
          }
          actions={actions?.openChat ? (
            <Button variant="secondary" size="sm" onClick={actions.openChat}><MessageSquare />{t('memwise.record.askInChat')}</Button>
          ) : undefined}
        />
        </>
        )}

        {!reviewing && transitions.length > 0 && (
          <div className="space-y-2">
            <TransitionButtons transitions={transitions} onTransition={onTransition} busy={move.busy} />
            {move.asking && <ReasonBox onConfirm={move.asking} onCancel={move.cancel} busy={move.busy} label={t('memwise.record.reasonForMove')} />}
            {move.result && !move.result.applied && (
              <Info_Alert variant="error" inline icon={<AlertTriangle />}>
                <Info_Alert.Title data-write-status={move.result.status}>{writeResultMessage(move.result, t)}</Info_Alert.Title>
              </Info_Alert>
            )}
          </div>
        )}

        {openFlags.map(f => (
          <Info_Alert key={f.id} variant="error" icon={<AlertTriangle />} data-flag={f.id}>
            <Info_Alert.Title>{f.message}</Info_Alert.Title>
            <Info_Alert.Description>{t('memwise.record.flagRaised', { time: absoluteTime(f.raisedAt, i18n.language) })}</Info_Alert.Description>
          </Info_Alert>
        ))}

        {reviewing ? (
          <div className={cn('grid items-start gap-6', viewerBlocks.length > 0 && (shell ? '@xl/record:grid-cols-2' : '@3xl/record:grid-cols-2'))}>
            {viewerBlocks.length > 0 && <div className={cn('min-w-0 space-y-6', shell ? '@xl/record:sticky @xl/record:top-0' : '@3xl/record:sticky @3xl/record:top-0')}>{viewerBlocks.map((b, i) => renderBlock(b, `review-viewer:${i}`))}</div>}
            <div className="min-w-0 space-y-6">
              <ReviewPanel review={page.review!} activeField={activeField} onPick={setActiveField} {...review!} />
              <ChecksBlock page={page} />
            </div>
          </div>
        ) : (
          <>
            <div className={cn('grid items-start gap-6', (shell ? SHELL_LAYOUT_GRID : LAYOUT_GRID)[page.layout.layout])} data-columns={columns.join(' ')}>
              {columns.map(c => <div key={c} className="min-w-0 space-y-6" data-area={c}>{area(c)}</div>)}
            </div>
            {extra}
            {below && <div className="space-y-6" data-area="below">{area('below')}</div>}
          </>
        )}
      </div>
    </Frame>
  )
}
