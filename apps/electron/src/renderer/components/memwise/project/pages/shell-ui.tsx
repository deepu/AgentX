/**
 * Small pieces the project shell's pages share (docs/memwise/26-projects-and-pages.md §2, mocks
 * `Playbook`, `Run`, `Sites`, `Documents`, `Site`, `Document`, `Sign`): the page's buttons, the
 * bordered tables, tags and the chips a chat puts above a list.
 */

import * as React from 'react'
import { Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ShellButton({ kind = 'outline', busy, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'solid' | 'outline' | 'quiet'
  busy?: boolean
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[7px] px-3 text-label font-medium transition-colors disabled:opacity-50 [&_svg]:size-3.5',
        kind === 'solid' && 'bg-foreground text-background hover:bg-foreground/85',
        kind === 'outline' && 'border border-foreground/15 bg-background text-foreground hover:bg-fill-hover',
        kind === 'quiet' && 'text-secondary hover:bg-fill-hover hover:text-foreground',
        className,
      )}
    >
      {busy && <Loader2 className="animate-spin" />}
      {children}
    </button>
  )
}

/** A bordered table, as the mocks draw them: a small header row, then rows split by hairlines. */
export function ShellTable({ head, children, className, testId }: { head: React.ReactNode[]; children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-[10px] border border-foreground/10', className)} data-testid={testId}>
      <table className="w-full border-collapse text-left text-label">
        <thead>
          <tr className="border-b border-foreground/8 text-label-sm font-semibold text-secondary">
            {head.map((h, i) => <th key={i} className="px-4 py-2 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr:not(:last-child)]:border-b [&>tr]:border-foreground/6">{children}</tbody>
      </table>
    </div>
  )
}

export type TagTone = 'green' | 'amber' | 'violet' | 'muted' | 'red'

const TONE: Record<TagTone, string> = {
  green: 'bg-success-tint text-success',
  amber: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
  violet: 'bg-accent-tint text-accent',
  muted: 'bg-foreground/6 text-secondary',
  red: 'bg-destructive/10 text-destructive',
}

export function Tag({ tone = 'muted', children, className, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { tone?: TagTone }) {
  return <span {...rest} className={cn('inline-flex items-center rounded-[5px] px-1.5 py-px text-label-sm font-medium', TONE[tone], className)}>{children}</span>
}

/** Text in a status colour, as the tables' last column has it. */
export function ToneText({ tone, children }: { tone: TagTone; children: React.ReactNode }) {
  return <span className={cn(tone === 'green' && 'text-success', tone === 'amber' && 'text-amber-700 dark:text-amber-400', tone === 'violet' && 'text-accent', tone === 'muted' && 'text-secondary', tone === 'red' && 'text-destructive')}>{children}</span>
}

/** A chip a chat put above a list ("Below 80% · from chat ×"). */
export function ChatChip({ label, from, onClear, clearLabel }: { label: string; from?: string; onClear?: () => void; clearLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent/8 py-0.5 pl-3 pr-1.5 text-label-sm text-accent" data-testid="chat-chip">
      {label}{from && <span className="opacity-80"> · {from}</span>}
      {onClear && (
        <button type="button" aria-label={clearLabel} onClick={onClear} className="grid size-4 place-items-center rounded-full hover:bg-accent/15" data-action="clear-chat-filter">
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
