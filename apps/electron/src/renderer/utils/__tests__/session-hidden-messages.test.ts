import { describe, expect, it } from 'bun:test'
import { firstVisibleUserMessage, getSessionTitle } from '../session'

type Messages = Parameters<typeof firstVisibleUserMessage>[0]

describe('hidden messages', () => {
  // A build chat starts with a hidden brief for the agent; the person's first words name the chat.
  const messages = [
    { id: 'm0', role: 'user', content: 'You are building a playbook. Brief: …', hidden: true, timestamp: 1 },
    { id: 'm1', role: 'assistant', content: 'What should it do?', timestamp: 2 },
    { id: 'm2', role: 'user', content: 'Draft engagement letters', timestamp: 3 },
  ] as unknown as Messages

  it('skips hidden messages for the title and preview', () => {
    expect(firstVisibleUserMessage(messages)?.content).toBe('Draft engagement letters')
    const title = getSessionTitle({ id: 's1', messages } as unknown as Parameters<typeof getSessionTitle>[0])
    expect(title.toLowerCase()).toContain('draft engagement letters')
  })
})
