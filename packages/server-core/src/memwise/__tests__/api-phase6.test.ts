/**
 * The Phase 6 app API (24 §13) against a fake service and kernel: every new `memwise:*` channel
 * is registered; records, views, dashboards, automations and the audit trail reach the kernel as
 * the person and come back as Mw* shapes; a signed submit passes the password and maps the new
 * refusals; the inbox carries flags, held triggers and review fields; the case view carries its
 * hand-offs; and a regulated workspace turns "act as" off.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import { HANDLED_CHANNELS, registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import { resetMemwiseHost, setMemwiseService } from '../host'
import type { MemwiseService } from '../service'
import { fakeServer } from './api-harness'

const ch = RPC_CHANNELS.memwise
const OWNER = { id: 'person_owner', name: 'Meera Owner', email: 'meera@acme.example', roles: ['study_manager'] }
const PRIYA = { id: 'person_priya', name: 'Priya Shah', email: 'priya@acme.example', roles: ['tmf_specialist'] }

afterEach(() => resetMemwiseHost())

const SITE_PAGE = {
  entity: 'etmf.Site', domain: 'etmf', entityName: 'Site', regulated: true, id: 'site_1', title: 'US-012 · Harbor Oncology, Boston', status: 'activating',
  layout: { layout: 'single', header: [], areas: { main: [{ kind: 'details' }] } },
  fields: [{ name: 'site_number', type: 'Text', value: 'US-012', source: { kind: 'domain' }, editable: true }],
  parents: [], related: {}, cases: [], flags: [], signatures: [], mentions: [], start: [], documents: { file: { id: 'file_1', name: 'vogel-cv.pdf', mime: 'application/pdf', size: 3, sha256: 'x' } }, history: [],
}

function setup(opts: { regulated?: boolean; noDomains?: boolean; submit?: Record<string, unknown> } = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const rec = (method: string, answer: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args })
    return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)(...args) : answer
  }
  const view = {
    summary: { caseId: 'case_1', runId: 'run_1', workflowId: 'activate-site', workflowVersion: 1, state: 'collect_pack', status: 'active', values: {}, createdAt: 'a', updatedAt: 'b' },
    values: {}, stepRuns: [], transitions: [], path: ['collect_pack'], domain: 'etmf',
    links: [{ kind: 'started_by', caseId: 'case_0', runId: 'run_0', workflowId: 'file-document', title: 'File a TMF document: vogel-cv.pdf', state: 'file', status: 'done' }],
    waiting: { record: { entity: 'etmf.Site', id: 'site_1', title: 'US-012' }, condition: 'start_up_pack_complete = 100%', holds: false, values: { start_up_pack_complete: 90 } },
  }
  const inbox = [
    { kind: 'input', id: 'step:sr_qc', stepRunId: 'sr_qc', runId: 'run_9', caseId: 'case_9', workflowId: 'file-document', stepId: 'qc', since: 't', domain: 'etmf', review: { kind: 'document', entity: 'etmf.Document', recordId: 'doc_1' }, sign: { meaning: 'Reviewed and approved for filing' } },
    { kind: 'flag', id: 'flag:f1', domain: 'etmf', title: 'US-012', since: 't', flag: { id: 'f1', entity: 'etmf.Site', recordId: 'site_1', invariant: 'x', message: 'Open without an activation date', raisedAt: 't' } },
    { kind: 'trigger-hold', id: 'hold:1', triggerId: 'activate-site#0', workflowId: 'activate-site', held: 300, description: 'When a site moves to Activating', since: 't' },
  ]
  const project = {
    workflows: {
      'file-document': { id: 'file-document', title: 'File a TMF document', domain: 'etmf', caseType: { fields: { document: { type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text' } } }, states: { qc: { on: {} } }, steps: { qc: { id: 'qc', title: 'QC and sign', performer: 'person', reads: [], writes: { document: { field: 'document', type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text' } }, outcomes: ['approved', 'sent_back'], instructions: '' } } },
      'activate-site': { id: 'activate-site', title: 'Activate a site', domain: 'etmf', caseType: { fields: {} }, states: {}, steps: {} },
    },
    entities: {}, plugins: {}, domains: { etmf: { id: 'etmf', name: 'eTMF', regulated: true } },
  }
  const kernel: Record<string, unknown> = {
    getCaseView: async () => view,
    inbox: async () => inbox,
    listCases: async () => [],
    readFile: rec('readFile', (id: unknown) => (id === 'file_1' ? { meta: { id: 'file_1', name: 'vogel-cv.pdf', mime: 'application/pdf', size: 3, sha256: 'x' }, data: new Uint8Array([37, 80, 68]) } : undefined)),
    submitStep: rec('submitStep', opts.submit ?? { applied: true, status: 'applied' }),
    people: { list: async () => [OWNER, PRIYA], get: async (id: string) => (id === PRIYA.id ? { ...PRIYA, lockedUntil: '2026-10-20T13:00:00Z' } : OWNER) },
    pool: { query: async () => ({ rows: [] }) },
  }
  if (!opts.noDomains) {
    kernel.domains = {
      list: rec('domains.list', [{ id: 'etmf', name: 'eTMF', regulated: true, retentionMs: 25 * 365 * 86400000, entities: [{ key: 'etmf.Site', entity: 'Site', count: 7 }], workflows: ['activate-site'], pages: [], views: [], flags: 1 }]),
      workspace: async () => ({ name: 'Northlight CRO', stormLimit: 25, regulated: !!opts.regulated }),
    }
    kernel.records = {
      page: rec('records.page', (entity: unknown) => (entity === 'etmf.Site' ? SITE_PAGE : undefined)),
      create: rec('records.create', { applied: true, status: 'applied', id: 'site_2', version: 1 }),
      update: rec('records.update', (input: { reason?: string }) => (input.reason ? { applied: true, status: 'applied', version: 3 } : { applied: false, status: 'reason-required' })),
      transition: rec('records.transition', { applied: false, status: 'guard', message: 'start_up_pack_complete = 100% does not hold (90)' }),
      query: rec('records.query', { entity: 'etmf.Site', columns: [{ name: 'site_number', type: 'Text' }], rows: [{ entity: 'etmf.Site', id: 'site_1', title: 'US-012', values: { site_number: 'US-012' }, hidden: [] }], total: 1 }),
      tree: rec('records.tree', [{ kind: 'group', entity: 'etmf.Site', parent: { entity: 'etmf.Study', id: 'st_1' }, title: 'Sites', count: 7 }]),
      dashboard: rec('records.dashboard', { pageId: 'tmf-health', title: 'TMF health', params: {}, computedAt: 't', blocks: [{ kind: 'kpi', label: 'Complete', value: 87 }] }),
      views: rec('records.views', [{ id: 'activating', title: 'Activating', entity: 'Site', layout: 'table', personal: false, domain: 'etmf', file: 'views/activating.yaml' }]),
      saveView: rec('records.saveView', (_d: unknown, v: unknown) => v),
      saveNote: rec('records.saveNote', { applied: true, status: 'applied', version: 2 }),
    }
    kernel.triggers = {
      list: rec('triggers.list', [{ id: 'activate-site#0', workflowId: 'activate-site', domain: 'etmf', def: { kind: 'entered', entity: 'Site', state: 'activating', with: {} }, description: 'When a Site enters Activating', firings: 2, held: 300 }]),
      release: rec('triggers.release', { applied: true, started: 300 }),
    }
    kernel.audit = {
      trail: rec('audit.trail', { entity: 'etmf.Document', id: 'doc_1', title: 'vogel-cv.pdf', domain: 'etmf', regulated: true, values: {}, versions: [], chain: { ok: true }, signatures: [], cases: [], flags: [], exportedAt: 't' }),
      export: rec('audit.export', { name: 'document-doc_1-audit.json', mime: 'application/json', data: new TextEncoder().encode('{"ok":true}') }),
    }
  }
  const actors: Record<string, typeof OWNER> = { owner: OWNER, priya: PRIYA }
  const svc = {
    kernel, mode: 'desktop', owner: OWNER, modelConfigured: true, projectDir: '/p',
    async actorFor(client: { personId?: string | null }) {
      const p = client.personId ? actors[client.personId]! : OWNER
      return { kind: 'person', personId: p.id, roles: p.roles }
    },
    async personFor(client: { personId?: string | null }) { return client.personId ? actors[client.personId]! : OWNER },
    canActAs: (client: { personId?: string | null }) => !client.personId,
    actAs: rec('actAs', OWNER),
    async context() { return { project, diagnostics: [], tools: new Map(), jsonSchema: () => ({}) } },
  } as unknown as MemwiseService
  setMemwiseService(svc)
  const { server, handlers, call, pushes } = fakeServer()
  registerMemwiseHandlers(server, { sessionManager: {} as never, platform: { logger: { info() {}, warn() {}, error() {} } } as never } as never)
  return { call, handlers, calls, pushes, admin: { clientId: 'c-admin' } as never, priya: { clientId: 'c-priya', personId: 'priya' } as never }
}

const PHASE6 = [
  ch.DOMAINS_LIST, ch.RECORDS_PAGE, ch.RECORDS_CREATE, ch.RECORDS_UPDATE, ch.RECORDS_TRANSITION, ch.RECORDS_QUERY, ch.RECORDS_TREE,
  ch.RECORDS_NOTES_SAVE, ch.PAGES_DASHBOARD, ch.VIEWS_LIST, ch.VIEWS_SAVE, ch.TRIGGERS_LIST, ch.TRIGGERS_RELEASE, ch.AUDIT_GET,
  ch.AUDIT_EXPORT, ch.FILES_READ,
]

describe('Phase 6 channels', () => {
  it('registers every new channel, and declares them handled', () => {
    const { handlers } = setup()
    for (const c of PHASE6) {
      expect(handlers.has(c)).toBe(true)
      expect((HANDLED_CHANNELS as readonly string[]).includes(c)).toBe(true)
    }
    expect([...handlers.keys()].sort()).toEqual([...HANDLED_CHANNELS].sort())
  })
})

describe('domains and records', () => {
  it('lists domains with retention in days', async () => {
    const { call, priya } = setup()
    const [d] = await call(priya, ch.DOMAINS_LIST)
    expect(d).toMatchObject({ id: 'etmf', name: 'eTMF', regulated: true, retentionDays: 9125, entities: [{ title: 'Site' }] })
  })

  it('a record page as the person, in review mode for a step run; null when it can not be seen', async () => {
    const { call, calls, priya } = setup()
    const page = await call(priya, ch.RECORDS_PAGE, { entity: 'etmf.Site', id: 'site_1', review: { stepRunId: 'sr_qc' } })
    expect(page).toMatchObject({ domainName: 'eTMF', fields: [{ name: 'site_number', label: 'Site number' }] })
    expect(calls.find((c) => c.method === 'records.page')!.args).toEqual(['etmf.Site', 'site_1', { kind: 'person', personId: 'person_priya', roles: ['tmf_specialist'] }, { review: { stepRunId: 'sr_qc' } }])
    expect(await call(priya, ch.RECORDS_PAGE, { entity: 'etmf.Document', id: 'nope' })).toBeNull()
  })

  it('edits need a reason in a regulated domain; refusals carry plain words; writes push a records change', async () => {
    const { call, priya, pushes } = setup()
    const refused = await call(priya, ch.RECORDS_UPDATE, { entity: 'etmf.Site', id: 'site_1', values: { site_number: 'US-013' } })
    expect(refused).toEqual({ applied: false, status: 'reason-required', message: 'Say why you are making this change.' })
    const ok = await call(priya, ch.RECORDS_UPDATE, { entity: 'etmf.Site', id: 'site_1', values: { site_number: 'US-013' }, reason: ' Typo ' })
    expect(ok).toEqual({ applied: true, status: 'applied', version: 3 })
    expect(pushes.some((p) => JSON.stringify(p.args[0]) === JSON.stringify({ kind: 'records', entity: 'etmf.Site', id: 'site_1' }))).toBe(true)
    const guard = await call(priya, ch.RECORDS_TRANSITION, { entity: 'etmf.Site', id: 'site_1', transition: 'approved' })
    expect(guard).toMatchObject({ applied: false, status: 'guard', message: expect.stringContaining('(90)') })
    expect(await call(priya, ch.RECORDS_CREATE, { entity: 'etmf.Site', values: { site_number: 'US-020' } })).toMatchObject({ applied: true, id: 'site_2' })
    expect(await call(priya, ch.RECORDS_NOTES_SAVE, { entity: 'etmf.Site', id: 'site_1', body: 'IRB meets 28 Oct' })).toMatchObject({ applied: true, version: 2 })
    expect(await call(priya, ch.RECORDS_UPDATE, { entity: 'etmf.Site' })).toMatchObject({ applied: false, status: 'invalid' })
  })

  it('queries with labels, clamps the limit; the tree and dashboards', async () => {
    const { call, calls, priya } = setup()
    const r = await call(priya, ch.RECORDS_QUERY, { entity: 'etmf.Site', filter: " status = 'open' ", sort: [{ field: 'site_number', desc: true }, null], limit: 10_000 })
    expect(r.columns[0]).toEqual({ name: 'site_number', label: 'Site number', type: 'Text' })
    expect(calls.find((c) => c.method === 'records.query')!.args[0]).toEqual({ entity: 'etmf.Site', filter: "status = 'open'", sort: [{ field: 'site_number', desc: true }], limit: 500 })
    expect(await call<unknown>(priya, ch.RECORDS_TREE, { domain: 'etmf', parent: { entity: 'etmf.Study', id: 'st_1' } })).toEqual([{ kind: 'group', entity: 'etmf.Site', parent: { entity: 'etmf.Study', id: 'st_1' }, title: 'Sites', count: 7 }])
    expect(await call(priya, ch.PAGES_DASHBOARD, { domain: 'etmf', pageId: 'tmf-health', params: { study: 'st_1', bad: 3 } })).toMatchObject({ domain: 'etmf', blocks: [{ kind: 'kpi', value: 87 }] })
    expect(calls.find((c) => c.method === 'records.dashboard')!.args.slice(0, 3)).toEqual(['etmf', 'tmf-health', { study: 'st_1' }])
  })

  it('views: shared ones listed without their file; "Save as my view" saves a personal one', async () => {
    const { call, priya } = setup()
    expect(await call<unknown>(priya, ch.VIEWS_LIST, { domain: 'etmf', entity: 'Site' })).toEqual([{ id: 'activating', title: 'Activating', domain: 'etmf', entity: 'Site', layout: 'table', personal: false }])
    const saved = await call(priya, ch.VIEWS_SAVE, { domain: 'etmf', view: { title: 'My sites', entity: 'Site', layout: 'board', filter: "status = 'open'" } })
    expect(saved).toEqual({ id: 'my-my-sites', title: 'My sites', domain: 'etmf', entity: 'Site', filter: "status = 'open'", layout: 'board', personal: true })
    await expect(call(priya, ch.VIEWS_SAVE, { domain: 'etmf', view: { title: ' ', entity: 'Site' } })).rejects.toThrow('Give the view a name.')
  })
})

describe('automations, audit, files', () => {
  it('lists triggers and releases held firings as the person', async () => {
    const { call, calls, priya, pushes } = setup()
    expect((await call(priya, ch.TRIGGERS_LIST))[0]).toMatchObject({ workflowTitle: 'Activate a site', held: 300 })
    expect(await call<unknown>(priya, ch.TRIGGERS_RELEASE, { trigger: 'activate-site#0', decision: 'start' })).toEqual({ applied: true, started: 300 })
    expect(calls.find((c) => c.method === 'triggers.release')!.args.slice(0, 2)).toEqual(['activate-site#0', 'start'])
    expect(pushes.some((p) => (p.args[0] as { kind: string }).kind === 'triggers')).toBe(true)
    expect(await call(priya, ch.TRIGGERS_RELEASE, { trigger: 'x', decision: 'maybe' })).toMatchObject({ applied: false, code: 'trigger.invalid' })
  })

  it('the audit trail, and its export as base64', async () => {
    const { call, priya } = setup()
    expect(await call(priya, ch.AUDIT_GET, { entity: 'etmf.Document', id: 'doc_1' })).toMatchObject({ title: 'vogel-cv.pdf', chain: { ok: true } })
    const file = await call(priya, ch.AUDIT_EXPORT, { entity: 'etmf.Document', id: 'doc_1', format: 'json' })
    expect(file).toEqual({ name: 'document-doc_1-audit.json', mime: 'application/json', dataBase64: Buffer.from('{"ok":true}').toString('base64') })
  })

  it('reads a file for the viewer', async () => {
    const { call, priya } = setup()
    expect(await call<unknown>(priya, ch.FILES_READ, 'file_1')).toEqual({ id: 'file_1', name: 'vogel-cv.pdf', mime: 'application/pdf', dataBase64: 'JVBE' })
    await expect(call(priya, ch.FILES_READ, 'file_x')).rejects.toThrow('That file was not found.')
  })

  it('a kernel without Phase 6 says so plainly', async () => {
    const { call, priya } = setup({ noDomains: true })
    await expect(call(priya, ch.DOMAINS_LIST)).rejects.toThrow('Domains are not available')
    await expect(call(priya, ch.RECORDS_PAGE, { entity: 'etmf.Site', id: 's' })).rejects.toThrow('Records are not available')
  })
})

describe('signing, the inbox and cases', () => {
  it('a signed submit passes the password; refusals map to codes, with when to retry', async () => {
    const ok = setup()
    expect(await ok.call<unknown>(ok.priya, ch.INBOX_SUBMIT, { stepRunId: 'sr_qc', outcome: 'approved', signature: { password: 'correct horse' } })).toEqual({ applied: true })
    expect((ok.calls.find((c) => c.method === 'submitStep')!.args[0] as { signature: unknown }).signature).toEqual({ password: 'correct horse' })
    for (const [status, code] of [['signature-required', 'submit.signature-required'], ['signature-failed', 'submit.signature-failed']] as const) {
      const s = setup({ submit: { applied: false, status } })
      expect(await s.call(s.priya, ch.INBOX_SUBMIT, { stepRunId: 'sr_qc', outcome: 'approved' })).toMatchObject({ applied: false, code })
    }
    const locked = setup({ submit: { applied: false, status: 'locked' } })
    expect(await locked.call(locked.priya, ch.INBOX_SUBMIT, { stepRunId: 'sr_qc', outcome: 'approved', signature: { password: 'x' } }))
      .toMatchObject({ applied: false, code: 'submit.locked', retryAfter: '2026-10-20T13:00:00Z' })
  })

  it('inbox: document review and signing on the item; flags and held triggers as their own items', async () => {
    const { call, priya } = setup()
    const items = await call(priya, ch.INBOX_LIST)
    expect(items.map((i: { kind: string }) => i.kind)).toEqual(['input', 'flag', 'trigger-hold'])
    expect(items[0]).toMatchObject({ domain: 'etmf', review: { kind: 'document', entity: 'etmf.Document', recordId: 'doc_1' }, sign: { meaning: 'Reviewed and approved for filing' }, stepTitle: 'QC and sign' })
    expect(items[1]).toMatchObject({ caseTitle: 'US-012', flag: { recordId: 'site_1' } })
    expect(items[2]).toMatchObject({ caseTitle: 'Activate a site', held: 300 })
  })

  it('the case view carries hand-offs, the wait condition and the domain', async () => {
    const { call, priya } = setup()
    const c = await call(priya, ch.CASES_GET, 'case_1')
    expect(c.caseLinks).toEqual([{ kind: 'started_by', caseId: 'case_0', runId: 'run_0', workflowId: 'file-document', title: 'File a TMF document: vogel-cv.pdf', state: 'file', status: 'done' }])
    expect(c.waiting).toMatchObject({ condition: 'start_up_pack_complete = 100%', holds: false, values: { start_up_pack_complete: 90 } })
    expect(c.domain).toBe('etmf')
  })

  it('a regulated workspace: no "act as", and the server refuses it', async () => {
    const reg = setup({ regulated: true })
    expect((await reg.call(reg.admin, ch.STATUS)).canActAs).toBe(false)
    await expect(reg.call(reg.admin, ch.PEOPLE_ACT_AS, PRIYA.id)).rejects.toThrow('regulated')
    const open = setup()
    expect((await open.call(open.admin, ch.STATUS)).canActAs).toBe(true)
    const old = setup({ noDomains: true })
    expect((await old.call(old.admin, ch.STATUS)).canActAs).toBe(true)
  })
})
