import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession, type SessionCompletionEvent } from './SessionManager.ts'

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

// The in-process completion seam the task runner advances steps on. Found 2026-10-11: a step the
// user stopped was reported as `complete` and marked done with no output, and a turn without a new
// reply reported the previous turn's.
describe('session completion seam', () => {
  let tmpRoot: string
  let sm: SessionManager
  let completions: SessionCompletionEvent[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-completion-'))
    sm = new SessionManager()
    ;(sm as any).decisionFeatureActive = () => false
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    ;(sm as any).keepBackgroundTasksAlive = true
    // Hermetic: a new reply would otherwise ask the decision layer for a status and a title.
    ;(sm as any).applyTurnOutcome = async () => {}
    ;(sm as any).refreshTitleIfDrifted = async () => {}
    sm.setEventSink(() => {})
    completions = []
    sm.onSessionComplete(evt => completions.push(evt))
  })

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  function session(id: string) {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  /** A backend whose turn ends with the SDK's `complete` once released, as it does after a stop. */
  function gatedAgent() {
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    ;(sm as any).getOrCreateAgent = async () => ({
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      forceAbort: () => {},
      chat: async function* () { started.resolve(); await gate.promise; yield { type: 'complete' } },
    })
    return { release: () => gate.resolve(), started: started.promise }
  }

  it('reports a turn the user stopped as interrupted, even though the backend ends it with complete', async () => {
    const managed = session('stopped')
    const agent = gatedAgent()
    const sending = sm.sendMessage(managed.id, 'Map the site')
    await agent.started
    await sm.cancelProcessing(managed.id)
    agent.release()
    await sending
    await waitFor(() => completions.length === 1, 'the completion')

    expect(completions[0]).toMatchObject({ sessionId: 'stopped', reason: 'interrupted' })
  })

  it('reports a turn that ran to its end as complete', async () => {
    const managed = session('finished')
    const agent = gatedAgent()
    const sending = sm.sendMessage(managed.id, 'Map the site')
    await agent.started
    agent.release()
    await sending
    await waitFor(() => completions.length === 1, 'the completion')

    expect(completions[0]!.reason).toBe('complete')
  })

  it('carries only the reply this turn produced, and the background agents still running', async () => {
    const managed = session('scoped')
    managed.messages = [{ id: 'old', role: 'assistant', content: 'earlier reply', timestamp: 1 } as any]
    const task = (taskId: string, extra: Record<string, unknown>) =>
      managed.backgroundTaskRegistry.set(taskId, { taskId, startTime: 1, status: 'running', ...extra } as any)
    task('agent', { kind: 'agent' })
    task('workflow', { kind: 'workflow' })
    task('shell', { kind: 'shell' }) // a dev server may never end
    task('monitor', { kind: 'task' })
    task('subagent-own', { kind: 'agent', untracked: true })
    task('done', { kind: 'agent', status: 'completed' })

    managed.turnStartFinalMessageId = 'old'
    await (sm as any).onProcessingStopped(managed.id, 'complete')
    expect(completions[0]).toMatchObject({ reason: 'complete', backgroundWorkRunning: 2 })
    expect(completions[0]!.finalText).toBeUndefined()
    expect(completions[0]!.finalMessageId).toBeUndefined()

    managed.messages.push({ id: 'new', role: 'assistant', content: 'the site map', timestamp: 2 } as any)
    managed.turnStartFinalMessageId = 'old'
    await (sm as any).onProcessingStopped(managed.id, 'complete')
    expect(completions[1]).toMatchObject({ finalMessageId: 'new', finalText: 'the site map' })
  })

  it('reports activity for every agent event of the session, until unsubscribed', async () => {
    const managed = session('busy')
    session('quiet')
    let seen = 0
    const off = sm.onSessionActivity('busy', () => { seen++ })
    sm.onSessionActivity('quiet', () => { throw new Error('not this session') })

    await (sm as any).processEvent(managed, { type: 'status', message: 'Thinking…' })
    await (sm as any).processEvent(managed, { type: 'text_delta', text: 'id:', turnId: 't1' })
    expect(seen).toBe(2)

    off()
    await (sm as any).processEvent(managed, { type: 'text_delta', text: ' demo', turnId: 't1' })
    expect(seen).toBe(2)
  })

  it('says whether the turn answered the user or an app-generated message', async () => {
    const managed = session('origin')
    const agent = gatedAgent()
    agent.release()
    await sm.sendMessage(managed.id, 'Map the site')
    await sm.sendMessage(managed.id, '[background-task-completed] …', undefined, undefined, { hidden: true })
    await waitFor(() => completions.length === 2, 'both completions')
    expect(completions.map(c => c.fromUser)).toEqual([true, false])
  })

  it('stops a turn without killing background work when the backend can, else hard-stops', async () => {
    const calls: string[] = []
    const stopWith = async (stopTurn: (() => boolean) | undefined) => {
      const managed = session(`stop-${calls.length}`)
      managed.isProcessing = true
      managed.agent = { ...(stopTurn ? { stopTurn } : {}), forceAbort: () => { calls.push('forceAbort') } } as any
      await sm.cancelProcessing(managed.id, true)
      managed.isProcessing = false // the 5 s safety timer then finds nothing to clean up
    }

    await stopWith(() => { calls.push('stopTurn'); return true })
    expect(calls).toEqual(['stopTurn'])
    await stopWith(() => { calls.push('stopTurn'); return false }) // no live keep-alive turn
    expect(calls).toEqual(['stopTurn', 'stopTurn', 'forceAbort'])
    await stopWith(undefined) // Pi and other backends
    expect(calls).toEqual(['stopTurn', 'stopTurn', 'forceAbort', 'forceAbort'])
  })

  it('counts no background work when it does not outlive the turn', async () => {
    const managed = session('no-keep-alive')
    ;(sm as any).keepBackgroundTasksAlive = false
    managed.backgroundTaskRegistry.set('agent', { taskId: 'agent', startTime: 1, status: 'running', kind: 'agent' } as any)
    await (sm as any).onProcessingStopped(managed.id, 'complete')
    expect(completions[0]!.backgroundWorkRunning).toBe(0)
  })

  it('wakes a task step whose background agent the user stopped, so the step can finish', async () => {
    const sent: Array<{ id: string; message: string }> = []
    ;(sm as any).sendMessage = async (id: string, message: string) => { sent.push({ id, message }) }
    const stopFromChip = async (managed: ReturnType<typeof session>) => {
      managed.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: 1, status: 'running', kind: 'agent', intent: 'Research', stopRequestedAt: 2 } as any)
      await (sm as any).processEvent(managed, { type: 'task_completed', taskId: 't1', status: 'stopped' })
    }

    await stopFromChip(session('chat'))
    expect(sent).toEqual([])

    const step = session('task-step')
    step.taskRunId = 'run-1'
    await stopFromChip(step)
    expect(sent.map(s => s.id)).toEqual(['task-step'])
    expect(sent[0]!.message).toContain('[background-task-stopped]')
  })

  // Found 2026-10-11: the wake-up told the agent to read the output file, which for a background
  // agent is its whole JSONL transcript; the task notification already has the result.
  it('points a woken session at the task notification, not at the agent transcript', async () => {
    const sent: string[] = []
    ;(sm as any).sendMessage = async (_id: string, message: string) => { sent.push(message) }
    const managed = session('woken')
    managed.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: 1, status: 'running', kind: 'agent', intent: 'Map code' } as any)

    await (sm as any).processEvent(managed, { type: 'task_completed', taskId: 't1', status: 'completed', outputFile: '/tmp/tasks/t1.output' })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Its result is in the task notification')
    expect(sent[0]).toContain("is the agent's full transcript: do not read it whole")
    expect(sent[0]).not.toContain('Read that output file')
    // Nobody typed it: the agent must not take it for the user.
    expect(sent[0]!.startsWith('<system-notification>\nSent by MemWise automatically, not typed by the user.')).toBe(true)
    expect(sent[0]!.trimEnd().endsWith('</system-notification>')).toBe(true)
  })
})
