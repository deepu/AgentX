import { useTranslation } from 'react-i18next'
import type { MwPolicyRule } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pill } from './Tags'
import { layerLabel, subjectLabel, treatmentOf, valueLabel } from './labels'

const VALUE_CLASSES = {
  allow: 'text-foreground',
  preview: 'text-info',
  approve: 'text-info',
  deny: 'text-destructive',
} as const

/** Lets a long path wrap after its slashes rather than mid-word. */
function breakAtSlashes(path: string) {
  return path.split('/').map((part, i, all) => (
    <span key={i}>
      {part}
      {i < all.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </span>
  ))
}

export interface EffectivePolicyViewProps {
  rules: MwPolicyRule[]
  className?: string
}

/** The rules a step runs under, each with the layer it came from (platform, domain, playbook, step). */
export function EffectivePolicyView({ rules, className }: EffectivePolicyViewProps) {
  const { t } = useTranslation()
  if (!rules.length) {
    return <p className={cn('text-label text-tertiary', className)}>{t('memwise.playbook.policy.empty')}</p>
  }
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-raised', className)}>
      <Table className="text-label">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="bg-raised px-3 py-2 text-label-sm text-tertiary">{t('memwise.playbook.policy.rule')}</TableHead>
            <TableHead className="bg-raised px-3 py-2 text-label-sm text-tertiary">{t('memwise.playbook.policy.value')}</TableHead>
            <TableHead className="bg-raised px-3 py-2 text-label-sm text-tertiary">{t('memwise.playbook.policy.from')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule, i) => {
            const treatment = treatmentOf(rule.value)
            return (
              <TableRow key={`${rule.subject}-${i}`} className={cn('hover:bg-fill-hover', rule.notEnforced && 'text-tertiary')}>
                <TableCell className="px-3 py-2 align-top font-medium">{subjectLabel(rule.subject, t)}</TableCell>
                <TableCell className="px-3 py-2 align-top">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span className={cn(treatment && !rule.notEnforced ? VALUE_CLASSES[treatment] : undefined)}>{valueLabel(rule.value, t)}</span>
                    {rule.notEnforced && (
                      <Pill className="bg-fill-selected text-tertiary" title={t('memwise.playbook.policy.notEnforcedHint')}>
                        {t('memwise.playbook.policy.notEnforced')}
                      </Pill>
                    )}
                  </span>
                </TableCell>
                <TableCell className="px-3 py-2 align-top">
                  <div>{layerLabel(rule, t)}</div>
                  {rule.source && <div className="font-mono text-[11px] leading-4 text-tertiary">{breakAtSlashes(rule.source)}</div>}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
