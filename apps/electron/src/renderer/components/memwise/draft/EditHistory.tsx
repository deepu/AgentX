/**
 * A draft's edits, newest first: who made each, how (chat, editor, command line) and what it
 * touched. Chat edits wait for the person to keep or discard them.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageSquare, PencilLine, Sparkles, Terminal, Undo2 } from 'lucide-react'
import type { MwDraft, MwDraftEdit, MwPlaybook, MwSubmitResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { absoluteTime, relativeTime, resultMessage } from '../format'
import { fileLabel } from './draft-model'

export interface EditActions {
  keep?: (editId: string) => Promise<MwSubmitResult>
  discard?: (editId: string) => Promise<MwSubmitResult>
}

const VIA_ICON: Record<MwDraftEdit['via'], React.ReactNode> = {
  chat: <MessageSquare className="size-3.5" aria-hidden />,
  editor: <PencilLine className="size-3.5" aria-hidden />,
  cli: <Terminal className="size-3.5" aria-hidden />,
}

function useEditAction() {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<{ editId: string; text: string } | null>(null)
  const { t } = useTranslation()
  const run = React.useCallback(async (key: string, editId: string, call: () => Promise<MwSubmitResult>) => {
    setBusy(key)
    setError(null)
    try {
      const r = await call()
      if (!r.applied) setError({ editId, text: resultMessage(r, t) ?? t('memwise.inbox.notApplied') })
    } catch (err) {
      setError({ editId, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }, [t])
  return { busy, error, run }
}

/** One edit: its summary, who and when, what it touched; Keep and Discard while it is pending. */
export function EditRow({ edit, draft, live, actions, now, busy, onRun, error }: {
  edit: MwDraftEdit
  draft: MwDraft
  live?: MwPlaybook | null
  actions: EditActions
  now?: number
  busy?: string | null
  onRun?: (key: string, editId: string, call: () => Promise<MwSubmitResult>) => void
  error?: string
}) {
  const { t, i18n } = useTranslation()
  const pending = edit.status === 'pending'
  const touched = [...new Set(edit.paths.map(p => fileLabel(p, t, draft.playbook, live)))]
  return (
    <li
      className={cn('space-y-1.5 px-4 py-3', pending && 'bg-accent-tint/50', edit.status === 'discarded' && 'opacity-70')}
      data-edit={edit.id}
      data-edit-status={edit.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-label">
        <span className="text-tertiary">{VIA_ICON[edit.via]}</span>
        <span className={cn('min-w-0 flex-1 font-medium text-foreground', edit.status === 'discarded' && 'line-through')}>{edit.summary}</span>
        {pending && <Info_Badge className="bg-accent-tint text-accent" icon={<Sparkles />}>{t('memwise.draft.edit.pending')}</Info_Badge>}
        {edit.status === 'kept' && edit.via === 'chat' && <Info_Badge color="success" icon={<Check />}>{t('memwise.draft.edit.kept')}</Info_Badge>}
        {edit.status === 'discarded' && <Info_Badge color="muted">{t('memwise.draft.edit.discarded')}</Info_Badge>}
      </div>
      <p className="text-label-sm text-secondary">
        {t(`memwise.draft.edit.via.${edit.via}`, { name: edit.byName ?? edit.by })}
        {' · '}
        <span title={absoluteTime(edit.at, i18n.language)}>{relativeTime(edit.at, now, i18n.language)}</span>
      </p>
      {touched.length > 0 && <p className="text-label-sm text-tertiary">{t('memwise.draft.edit.touched', { what: touched.join(', ') })}</p>}
      {pending && (actions.keep || actions.discard) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {actions.keep && (
            <Button size="sm" variant="primary" disabled={!!busy} onClick={() => onRun?.(`keep:${edit.id}`, edit.id, () => actions.keep!(edit.id))} data-action="keep">
              <Check />
              {busy === `keep:${edit.id}` ? t('memwise.inbox.sending') : t('memwise.draft.edit.keep')}
            </Button>
          )}
          {actions.discard && (
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => onRun?.(`discard:${edit.id}`, edit.id, () => actions.discard!(edit.id))} data-action="discard">
              <Undo2 />
              {busy === `discard:${edit.id}` ? t('memwise.inbox.sending') : t('memwise.draft.edit.discard')}
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
    </li>
  )
}

/** The edits waiting for keep or discard, as a bar above the draft's sections. */
export function PendingEdits({ draft, live, actions, now }: { draft: MwDraft; live?: MwPlaybook | null; actions: EditActions; now?: number }) {
  const { t } = useTranslation()
  const { busy, error, run } = useEditAction()
  const pending = draft.edits.filter(e => e.status === 'pending')
  if (pending.length === 0) return null
  return (
    <Info_Alert variant="info" icon={<Sparkles />} data-pending-edits>
      <Info_Alert.Title>{t('memwise.draft.pendingTitle', { count: pending.length })}</Info_Alert.Title>
      <Info_Alert.Description>{t('memwise.draft.pendingDescription')}</Info_Alert.Description>
      <ul className="-mx-3.5 mt-2 divide-y divide-separator border-t border-separator">
        {pending.map(e => (
          <EditRow
            key={e.id}
            edit={e}
            draft={draft}
            live={live}
            actions={actions}
            now={now}
            busy={busy}
            onRun={(k, id, c) => void run(k, id, c)}
            error={error?.editId === e.id ? error.text : undefined}
          />
        ))}
      </ul>
    </Info_Alert>
  )
}

export function EditHistory({ draft, live, actions, now }: { draft: MwDraft; live?: MwPlaybook | null; actions: EditActions; now?: number }) {
  const { t } = useTranslation()
  const { busy, error, run } = useEditAction()
  const edits = [...draft.edits].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (edits.length === 0) return <p className="px-4 py-3 text-label text-tertiary">{t('memwise.draft.edit.none')}</p>
  return (
    <ul className="divide-y divide-separator" data-edit-history>
      {edits.map(e => (
        <EditRow
          key={e.id}
          edit={e}
          draft={draft}
          live={live}
          actions={actions}
          now={now}
          busy={busy}
          onRun={(k, id, c) => void run(k, id, c)}
          error={error?.editId === e.id ? error.text : undefined}
        />
      ))}
    </ul>
  )
}
