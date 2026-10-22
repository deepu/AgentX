/**
 * Small pieces the regulated-project screens share: a bordered table in the mocks' style, the
 * readable diff (struck out, underlined), the right column's frame with its breadcrumb.
 */

import * as React from 'react'
import type { MwDiffSegment } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'

/** The right column's page: breadcrumb, title, subtitle, actions, then the sections. ~900px wide. */
export function RegulatedPage({ crumbs, title, subtitle, actions, badge, children, footer, ...rest }: {
  crumbs?: string[]
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  badge?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className="flex h-full min-h-0 flex-col" {...rest}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] space-y-5 px-7 pb-6 pt-1.5">
          {crumbs && crumbs.length > 0 && (
            <nav className="text-label text-secondary" data-breadcrumbs aria-label={crumbs.join(' › ')}>{crumbs.join('  ›  ')}</nav>
          )}
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[22px] font-semibold leading-tight text-foreground">{title}</h1>
                {badge}
              </div>
              {subtitle && <p className="text-label text-secondary">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </header>
          {children}
        </div>
      </div>
      {footer && (
        <div className="border-t border-separator">
          <div className="mx-auto flex w-full max-w-[900px] flex-wrap items-center gap-3 px-7 py-3">{footer}</div>
        </div>
      )}
    </div>
  )
}

export function Section({ title, actions, children, ...rest }: { title: string; actions?: React.ReactNode; children: React.ReactNode } & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className="space-y-2" {...rest}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-label font-semibold text-foreground">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** A bordered table: a quiet header row, hairlines between rows. */
export function Table({ head, children, className, ...rest }: { head: React.ReactNode[]; children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-separator">
      <table className={cn('w-full border-collapse text-label', className)} {...rest}>
        <thead>
          <tr className="border-b border-separator text-left text-label-sm text-secondary">
            {head.map((h, i) => <th key={i} className="px-3.5 py-2.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-separator">{children}</tbody>
      </table>
    </div>
  )
}

export function Cell({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3.5 py-2.5 align-top', className)} {...rest}>{children}</td>
}

/** Diff segments: kept text plain, removed struck through, added underlined in the accent. */
export function DiffText({ segments }: { segments: MwDiffSegment[] }) {
  return (
    <>
      {segments.map((s, i) => s.kind === 'same'
        ? <React.Fragment key={i}>{s.text}</React.Fragment>
        : s.kind === 'removed'
          ? <del key={i} className="text-tertiary line-through" data-diff="removed">{s.text}</del>
          : <ins key={i} className="text-accent underline decoration-accent/50 underline-offset-2" data-diff="added">{s.text}</ins>)}
    </>
  )
}

/** A number in a KPI tile (EIndex): the label, the figure, a line under it. */
export function Kpi({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: string; tone?: 'warning' | 'success' }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-separator px-4 py-3" data-kpi={label}>
      <p className="text-label-sm text-secondary">{label}</p>
      <p className={cn('text-[24px] font-semibold leading-tight', tone === 'warning' ? 'text-info' : tone === 'success' ? 'text-success' : 'text-foreground')}>{value}</p>
      {note && <p className="text-label-sm text-secondary">{note}</p>}
    </div>
  )
}
