import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Flag, Hourglass } from 'lucide-react'
import type { MwLiveCounts, MwPlaybook, MwRole } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { PerformerTag } from '../playbook/Tags'
import { formatDuration, humanize, performerLabel, stateTitle, stepOf } from '../playbook/labels'
import { END_ID, TIMEOUT_EVENT, edgePath, endAngle, layoutWorkflow, type MapEdge, type MapEdgeKind, type MapNode } from './layout'

export interface WorkflowMapProps {
  playbook: MwPlaybook
  /** design: the shape only. live: open cases per step and how often each path is taken. */
  mode?: 'design' | 'live'
  live?: MwLiveCounts
  /** One case's states in order; visited steps and paths are highlighted, the last is "now". */
  highlightPath?: string[]
  onSelectState?: (stateId: string) => void
  /** Role titles for assignee tags. */
  roles?: MwRole[]
  selectedStateId?: string
  className?: string
}

const STROKE: Record<MapEdgeKind | 'visited', string> = {
  forward: 'var(--text-tertiary)',
  back: 'var(--text-tertiary)',
  failure: 'var(--destructive-raw)',
  visited: 'var(--accent-raw)',
}

function edgeWidth(count: number | undefined, max: number): number {
  if (!count || max <= 0) return 1.25
  return 1.5 + 4 * (Math.log1p(count) / Math.log1p(max))
}

/** The playbook drawn left to right, problems below. View only. */
export function WorkflowMap({ playbook, mode = 'design', live, highlightPath, onSelectState, roles, selectedStateId, className }: WorkflowMapProps) {
  const { t } = useTranslation()
  const layout = React.useMemo(() => layoutWorkflow(playbook), [playbook])
  const markerBase = React.useId().replace(/:/g, '')
  const isLive = mode === 'live' && !!live

  const path = highlightPath?.length ? highlightPath : undefined
  const visited = React.useMemo(() => new Set(path ?? []), [path])
  const visitedEdges = React.useMemo(() => {
    const out = new Set<string>()
    if (path) for (let i = 1; i < path.length; i++) out.add(`${path[i - 1]}>${path[i]}`)
    return out
  }, [path])
  const current = path?.[path.length - 1]

  const maxEdge = isLive ? Math.max(0, ...Object.values(live!.edges)) : 0

  const edgeText = (edge: MapEdge) =>
    edge.events
      .map((e) => (e === TIMEOUT_EVENT && edge.timeoutMs !== undefined ? t('memwise.map.timeoutAfter', { duration: formatDuration(edge.timeoutMs, t) }) : humanize(e)))
      .join(', ')

  const markerId = (key: string) => `${markerBase}-${key}`

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className="overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-sunken"
        style={{ backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)', backgroundSize: '18px 18px' }}
        role="figure"
        aria-label={t('memwise.map.label', { title: playbook.title })}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg width={layout.width} height={layout.height} className="absolute inset-0" aria-hidden>
            <defs>
              {(['forward', 'failure', 'visited'] as const).map((key) => (
                <marker key={key} id={markerId(key)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                  <path d="M 0 1 L 9 5 L 0 9 z" fill={STROKE[key]} />
                </marker>
              ))}
            </defs>
            {layout.edges.map((edge) => {
              const key = `${edge.from}>${edge.to}`
              const on = visitedEdges.has(key)
              const dim = !!path && !on
              const count = isLive ? live!.edges[key] : undefined
              const width = on ? Math.max(2.25, edgeWidth(count, maxEdge)) : edgeWidth(count, maxEdge)
              const stroke = on ? STROKE.visited : STROKE[edge.kind]
              return (
                <path
                  key={key}
                  d={edgePath(edge.points)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeOpacity={dim ? 0.35 : edge.kind === 'failure' && !on ? 0.75 : 1}
                  strokeDasharray={edge.kind === 'back' && !on ? '5 4' : undefined}
                  strokeLinecap="round"
                  markerEnd={`url(#${markerId(on ? 'visited' : edge.kind === 'failure' ? 'failure' : 'forward')})`}
                  data-edge={key}
                  data-angle={Math.round(endAngle(edge.points))}
                />
              )
            })}
          </svg>

          {layout.edges.map((edge) => {
            const key = `${edge.from}>${edge.to}`
            const on = visitedEdges.has(key)
            const count = isLive ? live!.edges[key] : undefined
            return (
              <span
                key={`label-${key}`}
                className={cn(
                  'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-sunken px-1 text-[11px] leading-4',
                  on ? 'font-medium text-accent' : edge.kind === 'failure' ? 'text-destructive' : 'text-secondary',
                  path && !on && 'opacity-60',
                )}
                style={{ left: edge.labelAt.x, top: edge.labelAt.y }}
              >
                {edgeText(edge)}
                {count ? <span className="ml-1 text-tertiary tabular-nums">· {count}</span> : null}
              </span>
            )
          })}

          {layout.nodes.map((node) => (
            <MapNodeCard
              key={node.id}
              node={node}
              playbook={playbook}
              roles={roles}
              count={isLive ? live!.byState[node.id] : undefined}
              visited={visited.has(node.id)}
              current={current === node.id}
              dim={!!path && !visited.has(node.id)}
              selected={selectedStateId === node.id}
              onSelect={onSelectState && node.id !== END_ID ? () => onSelectState(node.id) : undefined}
            />
          ))}
        </div>
      </div>
      <Legend live={isLive} highlighted={!!path} />
    </div>
  )
}

function MapNodeCard({
  node,
  playbook,
  roles,
  count,
  visited,
  current,
  dim,
  selected,
  onSelect,
}: {
  node: MapNode
  playbook: MwPlaybook
  roles?: MwRole[]
  count?: number
  visited: boolean
  current: boolean
  dim: boolean
  selected: boolean
  onSelect?: () => void
}) {
  const { t } = useTranslation()
  const style = { left: node.x, top: node.y, width: node.w, height: node.h }

  if (node.id === END_ID) {
    return (
      <div
        className={cn(
          'absolute flex items-center justify-center gap-1.5 rounded-full border border-border bg-raised text-label font-medium text-secondary',
          visited && 'border-accent text-accent',
          current && 'ring-2 ring-accent/50',
          dim && 'opacity-60',
        )}
        style={{ ...style, top: node.y + 14, height: node.h - 28 }}
      >
        <Flag className="size-3.5" aria-hidden />
        {stateTitle(playbook, END_ID, t)}
        {current && <span className="sr-only">{t('memwise.map.now')}</span>}
      </div>
    )
  }

  const state = playbook.states.find((s) => s.id === node.id)
  const step = state ? stepOf(playbook, state) : undefined
  const performer = performerLabel(step, state, t, roles)
  const title = stateTitle(playbook, node.id, t)
  const waiting = !step
  const unreachable = node.row === 'unreachable'
  const Tag = onSelect ? 'button' : 'div'

  return (
    <Tag
      {...(onSelect ? { type: 'button' as const, onClick: onSelect } : {})}
      title={unreachable ? t('memwise.map.unreachable') : undefined}
      aria-current={current ? 'step' : undefined}
      className={cn(
        'absolute flex flex-col items-start justify-between gap-1 overflow-visible rounded-lg border bg-raised px-2.5 py-2 text-left shadow-sm transition-colors',
        waiting || unreachable ? 'border-dashed border-strong' : 'border-border',
        onSelect && 'cursor-pointer hover:border-strong hover:bg-floating focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        visited && 'border-accent/60',
        current && 'border-accent ring-2 ring-accent/40',
        selected && !current && 'ring-2 ring-foreground/20',
        dim && 'opacity-60',
      )}
      style={style}
    >
      <span className="flex w-full items-center gap-1.5">
        {waiting && <Hourglass className="size-3 shrink-0 text-tertiary" aria-hidden />}
        <PerformerTag performer={performer} className="h-[18px] px-1.5 text-[11px]" />
        {current && <span className="ml-auto rounded-full bg-accent-solid px-1.5 text-[11px] font-medium leading-[18px] text-on-accent">{t('memwise.map.now')}</span>}
      </span>
      <span className="line-clamp-2 w-full text-label font-medium leading-[17px] text-foreground">{title}</span>
      {count !== undefined && count > 0 && (
        <span
          className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-semibold text-background tabular-nums shadow-sm"
          title={t('memwise.map.openCases', { count })}
        >
          {count}
        </span>
      )}
    </Tag>
  )
}

function Legend({ live, highlighted }: { live: boolean; highlighted: boolean }) {
  const { t } = useTranslation()
  const line = (stroke: string, dash?: string) => (
    <svg width="22" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" stroke={stroke} strokeWidth="1.75" strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-label-sm text-tertiary">
      <span className="inline-flex items-center gap-1.5">{line(STROKE.forward)}{t('memwise.map.legend.forward')}</span>
      <span className="inline-flex items-center gap-1.5">{line(STROKE.back, '5 4')}{t('memwise.map.legend.back')}</span>
      <span className="inline-flex items-center gap-1.5">{line(STROKE.failure)}{t('memwise.map.legend.failure')}</span>
      {highlighted && <span className="inline-flex items-center gap-1.5">{line(STROKE.visited)}{t('memwise.map.legend.path')}</span>}
      {live && <span>{t('memwise.map.legend.live')}</span>}
    </div>
  )
}
