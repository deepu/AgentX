/**
 * Layout for the playbook map (05 §9): a small layered layout, no graph library.
 *
 * The happy path (start, then each state's first outcome that goes somewhere new) runs left to
 * right on the main row and ends at `end`. States reached only through failure-like outcomes or
 * timeouts sit in a row below; other branches sit in a row above; states nothing reaches sit at
 * the bottom. Edges inside a row that skip a column or go backwards are drawn as arcs, each arc on
 * its own level so they never coincide. Pure: same playbook in, same geometry out.
 */

import type { MwPlaybook } from '@memwise/shared/protocol'

export const END_ID = 'end'

export type MapRow = 'upper' | 'main' | 'lower' | 'unreachable'
export type MapEdgeKind = 'forward' | 'back' | 'failure'

export interface MapPoint {
  x: number
  y: number
}

export interface MapNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  row: MapRow
  col: number
}

export interface MapEdge {
  from: string
  to: string
  /** Outcome names in plain words, joined ("failed, needs person"); timeouts read "timeout". */
  label: string
  /** Raw events on this edge, in definition order. `timeout` marks the wait timeout. */
  events: string[]
  /** Set when one of the events is the wait timeout. */
  timeoutMs?: number
  kind: MapEdgeKind
  /** Two points: a straight line. Four points: a cubic Bézier (start, control, control, end). */
  points: MapPoint[]
  /** Where the label's centre goes. */
  labelAt: MapPoint
}

export interface MapLayout {
  nodes: MapNode[]
  edges: MapEdge[]
  width: number
  height: number
}

export const NODE_W = 184
export const NODE_H = 78
const END_W = 120
const COL_GAP = 84
const PAD = 24
const ROW_GAP = 96
const ARC_STEP = 22
const ARC_BASE = 26
const SELF_LOOP = 30

export const TIMEOUT_EVENT = 'timeout'

const FAILURE = /(fail|error|timeout|timed_out|needs_person|reject|declin|stop|cancel|abort|escalat)/i

/** Outcome names that read as something going wrong. */
export function isFailureEvent(event: string): boolean {
  return FAILURE.test(event)
}

export function humanizeEvent(event: string): string {
  return event.replace(/[_-]+/g, ' ').trim()
}

interface RawEdge {
  from: string
  to: string
  events: string[]
  timeoutMs?: number
  failure: boolean
}

/** Every transition of the playbook, parallel ones (same from and to) merged. */
export function collectEdges(playbook: MwPlaybook): RawEdge[] {
  const byKey = new Map<string, RawEdge>()
  const add = (from: string, to: string, event: string, timeoutMs?: number) => {
    const key = `${from}>${to}`
    let edge = byKey.get(key)
    if (!edge) {
      edge = { from, to, events: [], failure: true }
      byKey.set(key, edge)
    }
    if (!edge.events.includes(event)) edge.events.push(event)
    if (timeoutMs !== undefined) edge.timeoutMs = timeoutMs
  }
  for (const state of playbook.states) {
    for (const [event, target] of Object.entries(state.on)) add(state.id, target, event)
    const timeout = state.wait?.timeout
    if (timeout) add(state.id, timeout.target, TIMEOUT_EVENT, timeout.afterMs)
  }
  for (const edge of byKey.values()) {
    edge.failure = edge.events.every((e) => e === TIMEOUT_EVENT || isFailureEvent(e))
  }
  return [...byKey.values()]
}

/** The main row: start, then the first outcome of each state that leads somewhere new. */
export function happyPath(playbook: MwPlaybook): string[] {
  const known = new Set(playbook.states.map((s) => s.id))
  const path: string[] = []
  if (!known.has(playbook.start)) return [END_ID]
  const seen = new Set<string>()
  let current: string | undefined = playbook.start
  while (current && current !== END_ID && !seen.has(current)) {
    seen.add(current)
    path.push(current)
    const state = playbook.states.find((s) => s.id === current)
    if (!state) break
    const targets = Object.entries(state.on)
    const pick: [string, string] | undefined =
      targets.find(([e, to]) => !isFailureEvent(e) && !seen.has(to) && (known.has(to) || to === END_ID)) ??
      targets.find(([, to]) => !seen.has(to) && (known.has(to) || to === END_ID))
    current = pick?.[1]
  }
  path.push(END_ID)
  return path
}

interface Placed {
  row: MapRow
  col: number
}

function placeRows(playbook: MwPlaybook, edges: RawEdge[]): Map<string, Placed> {
  const placed = new Map<string, Placed>()
  const main = happyPath(playbook)
  main.forEach((id, col) => placed.set(id, { row: 'main', col }))

  const taken: Record<MapRow, Set<number>> = {
    upper: new Set(),
    main: new Set(main.map((_, i) => i)),
    lower: new Set(),
    unreachable: new Set(),
  }
  const claim = (row: MapRow, wanted: number): number => {
    let col = Math.max(0, wanted)
    while (taken[row].has(col)) col++
    taken[row].add(col)
    return col
  }

  // Off-path states, in the order a breadth-first walk from the main row reaches them.
  const ids = playbook.states.map((s) => s.id)
  const incoming = (id: string) => edges.filter((e) => e.to === id && e.from !== id)
  const queue = [...main]
  const reached = new Set(main)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    for (const e of edges) {
      if (e.from !== id || reached.has(e.to)) continue
      if (!ids.includes(e.to)) continue
      reached.add(e.to)
      order.push(e.to)
      queue.push(e.to)
    }
  }

  for (const id of order) {
    const fromPlaced = incoming(id).filter((e) => placed.has(e.from))
    const lower = fromPlaced.every((e) => e.failure || placed.get(e.from)!.row === 'lower')
    const row: MapRow = lower ? 'lower' : 'upper'
    const sameRow = fromPlaced.filter((e) => placed.get(e.from)!.row === row)
    let wanted: number
    if (sameRow.length) wanted = Math.max(...sameRow.map((e) => placed.get(e.from)!.col)) + 1
    else if (fromPlaced.length) {
      const cols = fromPlaced.map((e) => placed.get(e.from)!.col)
      wanted = Math.round(cols.reduce((a, b) => a + b, 0) / cols.length)
    } else wanted = 0
    placed.set(id, { row, col: claim(row, wanted) })
  }

  for (const id of ids) {
    if (placed.has(id)) continue
    placed.set(id, { row: 'unreachable', col: claim('unreachable', 0) })
  }
  return placed
}

interface ArcPlan {
  edge: RawEdge
  level: number
  side: 'above' | 'below'
}

/** Gives each same-row arc a level so that arcs whose spans overlap never share a height. */
function planArcs(arcs: { edge: RawEdge; a: number; b: number; side: 'above' | 'below'; row: MapRow }[]): ArcPlan[] {
  const out: ArcPlan[] = []
  const groups = new Map<string, typeof arcs>()
  for (const arc of arcs) {
    const key = `${arc.row}:${arc.side}`
    groups.set(key, [...(groups.get(key) ?? []), arc])
  }
  for (const group of groups.values()) {
    group.sort((x, y) => Math.abs(x.b - x.a) - Math.abs(y.b - y.a) || Math.min(x.a, x.b) - Math.min(y.a, y.b))
    const levels: { lo: number; hi: number }[][] = []
    for (const arc of group) {
      const lo = Math.min(arc.a, arc.b)
      const hi = Math.max(arc.a, arc.b)
      let level = 0
      while (levels[level]?.some((s) => !(hi <= s.lo || lo >= s.hi))) level++
      ;(levels[level] ??= []).push({ lo, hi })
      out.push({ edge: arc.edge, level, side: arc.side })
    }
  }
  return out
}

const ROW_ORDER: MapRow[] = ['upper', 'main', 'lower', 'unreachable']

export function layoutWorkflow(playbook: MwPlaybook): MapLayout {
  const edges = collectEdges(playbook)
  const placed = placeRows(playbook, edges)
  const rowOf = (id: string) => placed.get(id)?.row
  const colOf = (id: string) => placed.get(id)?.col ?? 0

  // Arcs: same-row edges that skip a column or go backwards.
  const arcCandidates: { edge: RawEdge; a: number; b: number; side: 'above' | 'below'; row: MapRow }[] = []
  for (const e of edges) {
    if (e.from === e.to || !placed.has(e.from) || !placed.has(e.to)) continue
    const row = rowOf(e.from)!
    if (row !== rowOf(e.to)) continue
    const a = colOf(e.from)
    const b = colOf(e.to)
    if (b === a + 1) continue
    arcCandidates.push({ edge: e, a, b, row, side: row === 'upper' || row === 'main' ? 'above' : 'below' })
  }
  const arcs = planArcs(arcCandidates)
  const levelsUsed = (row: MapRow, side: 'above' | 'below') => {
    const ls = arcs.filter((p) => rowOf(p.edge.from) === row && p.side === side).map((p) => p.level + 1)
    return ls.length ? Math.max(...ls) : 0
  }
  const hasSelfLoop = (row: MapRow) => edges.some((e) => e.from === e.to && rowOf(e.from) === row)

  // Vertical bands, top to bottom: for each row that has nodes, the space its arcs and self-loops
  // need above it, the nodes, then the space for arcs below it.
  const rowY = new Map<MapRow, number>()
  let y = PAD
  let previous = false
  for (const row of ROW_ORDER) {
    const has = [...placed.values()].some((p) => p.row === row)
    if (!has) continue
    if (previous) y += ROW_GAP
    const above = levelsUsed(row, 'above')
    const aboveSpace = Math.max(above ? ARC_BASE + above * ARC_STEP : 0, hasSelfLoop(row) ? SELF_LOOP + 14 : 0)
    y += aboveSpace
    rowY.set(row, y)
    y += NODE_H
    const below = levelsUsed(row, 'below')
    if (below) y += ARC_BASE + below * ARC_STEP
    previous = true
  }
  const height = y + PAD

  const nodes: MapNode[] = []
  const nodeIds = [...playbook.states.map((s) => s.id), END_ID]
  for (const id of nodeIds) {
    const p = placed.get(id)
    if (!p) continue
    // `end` is a small marker, not a step card.
    const w = id === END_ID ? END_W : NODE_W
    nodes.push({ id, row: p.row, col: p.col, x: PAD + p.col * (NODE_W + COL_GAP), y: rowY.get(p.row)!, w, h: NODE_H })
  }
  const maxRight = Math.max(...nodes.map((n) => n.x + n.w))
  const width = maxRight + PAD
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // Ports: edges leaving or entering a node through its top or bottom are spread along that side.
  const vertical = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to) && rowOf(e.from) !== rowOf(e.to))
  const portX = (node: MapNode, side: 'top' | 'bottom', edge: RawEdge): number => {
    const users = vertical.filter((e) => {
      if (e.from === node.id) return (byId.get(e.to)!.y > node.y ? 'bottom' : 'top') === side
      if (e.to === node.id) return (byId.get(e.from)!.y > node.y ? 'bottom' : 'top') === side
      return false
    })
    // Order by where the other end sits so lines don't cross needlessly.
    // Ties (two edges between the same pair of nodes) break the same way at both ends, downward
    // edges first, so the pair runs side by side instead of crossing.
    users.sort((p, q) => {
      const other = (e: RawEdge) => byId.get(e.from === node.id ? e.to : e.from)!
      const goesDown = (e: RawEdge) => (byId.get(e.to)!.y > byId.get(e.from)!.y ? 0 : 1)
      return other(p).x - other(q).x || goesDown(p) - goesDown(q)
    })
    const i = users.indexOf(edge)
    const n = users.length
    return node.x + node.w * ((i + 1) / (n + 1))
  }

  const arcByEdge = new Map(arcs.map((p) => [p.edge, p]))
  const out: MapEdge[] = []
  for (const e of edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    let kind: MapEdgeKind
    if (e.failure) kind = 'failure'
    else if (e.from === e.to || (a.row === b.row && b.col <= a.col) || (a.row !== 'main' && b.row === 'main')) kind = 'back'
    else kind = 'forward'
    const base = { from: e.from, to: e.to, events: e.events, label: e.events.map(humanizeEvent).join(', '), kind, ...(e.timeoutMs !== undefined ? { timeoutMs: e.timeoutMs } : {}) }

    if (e.from === e.to) {
      const x0 = a.x + a.w - 44
      const x1 = a.x + a.w - 16
      const top = a.y
      out.push({ ...base, points: [{ x: x0, y: top }, { x: x0 - 6, y: top - SELF_LOOP }, { x: x1 + 6, y: top - SELF_LOOP }, { x: x1, y: top }], labelAt: { x: (x0 + x1) / 2, y: top - SELF_LOOP - 4 } })
      continue
    }

    const arc = arcByEdge.get(e)
    if (arc) {
      const dir = arc.side === 'above' ? -1 : 1
      const edgeY = arc.side === 'above' ? a.y : a.y + a.h
      const rise = ARC_BASE + arc.level * ARC_STEP
      // Leave and enter off-centre: forward arcs on the right half, backward ones on the left.
      const backwards = b.col < a.col
      // Outer arcs land further out, so nested arcs don't share an arrowhead.
      const spread = Math.min(0.2, arc.level * 0.1)
      const sx = a.x + a.w * (backwards ? 0.35 - spread : 0.65 + spread)
      const tx = b.x + b.w * (backwards ? 0.65 + spread : 0.35 - spread)
      // Control points at 4/3 of the rise put the curve's peak exactly at `rise`.
      const cy = edgeY + dir * rise * (4 / 3)
      out.push({ ...base, points: [{ x: sx, y: edgeY }, { x: sx, y: cy }, { x: tx, y: cy }, { x: tx, y: edgeY }], labelAt: { x: (sx + tx) / 2, y: edgeY + dir * rise } })
      continue
    }

    if (a.row === b.row) {
      const y0 = a.y + a.h / 2
      const p0 = { x: a.x + a.w, y: y0 }
      const p1 = { x: b.x, y: y0 }
      out.push({ ...base, points: [p0, p1], labelAt: { x: (p0.x + p1.x) / 2, y: y0 - 12 } })
      continue
    }

    const down = b.y > a.y
    const sx = portX(a, down ? 'bottom' : 'top', e)
    const tx = portX(b, down ? 'top' : 'bottom', e)
    const sy = down ? a.y + a.h : a.y
    const ty = down ? b.y : b.y + b.h
    const mid = (sy + ty) / 2
    out.push({ ...base, points: [{ x: sx, y: sy }, { x: sx, y: mid }, { x: tx, y: mid }, { x: tx, y: ty }], labelAt: { x: (sx + tx) / 2, y: mid } })
  }

  separateLabels(out, nodes)
  return { nodes, edges: out, width, height }
}

/** Rough label size; the map renders labels at 11px. Timeouts read "after 7 days" or similar. */
export function estimateLabelWidth(edge: Pick<MapEdge, 'label' | 'timeoutMs'>): number {
  const chars = edge.label.length + (edge.timeoutMs !== undefined ? 10 : 0)
  return Math.min(180, chars * 6.4 + 14)
}
const LABEL_H = 18

/** Nudges labels up or down until none overlaps another label or a node. */
function separateLabels(edges: MapEdge[], nodes: MapNode[]): void {
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = nodes.map((n) => ({ x0: n.x, x1: n.x + n.w, y0: n.y, y1: n.y + n.h }))
  const hits = (b: (typeof boxes)[number]) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
  for (const edge of edges) {
    const w = estimateLabelWidth(edge)
    const { x, y } = edge.labelAt
    for (const dy of [0, -14, 14, -28, 28, -42, 42]) {
      const box = { x0: x - w / 2, x1: x + w / 2, y0: y + dy - LABEL_H / 2, y1: y + dy + LABEL_H / 2 }
      if (!hits(box) || dy === 42) {
        edge.labelAt = { x, y: y + dy }
        boxes.push(box)
        break
      }
    }
  }
}

/** SVG path data for an edge's points. */
export function edgePath(points: MapPoint[]): string {
  const f = (p: MapPoint) => `${round(p.x)} ${round(p.y)}`
  if (points.length === 4) return `M ${f(points[0]!)} C ${f(points[1]!)}, ${f(points[2]!)}, ${f(points[3]!)}`
  return `M ${points.map(f).join(' L ')}`
}

/** Direction of travel at the end of an edge, for the arrowhead. */
export function endAngle(points: MapPoint[]): number {
  const last = points[points.length - 1]!
  const prev = points[points.length - 2]!
  return (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
