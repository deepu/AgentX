/**
 * The page tools of a chat anchored to a page (docs/memwise/26-projects-and-pages.md §4), over a
 * fake kernel: page_get reads the page as written (tagged as untrusted data), page_update writes a
 * new version as the person with `via: chat:<id>`, only on its own page or pages it made, and a
 * refusal (a kept page in a regulated project) comes back to the model as an error; page_create
 * makes a draft in the page's project.
 */
import { describe, expect, it } from 'bun:test'
import { handlePageCreate, handlePageGet, handlePageUpdate } from '@memwise/session-tools-core'
import { buildMemwisePageToolCallbacks, type PageChatContext } from '../chat-tools'

const ACTOR = { kind: 'person', personId: 'person_leah', roles: ['lead'] }

function page(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, project: 'literature', domain: 'literature', title: id === 'page_wl' ? 'Weight loss' : 'Other', status: 'draft', headline: 'h', pinned: false,
    sumsChildren: false, version: 2, updatedAt: 't', body: 'About 15%.', written: 'About 15%.', regulated: false, breadcrumb: [{ id: 'page_glp1', title: 'GLP-1' }],
    children: [], history: [], canUndo: true, changes: [], question: 'How much weight?', ...extra,
  }
}

function setup(opts: { regulated?: boolean } = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const pages = {
    get: async (id: string) => (id === 'page_wl' ? page(id, opts.regulated ? { status: 'kept', regulated: true } : {}) : id === 'page_mine' ? page(id, { chatId: 'chat_1' }) : id === 'page_other' ? page(id, { chatId: 'chat_9' }) : undefined),
    update: async (...args: unknown[]) => {
      calls.push({ method: 'update', args })
      return opts.regulated
        ? { applied: false, status: 'regulated', message: 'Literature is a regulated project: a kept page there changes through a change request.' }
        : { applied: true, status: 'applied', page: page(args[0] as string, { version: 3 }) }
    },
    create: async (...args: unknown[]) => {
      calls.push({ method: 'create', args })
      return { applied: true, status: 'applied', page: page('page_new', { title: (args[0] as { title: string }).title }) }
    },
  }
  const ctx: PageChatContext = { svc: { kernel: { pages } } as never, actor: ACTOR as never, pageId: 'page_wl' }
  const callbacks = buildMemwisePageToolCallbacks({ sessionId: 'chat_1', resolve: async () => ctx })
  return { calls, tools: { memwisePages: callbacks } as never }
}

const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('')

describe('page chat tools', () => {
  it('page_get: the page as written, its place and question, as untrusted data', async () => {
    const { tools } = setup()
    const r = await handlePageGet(tools, {})
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('<untrusted_record_data>')
    expect(text(r)).toContain('"body": "About 15%."')
    expect(text(r)).toContain('GLP-1 (page_glp1)')
    expect(text(await handlePageGet(tools, { page: 'gone' }))).toContain('There is no page gone')
  })

  it('page_update: a new version as the person, from this chat; only its own page or pages it made', async () => {
    const { tools, calls } = setup()
    const r = await handlePageUpdate(tools, { body: 'About 16%.', reason: 'Added how long each trial ran' })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('Undo')
    expect(calls[0]!.args.slice(0, 2)).toEqual(['page_wl', { body: 'About 16%.', via: 'chat:chat_1', reason: 'Added how long each trial ran' }])
    expect(calls[0]!.args[2]).toEqual(ACTOR)
    expect((await handlePageUpdate(tools, { page: 'page_mine', title: 'Mine' })).isError).toBeFalsy()
    const other = await handlePageUpdate(tools, { page: 'page_other', body: 'x' })
    expect(other.isError).toBe(true)
    expect(text(other)).toContain('only its own page')
    expect((await handlePageUpdate(tools, {})).isError).toBe(true)
  })

  it('page_update in a regulated project: refused, and the model is told why', async () => {
    const { tools } = setup({ regulated: true })
    const r = await handlePageUpdate(tools, { body: 'x' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('change request')
  })

  it('page_create: a draft in the page\'s project, made from this chat', async () => {
    const { tools, calls } = setup()
    const r = await handlePageCreate(tools, { title: 'Muscle loss', question: 'Do people lose muscle?', parent: 'page_glp1' })
    expect(r.isError).toBeFalsy()
    expect(calls[0]!.args[0]).toEqual({ project: 'literature', title: 'Muscle loss', question: 'Do people lose muscle?', parent: 'page_glp1', chatId: 'chat_1', via: 'chat:chat_1', reason: 'Asked a question' })
    expect((await handlePageCreate(tools, { title: ' ' })).isError).toBe(true)
  })

  it('without a page chat, the tools say so', async () => {
    expect(text(await handlePageGet({} as never, {}))).toContain('only available in a chat opened on a MemWise page')
  })
})
