/**
 * MarkdownChartBlock - draws ```chart code blocks with the chart kit (25 §5).
 *
 * Body JSON:
 * {
 *   "kind": "bar" | "line" | "donut" | "interval",
 *   "title": "Change in systolic BP vs placebo",
 *   "data": [{ "label": "Trial A", "value": -4.2, "low": -6.1, "high": -2.3 }],
 *   "unit": "mmHg",
 *   "source": "[Trial A](https://doi.org/10.1000/example-a)"
 * }
 *
 * `source` is a small caption under the chart and may hold markdown links. A body that isn't a
 * chart shows as code, with a short line saying what is wrong.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChartColumn } from 'lucide-react'
import { Chart } from '../charts/Chart'
import { IntervalChart } from '../charts/IntervalChart'
import { CodeBlock } from './CodeBlock'
import { Markdown } from './Markdown'
import { PreviewBlockFrame, PreviewBlockHeader } from './PreviewBlockChrome'
import { parseChartSpec } from './chart-spec'

export interface MarkdownChartBlockProps {
  code: string
  className?: string
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}

export function MarkdownChartBlock({ code, className, onUrlClick, onFileClick }: MarkdownChartBlockProps) {
  const { t } = useTranslation()
  const parsed = React.useMemo(() => parseChartSpec(code), [code])

  if (!parsed.ok) {
    return (
      <div className={className} data-chart-invalid={parsed.error}>
        <CodeBlock code={code} language="json" mode="full" />
        <p className="mt-1 flex items-start gap-1.5 text-label-sm text-tertiary">
          <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('chart.invalid', { error: t(`chart.error.${parsed.error}`) })}</span>
        </p>
      </div>
    )
  }

  const { spec } = parsed
  const title = spec.title ?? t('chart.defaultTitle')
  return (
    <PreviewBlockFrame className={className} data-chart-block={spec.kind}>
      <PreviewBlockHeader icon={<ChartColumn />} title={title} />
      <div className="p-3">
        {spec.kind === 'interval'
          ? <IntervalChart data={spec.data} title={title} unit={spec.unit} reference={spec.reference} />
          : <Chart kind={spec.kind} data={spec.data} title={title} unit={spec.unit} />}
      </div>
      {spec.source && (
        <div className="border-t border-subtle px-3 py-1.5 text-label-sm text-tertiary [&_p]:my-0 [&_p]:leading-normal" data-chart-source>
          <span className="sr-only">{t('chart.source')}: </span>
          <Markdown mode="minimal" onUrlClick={onUrlClick} onFileClick={onFileClick}>{spec.source}</Markdown>
        </div>
      )}
    </PreviewBlockFrame>
  )
}
