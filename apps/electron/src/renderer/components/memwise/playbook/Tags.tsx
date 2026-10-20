import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwEffectClass } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { EFFECT_CLASSES, TONE_CLASSES, effectLabel, type PerformerLabel } from './labels'

/** Small rounded tag, as in the playbook mockup. */
export function Pill({ className, children, title }: { className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-label-sm font-medium [&_svg]:size-3', className)}
    >
      {children}
    </span>
  )
}

export function PerformerTag({ performer, className }: { performer: PerformerLabel; className?: string }) {
  return <Pill className={cn(TONE_CLASSES[performer.tone], className)}>{performer.label}</Pill>
}

export function EffectBadge({ effect, classified = true, className }: { effect: MwEffectClass; classified?: boolean; className?: string }) {
  const { t } = useTranslation()
  // A tool that declared no effect class counts as one that can't be undone.
  const shown = classified ? effect : 'irreversible'
  return (
    <Pill
      className={cn(EFFECT_CLASSES[shown], className)}
      title={classified ? undefined : t('memwise.playbook.tools.unclassified')}
    >
      {effectLabel(shown, t)}
    </Pill>
  )
}
