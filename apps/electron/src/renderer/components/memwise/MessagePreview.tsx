/**
 * A message about to go to someone outside, read as the message it is (Phase 5): who gets it and
 * by which channel first, then the subject (email) and the words as they will arrive. Used by the
 * inbox's approval of an invite and by the case's "Send again".
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Mail, MessageCircle } from 'lucide-react'
import type { MwChannelName } from '@memwise/shared/protocol'
import { Info_Badge } from '@/components/info/Info_Badge'
import { cn } from '@/lib/utils'

export interface MessagePreviewProps {
  channel?: MwChannelName
  to: string
  subject?: string
  body: string
  /** Other labelled values (e.g. when the link expires), shown under the recipient. */
  extra?: { label: string; value: string }[]
  className?: string
}

export function MessagePreview({ channel, to, subject, body, extra, className }: MessagePreviewProps) {
  const { t } = useTranslation()
  const Icon = channel === 'whatsapp' ? MessageCircle : Mail
  return (
    <div className={cn('divide-y divide-separator', className)} data-preview="message" data-channel={channel ?? 'email'}>
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-fill-hover text-secondary"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-label-sm text-tertiary">{t('memwise.message.to')}</div>
          <div className="text-label font-medium text-foreground [overflow-wrap:anywhere]" data-recipient>{to}</div>
        </div>
        <Info_Badge color="default">{channel === 'whatsapp' ? t('memwise.message.whatsapp') : t('memwise.message.email')}</Info_Badge>
      </div>
      {subject !== undefined && subject !== '' && (
        <div className="flex gap-3 px-4 py-2.5 text-label">
          <span className="w-16 shrink-0 text-secondary">{t('memwise.inbox.email.subject')}</span>
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{subject}</span>
        </div>
      )}
      {extra?.map(row => (
        <div key={row.label} className="flex gap-3 px-4 py-2.5 text-label">
          <span className="w-16 shrink-0 text-secondary">{row.label}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{row.value}</span>
        </div>
      ))}
      <div className="px-4 py-3">
        {channel === 'whatsapp' ? (
          <div className="max-w-md rounded-lg rounded-tl-sm bg-success-tint px-3 py-2 text-label text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]" data-body>{body}</div>
        ) : (
          <div className="text-label whitespace-pre-wrap [overflow-wrap:anywhere]" data-body>{body}</div>
        )}
      </div>
    </div>
  )
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)

export interface MessageShape {
  channel?: MwChannelName
  to: string
  subject?: string
  body: string
  rest: Record<string, unknown>
}

/**
 * Whether an effect's preview is a message to someone (an invite, `email.send`, `whatsapp.send`):
 * a recipient and words. The channel comes from the preview (`via`, `channel`) or the tool's name.
 */
export function messageShape(tool: string, detail: unknown): MessageShape | null {
  if (!isRecord(detail)) return null
  const { to, via, channel, subject, body, text: plain, message, ...rest } = detail
  const words = text(body) ?? text(plain) ?? text(message)
  const recipient = Array.isArray(to) ? to.map(String).join(', ') : text(to)
  if (!recipient || words === undefined) return null
  const named = text(via) ?? text(channel)
  const ch: MwChannelName | undefined = named === 'whatsapp' || named === 'email'
    ? named
    : tool.startsWith('whatsapp.') ? 'whatsapp' : tool.startsWith('email.') || subject !== undefined ? 'email' : undefined
  return { channel: ch, to: recipient, subject: text(subject), body: words, rest }
}
