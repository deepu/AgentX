/**
 * An entity's lifecycle (24 §4): the statuses along the main path as a row of boxes joined by
 * their transition names, then every move in a table with who may make it, its guard and
 * whether it needs a signature. Plain boxes, so it reads the same in light and dark.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Clock, Lock } from 'lucide-react'
import type { MwEntityDefinition } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'

type Lifecycle = NonNullable<MwEntityDefinition['lifecycle']>

/** The main path: from the initial status, following each status's first move to a status not yet on the path. */
export function mainPath(lc: Lifecycle): { state: string; via?: string }[] {
  const byName = new Map(lc.states.map(s => [s.name, s]))
  const path: { state: string; via?: string }[] = []
  const seen = new Set<string>()
  let at: string | undefined = lc.initial
  let via: string | undefined
  while (at && byName.has(at) && !seen.has(at)) {
    seen.add(at)
    path.push({ state: at, ...(via ? { via } : {}) })
    const next: { transition: string; to: string } | undefined = byName.get(at)!.on.find(o => !seen.has(o.to))
    at = next?.to
    via = next?.transition
  }
  // Statuses off the main path still show, after it.
  for (const s of lc.states) if (!seen.has(s.name)) path.push({ state: s.name })
  return path
}

export function LifecycleDiagram({ lifecycle, current }: { lifecycle: Lifecycle; current?: string }) {
  const { t } = useTranslation()
  const states = new Map(lifecycle.states.map(s => [s.name, s]))
  const transitions = new Map(lifecycle.transitions.map(tr => [tr.name, tr]))
  const path = mainPath(lifecycle)
  const moves = lifecycle.states.flatMap(s => s.on.map(o => ({ from: s.name, ...o })))
  return (
    <div className="space-y-4 p-3.5" data-lifecycle-diagram>
      <ol className="flex flex-wrap items-stretch gap-y-3">
        {path.map((p, i) => {
          const s = states.get(p.state)
          const tr = p.via ? transitions.get(p.via) : undefined
          return (
            <li key={p.state} className="flex items-center">
              {i > 0 && (
                <span className="flex flex-col items-center px-2 text-label-sm text-tertiary">
                  <span className="whitespace-nowrap">{tr?.label ?? p.via ?? ''}</span>
                  <ArrowRight className="size-3.5" />
                </span>
              )}
              <span
                className={cn('min-w-[7rem] rounded-md px-3 py-2 shadow-elev-1', p.state === current ? 'bg-accent-tint' : 'bg-raised', p.state === lifecycle.initial && 'ring-1 ring-[var(--border-strong)]')}
                data-state={p.state}
              >
                <span className="block text-label font-medium text-foreground">{s?.label ?? p.state}</span>
                {s?.timers.map(timer => (
                  <span key={timer} className="mt-0.5 flex items-center gap-1 text-label-sm text-tertiary"><Clock className="size-3" />{timer}</span>
                ))}
              </span>
            </li>
          )
        })}
      </ol>
      {moves.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-label-sm" data-moves>
            <thead>
              <tr className="text-left text-tertiary">
                <th className="py-1 pr-3 font-medium">{t('memwise.entities.move')}</th>
                <th className="py-1 pr-3 font-medium">{t('memwise.entities.fromTo')}</th>
                <th className="py-1 pr-3 font-medium">{t('memwise.entities.whoMay')}</th>
                <th className="py-1 font-medium">{t('memwise.entities.only')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {moves.map(m => {
                const tr = transitions.get(m.transition)
                return (
                  <tr key={`${m.from}:${m.transition}`} data-move={m.transition}>
                    <td className="py-1.5 pr-3 font-medium text-foreground">
                      {tr?.label ?? m.transition}
                      {tr?.signed && <Lock className="ml-1 inline size-3 text-tertiary" aria-label={t('memwise.record.needsSignature')} />}
                    </td>
                    <td className="py-1.5 pr-3 text-secondary">{states.get(m.from)?.label ?? m.from} → {states.get(m.to)?.label ?? m.to}</td>
                    <td className="py-1.5 pr-3 text-secondary">{tr?.by.length ? tr.by.join(', ') : t('memwise.entities.anyone')}</td>
                    <td className="py-1.5 text-secondary">
                      {[tr?.guard ? t('memwise.entities.when', { condition: tr.guard }) : null, tr?.signed ? t('memwise.entities.signedOnly') : null].filter(Boolean).join(' · ') || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
