/**
 * The page blocks (docs/memwise/26-projects-and-pages.md §4) read leniently: what a model wrote
 * mostly right still draws; what can't be read says why.
 */
import { describe, expect, it } from 'bun:test'
import { PAGE_BLOCK_LANGS, parseRecords, parseSubpages, parseTable, parseTiles, recordValueText } from '../page-blocks'

describe('page blocks', () => {
  it('names the fenced languages a page draws', () => {
    expect([...PAGE_BLOCK_LANGS].sort()).toEqual(['records', 'subpages', 'table', 'tiles'])
  })

  it('tiles: an object or a bare list; tiles without a label or value are skipped', () => {
    expect(parseTiles('{"tiles":[{"label":"Trials","value":9,"note":"since 2021"},{"label":"x"}]}')).toEqual({ ok: true, value: [{ label: 'Trials', value: '9', note: 'since 2021' }] })
    expect(parseTiles('[{"label":"People","value":"4,120","detail":"randomised"}]')).toEqual({ ok: true, value: [{ label: 'People', value: '4,120', note: 'randomised' }] })
    expect(parseTiles('{not json')).toEqual({ ok: false, error: 'json' })
    expect(parseTiles('{"tiles":[]}')).toEqual({ ok: false, error: 'shape' })
  })

  it('table: cells are text, numbers or objects with a quote; columns default to the row keys', () => {
    const t = parseTable(JSON.stringify({
      title: 'Switched from',
      columns: [{ key: 'from', label: 'Switched from' }, { key: 'kept', label: 'Kept on orforglipron', changed: true }, 'placebo'],
      rows: [{ from: 'Tirzepatide (205 people)', kept: { text: '74.7%', quote: { text: 'an MBE of 74.7%', cite: 'ATTAIN-MAINTAIN', href: 'https://doi.org/x' } }, placebo: 49.2 }, 'junk'],
      note: 'Indirect comparison not counted.',
    }))
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.value.columns).toEqual([{ key: 'from', label: 'Switched from' }, { key: 'kept', label: 'Kept on orforglipron', changed: true }, { key: 'placebo', label: 'placebo' }])
    expect(t.value.rows).toEqual([{ from: { text: 'Tirzepatide (205 people)' }, kept: { text: '74.7%', quote: { text: 'an MBE of 74.7%', cite: 'ATTAIN-MAINTAIN', href: 'https://doi.org/x' } }, placebo: { text: '49.2' } }])
    expect(t.value.note).toBe('Indirect comparison not counted.')
    const bare = parseTable('{"rows":[{"a":1,"b":"x"},{"c":true}]}')
    expect(bare.ok && bare.value.columns.map(c => c.key)).toEqual(['a', 'b'])
    expect(parseTable('{"columns":[]}')).toEqual({ ok: false, error: 'shape' })
  })

  it('records and subpages: the query as written, and what the server filled in', () => {
    const r = parseRecords('{"entity":"paper","columns":["title","year"],"result":{"entity":"paper","total":1,"columns":[],"rows":[{"id":"p1","title":"ATTAIN","values":{"year":2026}}]}}')
    expect(r.ok && r.value.entity).toBe('paper')
    expect(r.ok && r.value.result?.total).toBe(1)
    expect(parseRecords('{"entity":"paper"}')).toEqual({ ok: true, value: { entity: 'paper' } })
    expect(parseSubpages('')).toEqual({ ok: true, value: {} })
    const s = parseSubpages('{"pages":[{"id":"a","title":"Weight loss","status":"kept","headline":"9 to 13 points","inSummary":true}],"changes":[]}')
    expect(s.ok && s.value.pages?.[0]?.title).toBe('Weight loss')
    expect(parseSubpages('[1]')).toEqual({ ok: false, error: 'shape' })
  })

  it('record values read as one line', () => {
    expect(recordValueText(['a', null, 2])).toBe('a, 2')
    expect(recordValueText(undefined)).toBe('')
  })
})
