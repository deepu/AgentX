import { describe, expect, it } from 'bun:test'
import type { MwPlaybook } from '@memwise/shared/protocol'
import { samplePlaybook } from '../../playbook/sample-playbook'
import { toMermaid } from '../mermaid'

describe('toMermaid', () => {
  it('exports the intake playbook as a left-to-right state diagram', () => {
    const out = toMermaid(samplePlaybook)
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('stateDiagram-v2')
    expect(lines[1]).toBe('  direction LR')
    expect(out).toContain('  state "Check the client\'s answers" as check')
    expect(out).toContain('  state "needs person" as needs_person')
    expect(out).toContain('  [*] --> fill')
    expect(out).toContain('  fill --> check: submitted')
    expect(out).toContain('  check --> fill: needs info')
    expect(out).toContain('  check --> needs_person: failed')
    expect(out).toContain('  onboard --> [*]: done')
    expect(out).toContain('  fill --> needs_person: timeout')
    expect(out).toContain('  needs_person --> [*]: timeout')
  })

  it('escapes ids and text Mermaid would misread', () => {
    const playbook: MwPlaybook = {
      id: 'p', version: 1, hash: 'h', title: 'P', start: 'step-1', caseFields: [], diagnostics: [],
      states: [{ id: 'step-1', stepId: 'step-1', on: { 'ok:yes': 'end' }, wait: { timeout: { afterMs: 1, target: 'end' } } }],
      steps: { 'step-1': { id: 'step-1', title: 'Say "hi": now', performer: 'agent', strictness: 'open', instructions: '', reads: [], writes: [], tools: [], checkpoint: [], outcomes: ['ok:yes'], policy: [], file: 'x.md' } },
    }
    const out = toMermaid(playbook, { timeoutLabel: () => 'after 1 day' })
    expect(out).toContain('state "Say #quot;hi#quot;#58; now" as step_1')
    expect(out).toContain('[*] --> step_1')
    expect(out).toContain('step_1 --> [*]: ok#58;yes')
    expect(out).toContain('step_1 --> [*]: after 1 day')
  })
})
