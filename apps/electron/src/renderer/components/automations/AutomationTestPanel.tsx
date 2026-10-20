/**
 * AutomationTestPanel
 *
 * Inline panel displaying test execution results.
 * Uses Info_Alert variants for consistent styling.
 */

import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Spinner } from '@memwise/ui'
import { Info_Alert } from '@/components/info'
import { cn } from '@/lib/utils'
import type { TestResult } from './types'

export interface AutomationTestPanelProps {
  result: TestResult
  className?: string
}

export function AutomationTestPanel({ result, className }: AutomationTestPanelProps) {
  const { t } = useTranslation()
  if (result.state === 'idle') return null

  // Running state
  if (result.state === 'running') {
    return (
      <div className={cn('flex items-center gap-2 px-3.5 py-3 text-label text-tertiary', className)}>
        <Spinner />
        <span>{t('automations.testRunning')}</span>
      </div>
    )
  }

  // Success state
  if (result.state === 'success') {
    return (
      <Info_Alert variant="success" icon={<CheckCircle2 />} className={className}>
        <Info_Alert.Title>
          {t('automations.testPassed')}
          {result.duration != null && (
            <span className="ml-2 text-label-sm font-normal text-tertiary tabular-nums">
              {result.duration}ms
            </span>
          )}
        </Info_Alert.Title>
      </Info_Alert>
    )
  }

  // Error state
  if (result.state === 'error') {
    return (
      <Info_Alert variant="error" icon={<XCircle />} className={className}>
        <Info_Alert.Title>{t('automations.testFailed')}</Info_Alert.Title>
        {result.stderr && (
          <Info_Alert.Description>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-mono-ui text-destructive">{result.stderr}</pre>
          </Info_Alert.Description>
        )}
      </Info_Alert>
    )
  }

  return null
}
