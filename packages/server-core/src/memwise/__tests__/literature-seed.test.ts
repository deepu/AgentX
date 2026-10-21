/**
 * The Literature home seed (seed-literature.ts) on the real example project: the LHome state the
 * walkthrough starts from, with its answer change and reply waiting as real reviews.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type { MwInboxItem, MwPage, MwPageChange, MwPageSummary } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import { seedLiteratureHome } from '../index'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise

describe.skipIf(!postgresAvailable())('the Literature home seed', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  const api = fakeServer()
  let leah: RequestContext
  let omar: RequestContext
  let leahId: string
  let omarId: string

  beforeAll(async () => {
    db = await createTestDatabase('mw_seed_lit', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-seed-lit-'))
    cpSync(join(REPO, 'examples', 'literature'), join(dir, 'project'), { recursive: true })
    svc = (await startMemwiseService({
      configDir: dir, projectDir: join(dir, 'project'), databaseUrl: db.url, mode: 'server',
      modelResolver: async () => ({ modelRoles: {}, providers: [], configured: false, message: 'No models: the seed calls none.' }),
      logger: quiet, exampleRoots: [REPO], watch: false, throwOnError: true,
      owner: { name: 'Owner', email: 'owner@meridian.example' },
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: fakeSessions().manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const l = await svc.kernel.people.create({ name: 'Leah Park', email: 'leah@meridian.example', roles: ['lead'], password: 'a long enough password' })
    const o = await svc.kernel.people.create({ name: 'Omar Haddad', email: 'omar@meridian.example', roles: ['reviewer'], password: 'a long enough password' })
    leahId = l.id
    omarId = o.id
    leah = ctxFor('leah-client', l.id)
    omar = ctxFor('omar-client', o.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('builds the pages, Papers and Enquiries, and puts the ATTAIN-MAINTAIN change and a reply up for Leah', async () => {
    const seed = await seedLiteratureHome({ lead: leahId, askedBy: omarId })
    expect(seed.created).toBe(true)

    const pages = await api.call<MwPageSummary[]>(leah, ch.PAGES_LIST, { projectId: 'literature' })
    const byTitle = Object.fromEntries(pages.map((p) => [p.title, p]))
    expect(pages.filter((p) => !p.parent).map((p) => p.title)).toEqual(['GLP-1', 'Heart failure', 'Pipeline watch'])
    expect(pages.filter((p) => p.parent === byTitle['GLP-1']!.id).map((p) => [p.title, p.status]))
      .toEqual([['Side effects', 'draft'], ['Type 2 diabetes', 'kept'], ['Weight loss', 'kept']])
    expect(byTitle['Pipeline watch']!.refresh!.every).toBe('month')
    expect(byTitle['Weight loss']).toMatchObject({ status: 'kept', pendingChange: { label: '1 new trial' }, refresh: { every: 'mon' } })
    expect(byTitle['Type 2 diabetes']!.lastRefresh).toMatchObject({ status: 'nothing_new' })

    // GLP-1 sums up its kept sub-pages; the draft is left out.
    const glp1 = (await api.call<MwPage>(leah, ch.PAGES_GET, { pageId: byTitle['GLP-1']!.id }))
    expect(glp1.children.map((k) => [k.title, k.inSummary])).toEqual([['Side effects', false], ['Type 2 diabetes', true], ['Weight loss', true]])
    // Weight loss: made from Omar's question, its numbers quoted from Papers.
    const weight = (await api.call<MwPage>(leah, ch.PAGES_GET, { pageId: byTitle['Weight loss']!.id }))
    expect(weight.history.at(-1)).toMatchObject({ kind: 'asked', byName: 'Omar Haddad' })
    expect(weight.body).toContain('```chart')
    const { rows } = await svc.kernel.pool.query(`select count(*)::int as n from domain.literature__article where lifecycle = 'read'`)
    expect(rows[0].n).toBe(8)

    // "Waiting for you": the answer change (Leah's, not Omar's) and the reply to sign.
    const items = await api.call<MwInboxItem[]>(leah, ch.INBOX_LIST)
    const review = items.find((i) => (i as { pageChange?: { pageId: string } }).pageChange?.pageId === weight.id) as MwInboxItem & { pageChange: { changeId: string; label?: string; from?: { kind: string; every?: string } } }
    expect(review.pageChange).toMatchObject({ label: '1 new trial', from: { kind: 'schedule', every: 'mon' } })
    expect(items.some((i) => 'workflowId' in i && i.workflowId === 'answer-enquiry')).toBe(true)
    expect((await api.call<MwInboxItem[]>(omar, ch.INBOX_LIST)).some((i) => !!(i as { pageChange?: unknown }).pageChange)).toBe(false)

    const change = await api.call<MwPageChange>(leah, ch.PAGE_CHANGES_GET, { changeId: review.pageChange.changeId })
    expect(change).toMatchObject({ status: 'pending', title: 'ATTAIN-MAINTAIN added', mayDecide: true })
    expect(change.plus).toContain('75 to 79%')
    expect(change.sections.map((s) => [s.heading, s.origin, s.changed])).toEqual([['Keeping weight off after injections', 'refresh', 'added']])
    expect(change.leftOut.map((l) => l.title)).toContain('Semaglutide for cognitive dysfunction in depression')

    // Run again: nothing changes.
    expect((await seedLiteratureHome({ lead: leahId })).created).toBe(false)
  }, 120_000)
})
