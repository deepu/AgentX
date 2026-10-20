import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Message } from '@memwise/core/types'
import type { AuthRequest } from '@memwise/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Parallel sessions waiting on the same source's OAuth share one sign-in: when it succeeds,
// completeAuthRequestsForSource answers every session in the workspace paused on that source.

describe('SessionManager.completeAuthRequestsForSource', () => {
  let tmpRoot: string
  let sm: SessionManager
  let resumed: Array<{ sessionId: string; message: string }>
  let events: Array<Record<string, unknown>>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-auth-fanout-'))
    sm = new SessionManager()
    resumed = []
    events = []
    const stub = sm as unknown as Record<string, unknown>
    stub.decisionFeatureActive = () => false
    stub.persistSession = () => {}
    stub.sendEvent = (event: Record<string, unknown>) => { events.push(event) }
    // The resumed turn never finishes here: completing must not wait on it
    stub.sendMessage = (sessionId: string, message: string) => {
      resumed.push({ sessionId, message })
      return new Promise<void>(() => {})
    }
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function session(id: string, workspaceId: string, pending?: Partial<AuthRequest> & { type: AuthRequest['type'] }) {
    const workspace = { id: workspaceId, name: workspaceId, rootPath: join(tmpRoot, workspaceId), createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
    if (pending) {
      const request = { requestId: `auth-${id}`, sessionId: id, sourceName: pending.sourceSlug, ...pending } as AuthRequest
      managed.pendingAuthRequest = request
      managed.pendingAuthRequestId = request.requestId
      managed.messages.push(authCard(request.requestId, request.sourceSlug))
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function authCard(requestId: string, sourceSlug: string): Message {
    return {
      id: `msg-${requestId}`,
      role: 'auth-request',
      content: '',
      timestamp: Date.now(),
      authRequestId: requestId,
      authRequestType: 'oauth-google',
      authSourceSlug: sourceSlug,
      authStatus: 'pending',
    } as Message
  }

  it('answers every session in the workspace paused on the source, and nothing else', () => {
    const first = session('s1', 'ws-1', { type: 'oauth-google', sourceSlug: 'gmail' })
    const second = session('s2', 'ws-1', { type: 'oauth-google', sourceSlug: 'gmail' })
    const otherSource = session('s3', 'ws-1', { type: 'oauth-google', sourceSlug: 'calendar' })
    const otherWorkspace = session('s4', 'ws-2', { type: 'oauth-google', sourceSlug: 'gmail' })
    const credentialForm = session('s5', 'ws-1', { type: 'credential', sourceSlug: 'gmail' })
    session('s6', 'ws-1')

    const ids = sm.completeAuthRequestsForSource('ws-1', 'gmail', { email: 'me@example.com' })

    expect(ids).toEqual(['s1', 's2'])
    for (const managed of [first, second]) {
      expect(managed.pendingAuthRequest).toBeUndefined()
      expect(managed.messages[0]!.authStatus).toBe('completed')
      expect(managed.messages[0]!.authEmail).toBe('me@example.com')
      expect(managed.enabledSourceSlugs).toContain('gmail')
    }
    for (const managed of [otherSource, otherWorkspace, credentialForm]) {
      expect(managed.pendingAuthRequest).toBeDefined()
      expect(managed.messages[0]!.authStatus).toBe('pending')
    }
    expect(resumed).toEqual([
      { sessionId: 's1', message: 'Authentication completed for gmail. Signed in as me@example.com. Credentials have been saved.' },
      { sessionId: 's2', message: 'Authentication completed for gmail. Signed in as me@example.com. Credentials have been saved.' },
    ])
    expect(events.filter(e => e.type === 'auth_completed').map(e => [e.sessionId, e.requestId])).toEqual([
      ['s1', 'auth-s1'],
      ['s2', 'auth-s2'],
    ])
  })

  it('answers a clicked card whose session forgot the request (restart), but not a finished one', () => {
    const restarted = session('s1', 'ws-1')
    restarted.messages.push(authCard('auth-old', 'gmail'))
    const finished = session('s2', 'ws-1')
    finished.messages.push({ ...authCard('auth-done', 'gmail'), authStatus: 'cancelled' } as Message)

    const ids = sm.completeAuthRequestsForSource('ws-1', 'gmail', {}, [
      { sessionId: 's1', authRequestId: 'auth-old' },
      { sessionId: 's2', authRequestId: 'auth-done' },
    ])

    expect(ids).toEqual(['s1'])
    expect(restarted.messages[0]!.authStatus).toBe('completed')
    expect(finished.messages[0]!.authStatus).toBe('cancelled')
    expect(resumed.map(r => r.sessionId)).toEqual(['s1'])
  })

  it('a bound card does not override a different request the session is waiting on', () => {
    const managed = session('s1', 'ws-1', { type: 'oauth', sourceSlug: 'linear' })
    managed.messages.push(authCard('auth-stale', 'gmail'))

    const ids = sm.completeAuthRequestsForSource('ws-1', 'gmail', {}, [{ sessionId: 's1', authRequestId: 'auth-stale' }])

    expect(ids).toEqual([])
    expect(managed.pendingAuthRequest?.requestId).toBe('auth-s1')
  })

  it('clears the refresh cooldown for the source in every session of the workspace', () => {
    const waiting = session('s1', 'ws-1', { type: 'oauth-google', sourceSlug: 'gmail' })
    const idle = session('s2', 'ws-1')
    const elsewhere = session('s3', 'ws-2')
    const cleared: string[] = []
    for (const managed of [waiting, idle, elsewhere]) {
      managed.tokenRefreshManager.clearCooldown = (slug: string) => { cleared.push(`${managed.id}:${slug}`) }
    }

    sm.completeAuthRequestsForSource('ws-1', 'gmail', {})

    expect(new Set(cleared)).toEqual(new Set(['s1:gmail', 's2:gmail']))
  })
})
