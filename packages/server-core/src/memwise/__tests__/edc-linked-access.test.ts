/**
 * Stage 6 review: `memwise:records:linked` answers only for a record the viewer may see. The links
 * alone would say the record exists and what it is paired with in the other app.
 */
import { describe, expect, it } from 'bun:test'
import type { ProjectDefs } from '@memwise/defs'
import { linkedRecords } from '../edc'
import type { MemwiseService } from '../service'

const project = { entities: { 'etmf.Site': { entity: 'Site', domain: 'etmf' }, 'edc.Site': { entity: 'Site', domain: 'edc' } }, domains: {} } as unknown as ProjectDefs
const pageOf = (entity: string, id: string) => ({ entity, id, title: id, domain: entity.split('.')[0], fields: [], related: {}, parents: [], history: [], blocks: [] })

const asked: string[] = []
function svcSeeing(visible: (entity: string, id: string) => boolean): MemwiseService {
  asked.length = 0
  return {
    kernel: {
      pool: { query: async (sql: string) => ({ rows: sql.includes('record_id = $2') ? [{ plugin: 'domain:edc', source: 'Site', external_id: 'edc_104' }] : [] }) },
      records: { page: async (entity: string, id: string) => { asked.push(`${entity}:${id}`); return visible(entity, id) ? pageOf(entity, id) : undefined } },
    },
  } as unknown as MemwiseService
}
const actor = { kind: 'person', personId: 'p', roles: [] } as never

describe('the same record in other apps', () => {
  it('is listed for a record the viewer may see', async () => {
    // The record asked about is checked first, then its pair in the other app is read (as the viewer).
    await linkedRecords(svcSeeing(() => true), actor, project, { entity: 'etmf.Site', id: 'site_104' }).catch(() => undefined)
    expect(asked).toEqual(['etmf.Site:site_104', 'edc.Site:edc_104'])
  })
  it('is empty when the viewer may not see the record asked about, even though it is paired', async () => {
    expect(await linkedRecords(svcSeeing((_e, id) => id !== 'site_104'), actor, project, { entity: 'etmf.Site', id: 'site_104' })).toEqual([])
    expect(asked).toEqual(['etmf.Site:site_104']) // its pair is never read
  })
})
