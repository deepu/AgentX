/**
 * Drives the MemWise app API the way clients do, for the exit tests: a fake RPC server that
 * records handlers and pushes, a fake session manager that records the chats the API opens
 * (their names, MemWise context and hidden first turns), and polling helpers.
 */
import type { SessionMemwiseContext } from '@memwise/shared/sessions'
import type { RequestContext, RpcServer } from '../../transport/types'

export const WS = 'ws-test'
export const quiet = { info() {}, warn() {}, error: (...a: unknown[]) => console.error(...a) }

type Handler = (ctx: RequestContext, ...args: any[]) => Promise<any>

/** A server that records handlers and pushes, so tests call channels the way clients do. */
export function fakeServer() {
  const handlers = new Map<string, Handler>()
  const pushes: { channel: string; args: unknown[] }[] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler as Handler) },
    push(channel, _target, ...args) { pushes.push({ channel, args }) },
    async invokeClient() {},
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const call = async <T = any>(ctx: RequestContext, channel: string, ...args: unknown[]): Promise<T> => {
    const h = handlers.get(channel)
    if (!h) throw new Error(`no handler for ${channel}`)
    return h(ctx, WS, ...args)
  }
  return { server, handlers, pushes, call }
}

export function fakeSessions() {
  const created: { workspaceId: string; name?: string; id: string }[] = []
  const sent: { sessionId: string; message: string; hidden?: boolean }[] = []
  const contexts = new Map<string, Omit<SessionMemwiseContext, 'setAt'>>()
  const deleted = new Set<string>()
  return {
    created,
    sent,
    contexts,
    deleted,
    manager: {
      async createSession(workspaceId: string, options?: { name?: string }) {
        const id = `session-${created.length + 1}`
        created.push({ workspaceId, name: options?.name, id })
        return { id, workspaceId, name: options?.name } as any
      },
      async getSession(sessionId: string) {
        const s = created.find((c) => c.id === sessionId)
        return s && !deleted.has(sessionId) ? ({ id: s.id, workspaceId: s.workspaceId, name: s.name } as any) : null
      },
      setMemwiseContext(sessionId: string, ctx: Omit<SessionMemwiseContext, 'setAt'>) {
        contexts.set(sessionId, ctx)
        return true
      },
      async sendMessage(sessionId: string, message: string, _a?: unknown, _b?: unknown, options?: { hidden?: boolean }) {
        sent.push({ sessionId, message, hidden: options?.hidden })
      },
    },
  }
}

export const ctxFor = (clientId: string, personId?: string): RequestContext => ({ clientId, workspaceId: WS, webContentsId: null, ...(personId ? { personId } : {}) })

export async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 500)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}
