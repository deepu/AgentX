import { describe, expect, it } from 'bun:test'
import type { MwPlaybook, MwState } from '@memwise/shared/protocol'
import { samplePlaybook } from '../../playbook/sample-playbook'
import { END_ID, edgePath, happyPath, layoutWorkflow, type MapLayout } from '../layout'

function playbookOf(states: MwState[], start = states[0]!.id): MwPlaybook {
  return { id: 'p', version: 1, hash: 'h', title: 'P', start, states, steps: {}, caseFields: [], diagnostics: [] }
}

function expectSound(layout: MapLayout, playbook: MwPlaybook) {
  const ids = new Set(layout.nodes.map((n) => n.id))
  // Every state and `end` is drawn exactly once.
  expect(layout.nodes.length).toBe(ids.size)
  for (const s of playbook.states) expect(ids.has(s.id)).toBe(true)
  expect(ids.has(END_ID)).toBe(true)

  // No two nodes overlap, and all fit inside the canvas.
  for (const [i, a] of layout.nodes.entries()) {
    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.y).toBeGreaterThanOrEqual(0)
    expect(a.x + a.w).toBeLessThanOrEqual(layout.width)
    expect(a.y + a.h).toBeLessThanOrEqual(layout.height)
    for (const b of layout.nodes.slice(i + 1)) {
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
      expect(apart).toBe(true)
    }
  }

  // Every edge joins two drawn nodes and has a finite path.
  for (const e of layout.edges) {
    expect(ids.has(e.from)).toBe(true)
    expect(ids.has(e.to)).toBe(true)
    expect([2, 4]).toContain(e.points.length)
    for (const p of e.points) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    expect(edgePath(e.points)).toMatch(/^M /)
  }

  // Every transition of the playbook is drawn.
  for (const s of playbook.states) {
    for (const target of Object.values(s.on)) {
      expect(layout.edges.some((e) => e.from === s.id && e.to === target)).toBe(true)
    }
  }
}

describe('layoutWorkflow', () => {
  it('puts the intake happy path on the main row and needs_person below it', () => {
    const layout = layoutWorkflow(samplePlaybook)
    expectSound(layout, samplePlaybook)

    const main = layout.nodes.filter((n) => n.row === 'main').sort((a, b) => a.x - b.x)
    expect(main.map((n) => n.id)).toEqual(['fill', 'check', 'verify', 'onboard', 'end'])
    const mainY = main[0]!.y
    for (const n of main) expect(n.y).toBe(mainY)

    const np = layout.nodes.find((n) => n.id === 'needs_person')!
    expect(np.row).toBe('lower')
    expect(np.y).toBeGreaterThan(mainY)
  })

  it('classifies intake edges as forward, back and failure', () => {
    const layout = layoutWorkflow(samplePlaybook)
    const kind = (from: string, to: string) => layout.edges.find((e) => e.from === from && e.to === to)?.kind
    expect(kind('fill', 'check')).toBe('forward')
    expect(kind('check', 'verify')).toBe('forward')
    expect(kind('check', 'fill')).toBe('back')
    expect(kind('verify', 'fill')).toBe('back')
    expect(kind('check', 'needs_person')).toBe('failure')
    expect(kind('fill', 'needs_person')).toBe('failure')
    expect(kind('needs_person', 'check')).toBe('back')

    // `failed` and `needs_person` from check share one edge.
    const merged = layout.edges.find((e) => e.from === 'check' && e.to === 'needs_person')!
    expect(merged.events).toEqual(['failed', 'needs_person'])
    expect(merged.label).toBe('failed, needs person')

    // The wait timeout becomes its own edge with its duration.
    const timeout = layout.edges.find((e) => e.from === 'fill' && e.to === 'needs_person')!
    expect(timeout.events).toEqual(['timeout'])
    expect(timeout.timeoutMs).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('stacks overlapping back arcs at different heights', () => {
    const layout = layoutWorkflow(samplePlaybook)
    const a = layout.edges.find((e) => e.from === 'check' && e.to === 'fill')!
    const b = layout.edges.find((e) => e.from === 'verify' && e.to === 'fill')!
    expect(a.points.length).toBe(4)
    expect(b.points.length).toBe(4)
    expect(a.labelAt.y).not.toBe(b.labelAt.y)
  })

  it('handles self-loops, cycles and unreachable states', () => {
    const playbook = playbookOf([
      { id: 'a', on: { ok: 'b', retry: 'a' } },
      { id: 'b', on: { ok: 'c', again: 'a' } },
      { id: 'c', on: { ok: 'b', done: 'end' } },
      { id: 'orphan', on: { ok: 'c' } },
      { id: 'orphan2', on: { ok: 'orphan2' } },
    ])
    const layout = layoutWorkflow(playbook)
    expectSound(layout, playbook)
    expect(happyPath(playbook)).toEqual(['a', 'b', 'c', 'end'])
    expect(layout.nodes.find((n) => n.id === 'orphan')!.row).toBe('unreachable')
    expect(layout.nodes.find((n) => n.id === 'orphan2')!.row).toBe('unreachable')
    const loop = layout.edges.find((e) => e.from === 'a' && e.to === 'a')!
    expect(loop.points.length).toBe(4)
    expect(loop.kind).toBe('back')
  })

  it('puts other branches above the main row', () => {
    const playbook = playbookOf([
      { id: 'start', on: { small: 'review', large: 'partner' } },
      { id: 'review', on: { ok: 'end' } },
      { id: 'partner', on: { ok: 'end', failed: 'help' } },
      { id: 'help', on: { resolved: 'review' } },
    ])
    const layout = layoutWorkflow(playbook)
    expectSound(layout, playbook)
    const row = (id: string) => layout.nodes.find((n) => n.id === id)!.row
    expect(row('review')).toBe('main')
    expect(row('partner')).toBe('upper')
    expect(row('help')).toBe('lower')
  })

  it('lays out 2 to 15 states of random shape without overlaps', () => {
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const events = ['done', 'ok', 'failed', 'needs_info', 'sent_back', 'timeout', 'approved']
    for (let n = 2; n <= 15; n++) {
      for (let round = 0; round < 6; round++) {
        const ids = Array.from({ length: n }, (_, i) => `s${i}`)
        const states: MwState[] = ids.map((id, i) => {
          const on: Record<string, string> = {}
          const count = 1 + Math.floor(rand() * 3)
          for (let k = 0; k < count; k++) {
            const target = rand() < 0.15 ? 'end' : ids[Math.floor(rand() * n)]!
            on[events[(i + k) % events.length]!] = i === n - 1 && k === 0 ? 'end' : target
          }
          const wait = rand() < 0.2 ? { timeout: { afterMs: 86_400_000, target: ids[Math.floor(rand() * n)]! } } : undefined
          return { id, on, ...(wait ? { wait } : {}) }
        })
        expectSound(layoutWorkflow(playbookOf(states)), playbookOf(states))
      }
    }
  })

  it('copes with a start that does not exist', () => {
    const playbook = playbookOf([{ id: 'a', on: { ok: 'end' } }], 'missing')
    const layout = layoutWorkflow(playbook)
    expectSound(layout, playbook)
  })
})
