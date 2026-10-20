/**
 * The Phase 5 app API (23 §9, §11) against a fake service and kernel: every new `memwise:*`
 * channel is registered, links are listed and issued only for cases the person may see (and only
 * with a public address), the relay setting is the owner's alone, people set their own
 * notifications, and the case and inbox carry links, deliveries, provenance and `extract`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { MwCase, MwRelayStatus } from '@memwise/shared/protocol'
import type { Delivery, ExternalLinkSummary } from '@memwise/defs/external'
import { HANDLED_CHANNELS, registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import { resetMemwiseHost, setMemwiseService } from '../host'
import type { MemwiseService } from '../service'
import { fakeServer } from './api-harness'
import { toCaseValue, toInboxExtract, toProvenance } from '../dto'

const ch = RPC_CHANNELS.memwise
const OWNER = { id: 'person_owner', name: 'Meera Owner', email: 'meera@acme.example', roles: ['staff', 'manager'] }
const PRIYA = { id: 'person_priya', name: 'Priya', email: 'priya@acme.example', roles: ['staff'] }

const LINK: ExternalLinkSummary = {
  id: 'lnk_1', kind: 'step', status: 'open', runId: 'run_1', caseId: 'case_1', stepId: 'fill',
  participant: { name: 'Asha Rao', email: 'asha@example.com' }, via: 'email', createdAt: '2026-10-20T10:42:00.000Z',
  expiresAt: '2026-10-27T10:42:00.000Z', sentAt: '2026-10-20T10:43:00.000Z',
}
const OLDER: ExternalLinkSummary = { ...LINK, id: 'lnk_0', status: 'used', createdAt: '2026-10-19T09:00:00.000Z', usedAt: '2026-10-19T10:00:00.000Z' }
const DELIVERY: Delivery = { id: 'dlv_1', channel: 'email', to: 'asha@example.com', purpose: 'invite', linkId: 'lnk_1', status: 'sent', at: '2026-10-20T10:43:00.000Z' }

afterEach(() => resetMemwiseHost())

function setup(opts: { publicUrl?: string; visibleCases?: string[] } = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const rec = (method: string, answer: unknown) => async (...args: unknown[]) => { calls.push({ method, args }); return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)(...args) : answer }
  const visible = new Set(opts.visibleCases ?? ['case_1'])
  let relay: MwRelayStatus = { enabled: false, state: 'off', ...(opts.publicUrl ? { publicUrl: opts.publicUrl, source: 'server' as const } : {}) }
  const view = {
    summary: { caseId: 'case_1', runId: 'run_1', workflowId: 'client-intake', workflowVersion: 2, state: 'fill', status: 'active', values: {}, createdAt: 'a', updatedAt: 'b' },
    values: {
      client_name: { value: 'Asha Rao', provenance: { kind: 'input', at: 't' } },
      pan: { value: 'AAACM1234M', provenance: { kind: 'external', at: 't', by: 'Asha Rao', linkId: 'lnk_1', stepRunId: 'sr_fill', tainted: true } },
      gstin: { value: '27AAACM1234M1Z2', tainted: true, provenance: { kind: 'tool', at: 't', stepRunId: 'sr_fill', tool: 'intake.extract_fields', callId: 'form.extract:1', tainted: true, document: 'gst-certificate.pdf', confidence: 0.93, confirmedBy: 'external:lnk_1' } },
    },
    stepRuns: [], transitions: [], path: ['prepare', 'invite', 'fill'],
  }
  const kernel = {
    getCaseView: async (caseId: string) => (visible.has(caseId) ? view : undefined),
    getRun: async (runId: string) => (runId === 'run_1' ? { id: 'run_1', caseId: 'case_1' } : undefined),
    pool: { query: async (_sql: string, args: unknown[]) => ({ rows: args[0] === 'lnk_1' ? [{ case_id: 'case_1' }] : args[0] === 'lnk_other' ? [{ case_id: 'case_2' }] : [] }) },
    external: {
      links: rec('links', [OLDER, LINK]),
      issueLink: rec('issueLink', { link: LINK, token: 'mwl_secret', ...(opts.publicUrl ? { url: `${opts.publicUrl}/f/mwl_secret` } : {}) }),
      revoke: rec('revoke', (id: unknown) => (id === 'lnk_1' ? { applied: true } : { applied: false, message: 'That link was already used.' })),
      previewResend: rec('previewResend', { to: 'asha@example.com', via: 'email', subject: 'Your details for Acme', body: 'Hello Asha' }),
      resend: rec('resend', { applied: true, delivery: DELIVERY }),
      extractForStep: rec('extractForStep', { suggestions: [{ id: 'sug_1', field: 'pan', value: 'AAACM1234M', confidence: 0.92, document: 'pan-card.pdf', documentId: 'file_1', found: true, prefill: true }] }),
    },
    channels: {
      deliveries: rec('deliveries', [DELIVERY]),
      available: rec('available', { email: { tool: 'email.send', plugin: 'memwise/email-smtp' }, whatsapp: undefined }),
      notifySettings: rec('notifySettings', { email: true }),
      setNotifySettings: rec('setNotifySettings', (_p: unknown, s: unknown) => s),
    },
  }
  const actors: Record<string, typeof OWNER> = { owner: OWNER, priya: PRIYA }
  const svc = {
    kernel,
    mode: 'server',
    owner: OWNER,
    async actorFor(client: { personId?: string | null }) {
      const p = client.personId ? actors[client.personId]! : OWNER
      return { kind: 'person', personId: p.id, roles: p.roles }
    },
    canActAs: (client: { personId?: string | null }) => !client.personId,
    async context() { return { project: { workflows: {}, entities: {}, plugins: {} }, diagnostics: [], tools: new Map(), jsonSchema: () => ({}) } },
    publicAddress: {
      publicUrl: () => relay.publicUrl,
      status: () => relay,
      configure: async (input: { enabled: boolean; relayUrl?: string }) => {
        calls.push({ method: 'configure', args: [input] })
        relay = { ...relay, enabled: input.enabled, state: input.enabled ? 'connecting' : 'off', ...(input.relayUrl ? { relayUrl: input.relayUrl } : {}) }
        return relay
      },
    },
  } as unknown as MemwiseService
  setMemwiseService(svc)
  const { server, handlers, call, pushes } = fakeServer()
  registerMemwiseHandlers(server, { sessionManager: {} as never, platform: { logger: { info() {}, warn() {}, error() {} } } as never } as never)
  const admin = { clientId: 'c-admin' } as never
  const priya = { clientId: 'c-priya', personId: 'priya' } as never
  return { call, handlers, calls, admin, priya, pushes }
}

describe('Phase 5 channels', () => {
  it('registers every new channel, and declares them handled', () => {
    const { handlers } = setup()
    const phase5 = [
      ch.EXTERNAL_LINKS, ch.EXTERNAL_ISSUE, ch.EXTERNAL_REVOKE, ch.EXTERNAL_PREVIEW_RESEND, ch.EXTERNAL_RESEND, ch.EXTERNAL_EXTRACT,
      ch.RELAY_STATUS, ch.RELAY_CONFIGURE, ch.CHANNELS_AVAILABLE, ch.NOTIFY_GET, ch.NOTIFY_SET,
    ]
    for (const c of phase5) {
      expect(handlers.has(c)).toBe(true)
      expect((HANDLED_CHANNELS as readonly string[]).includes(c)).toBe(true)
    }
    expect([...handlers.keys()].sort()).toEqual([...HANDLED_CHANNELS].sort())
  })
})

describe('links', () => {
  it('lists a case\'s links newest first, never the token', async () => {
    const { call, admin } = setup()
    const links = await call(admin, ch.EXTERNAL_LINKS, { caseId: 'case_1' })
    expect(links.map((l: { id: string }) => l.id)).toEqual(['lnk_1', 'lnk_0'])
    expect(JSON.stringify(links)).not.toContain('mwl_')
    expect((await call(admin, ch.EXTERNAL_LINKS, { runId: 'run_1' })).length).toBe(2)
  })

  it('refuses links of a case the person may not see', async () => {
    const { call, admin } = setup({ visibleCases: [] })
    await expect(call(admin, ch.EXTERNAL_LINKS, { caseId: 'case_1' })).rejects.toThrow('That case was not found.')
    await expect(call(admin, ch.EXTERNAL_LINKS, {})).rejects.toThrow('That case was not found.')
  })

  it('issues a link with its address when there is a public address', async () => {
    const { call, calls, priya, pushes } = setup({ publicUrl: 'https://abc.relay.test' })
    const r = await call(priya, ch.EXTERNAL_ISSUE, { runId: 'run_1', stepId: 'fill', participant: { name: ' Asha Rao ', email: 'asha@example.com', phone: '' }, note: '' })
    expect(r).toMatchObject({ url: 'https://abc.relay.test/f/mwl_secret', link: { id: 'lnk_1' } })
    expect(r.message).toBeUndefined()
    const issued = calls.find((c) => c.method === 'issueLink')!.args[0] as Record<string, unknown>
    expect(issued).toEqual({ runId: 'run_1', stepId: 'fill', participant: { name: 'Asha Rao', email: 'asha@example.com' }, by: { kind: 'person', personId: 'person_priya', roles: ['staff'] } })
    expect(pushes.some((p) => (p.args[0] as { kind: string }).kind === 'external')).toBe(true)
  })

  it('makes no link without a public address, and says what to do', async () => {
    const { call, calls, admin } = setup()
    await expect(call(admin, ch.EXTERNAL_ISSUE, { runId: 'run_1', stepId: 'fill', participant: {} })).rejects.toThrow('Turn on the public address in Settings')
    expect(calls.some((c) => c.method === 'issueLink')).toBe(false)
  })

  it('revokes, previews and resends as the person', async () => {
    const { call, calls, priya } = setup()
    expect(await call<unknown>(priya, ch.EXTERNAL_REVOKE, 'lnk_1')).toEqual({ applied: true })
    expect(await call<unknown>(priya, ch.EXTERNAL_REVOKE, 'lnk_0')).toEqual({ applied: false, code: 'link.not_revoked', message: 'That link was already used.' })
    expect(await call<unknown>(priya, ch.EXTERNAL_PREVIEW_RESEND, { linkId: 'lnk_1' })).toEqual({ to: 'asha@example.com', via: 'email', subject: 'Your details for Acme', body: 'Hello Asha' })
    await expect(call(priya, ch.EXTERNAL_PREVIEW_RESEND, { linkId: 'lnk_other' })).rejects.toThrow('That link was not found.')
    await expect(call(priya, ch.EXTERNAL_PREVIEW_RESEND, { linkId: 'lnk_nope' })).rejects.toThrow('That link was not found.')
    const r = await call(priya, ch.EXTERNAL_RESEND, { linkId: 'lnk_1', via: 'sms' })
    expect(r).toEqual({ applied: true, delivery: DELIVERY })
    expect(calls.find((c) => c.method === 'resend')!.args[0]).toEqual({ linkId: 'lnk_1', by: { kind: 'person', personId: 'person_priya', roles: ['staff'] } })
  })

  it('reads a step\'s documents for staff', async () => {
    const { call, priya } = setup()
    const r = await call(priya, ch.EXTERNAL_EXTRACT, { stepRunId: 'sr_fill', documents: ['file_1'] })
    expect(r.suggestions[0]).toMatchObject({ field: 'pan', document: 'pan-card.pdf', prefill: true })
    await expect(call(priya, ch.EXTERNAL_EXTRACT, { stepRunId: 'sr_fill', documents: [3] })).rejects.toThrow('Choose the documents')
  })
})

describe('the case and the inbox', () => {
  it('carry links, deliveries and Phase 5 provenance', async () => {
    const { call, admin } = setup()
    const c: MwCase = await call(admin, ch.CASES_GET, 'case_1')
    expect(c.links!.map((l) => l.id)).toEqual(['lnk_1', 'lnk_0'])
    expect(c.deliveries).toEqual([DELIVERY])
    expect(c.values.pan).toEqual({ value: 'AAACM1234M', provenance: { kind: 'external', at: 't', by: 'Asha Rao', linkId: 'lnk_1', stepRunId: 'sr_fill' }, tainted: true })
    expect(c.values.gstin!.provenance).toEqual({
      kind: 'tool', at: 't', stepRunId: 'sr_fill', tool: 'intake.extract_fields', callId: 'form.extract:1', document: 'gst-certificate.pdf', confidence: 0.93, confirmedBy: 'external:lnk_1',
    })
  })

  it('maps provenance without the kernel\'s own fields', () => {
    expect(toProvenance({ kind: 'tool', at: 't', stepRunId: 's', tool: 'x', callId: 'c', tainted: true })).toEqual({ kind: 'tool', at: 't', stepRunId: 's', tool: 'x', callId: 'c' })
    expect(toCaseValue({ value: 1, provenance: { kind: 'person', at: 't', by: 'p' } })).toEqual({ value: 1, provenance: { kind: 'person', at: 't', by: 'p' } })
  })

  it('offers extraction on an input step that names it', () => {
    expect(toInboxExtract(undefined)).toBeUndefined()
    expect(toInboxExtract({ extract: { tool: 'intake.extract_fields', documents: 'documents', fields: { pan: 'pan', legal_name: 'client_name', name: 'client_name' }, minConfidence: 0.8 } } as never))
      .toEqual({ documentsField: 'documents', fields: ['pan', 'client_name'], minConfidence: 0.8 })
  })
})

describe('the public address setting', () => {
  it('shows the status to anyone, and lets only the owner change it', async () => {
    const { call, calls, admin, priya } = setup()
    expect(await call<unknown>(priya, ch.RELAY_STATUS)).toEqual({ enabled: false, state: 'off' })
    await expect(call(priya, ch.RELAY_CONFIGURE, { enabled: true, relayUrl: 'https://relay.memwise.app' })).rejects.toThrow('Only the owner')
    expect(calls.some((c) => c.method === 'configure')).toBe(false)
    const s = await call(admin, ch.RELAY_CONFIGURE, { enabled: true, relayUrl: 'https://relay.memwise.app' })
    expect(s).toMatchObject({ enabled: true, state: 'connecting', relayUrl: 'https://relay.memwise.app' })
    await expect(call(admin, ch.RELAY_CONFIGURE, {})).rejects.toThrow('on or off')
  })

  it('lets the owner signed in as a person change it too', async () => {
    const { call } = setup()
    // The owner's own sign-in (personId of the owner) has the owner's privileges.
    const ownerSignedIn = { clientId: 'c-owner', personId: 'owner' } as never
    expect(await call<unknown>(ownerSignedIn, ch.RELAY_CONFIGURE, { enabled: false })).toMatchObject({ enabled: false, state: 'off' })
  })

  it('is off while the playbooks are not running', async () => {
    const { call, admin } = setup()
    resetMemwiseHost()
    expect(await call<unknown>(admin, ch.RELAY_STATUS)).toEqual({ enabled: false, state: 'off' })
  })
})

describe('channels and notifications', () => {
  it('lists the bound channel tools', async () => {
    const { call, admin } = setup()
    expect(await call<unknown>(admin, ch.CHANNELS_AVAILABLE)).toEqual({ email: { tool: 'email.send', plugin: 'memwise/email-smtp' }, whatsapp: null })
  })

  it('lets a person read and set their own notifications', async () => {
    const { call, calls, priya } = setup()
    expect(await call<unknown>(priya, ch.NOTIFY_GET)).toEqual({ email: true })
    expect(calls.find((c) => c.method === 'notifySettings')!.args).toEqual(['person_priya'])
    expect(await call<unknown>(priya, ch.NOTIFY_SET, { email: false, whatsapp: '+91 98765 43210' })).toEqual({ email: false, whatsapp: '+919876543210' })
    const set = calls.find((c) => c.method === 'setNotifySettings')!
    expect(set.args[0]).toBe('person_priya')
    await expect(call(priya, ch.NOTIFY_SET, { whatsapp: '98765' })).rejects.toThrow('international form')
    await expect(call(priya, ch.NOTIFY_SET, { email: 'yes' })).rejects.toThrow('Choose whether')
  })
})
