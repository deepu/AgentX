import { describe, expect, it } from 'bun:test'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n } from '@memwise/shared/i18n/setupI18n'
import type { MwDraft } from '@memwise/shared/protocol'
import { applyStepEdit, readStepFile, splitStepFile, yamlScalar } from '../step-file'
import { changeLines, draftFileText, fileLabel, pendingEdits, sortDrafts, stepIdOfPath, stepsTouchedBy } from '../draft-model'
import { mergeForChange, eventName } from '../../map/change'
import { sampleDraft, sampleDraftPlaybook, sampleDraftSummaries, sampleLivePlaybook, sampleStructure } from '../sample-draft'

const i18n = setupI18n([initReactI18next])
setI18n(i18n)
i18n.changeLanguage('en')
const t = i18n.t.bind(i18n) as unknown as import('i18next').TFunction

const STEP = `---
title: Check the client's answers
performer: agent
strictness: guided
reads: [case.pan]
tools:
  allowed: [gst.validate_gstin]   # keep this comment
checkpoint:
  - every flag names the document
outcomes: [checked, failed]
---
Old instructions.
`

describe('applyStepEdit', () => {
  it('replaces only the keys it edits and the body, keeping the rest as written', () => {
    const out = applyStepEdit(STEP, {
      title: 'Check: the answers',
      checkpoint: ['every flag names the document', 'a PAN mismatch is flagged'],
      instructions: 'New **instructions**.\n\nSecond paragraph.',
    })
    expect(out).toBe(`---
title: "Check: the answers"
performer: agent
strictness: guided
reads: [case.pan]
tools:
  allowed: [gst.validate_gstin]   # keep this comment
checkpoint:
  - every flag names the document
  - a PAN mismatch is flagged
outcomes: [checked, failed]
---
New **instructions**.

Second paragraph.
`)
  })

  it('adds an assignee after the performer and removes it with null', () => {
    const withAssignee = applyStepEdit(STEP, { performer: 'person', assignee: 'manager' })
    expect(withAssignee).toContain('performer: person\nassignee: manager\nstrictness: guided')
    expect(applyStepEdit(withAssignee, { assignee: null })).not.toContain('assignee')
  })

  it('drops the checkpoint when every rule is removed and refuses text without front matter', () => {
    expect(applyStepEdit(STEP, { checkpoint: ['  '] })).not.toContain('checkpoint')
    expect(() => applyStepEdit('just text', { title: 'x' })).toThrow()
  })

  it('quotes scalars YAML would read differently', () => {
    expect(yamlScalar('plain words')).toBe('plain words')
    expect(yamlScalar('yes')).toBe('"yes"')
    expect(yamlScalar('a: b')).toBe('"a: b"')
    expect(yamlScalar('- dash')).toBe('"- dash"')
    expect(splitStepFile(STEP)?.body).toBe('Old instructions.\n')
    expect(readStepFile(STEP)?.instructions).toBe('Old instructions.')
  })
})

describe('mergeForChange', () => {
  const merged = mergeForChange(sampleDraftPlaybook, sampleStructure, sampleLivePlaybook)

  it('draws removed states back in where the live playbook had them', () => {
    const ids = merged.playbook.states.map(s => s.id)
    expect(ids.indexOf('notify')).toBe(ids.indexOf('onboard') + 1)
    expect(merged.playbook.steps.notify?.title).toBe('Email the welcome pack')
    expect(merged.states).toMatchObject({ screen: 'added', check: 'changed', notify: 'removed' })
  })

  it('marks edges added, removed or changed', () => {
    expect(merged.edges['check>screen']).toBe('added')
    expect(merged.edges['screen>verify']).toBe('added')
    expect(merged.edges['check>verify']).toBe('removed')
    expect(merged.edges['onboard>notify']).toBe('removed')
    expect(merged.edges['notify>end']).toBe('removed')
    expect(merged.edges['onboard>end']).toBe('added')
    // The removed `checked` transition reuses an event the draft still has: it gets the marker.
    const check = merged.playbook.states.find(s => s.id === 'check')!
    const removedKey = Object.keys(check.on).find(k => k !== 'checked' && eventName(k) === 'checked')
    expect(removedKey && check.on[removedKey]).toBe('verify')
  })

  it('draws only the draft without the live playbook', () => {
    const only = mergeForChange(sampleDraftPlaybook, sampleStructure)
    expect(only.playbook.states.some(s => s.id === 'notify')).toBe(false)
    expect(only.states.notify).toBeUndefined()
  })
})

describe('draft model', () => {
  it('describes the change in plain words', () => {
    const lines = changeLines(sampleStructure, t, sampleDraftPlaybook, sampleLivePlaybook, 'en')
    const texts = lines.map(l => l.text)
    expect(texts[0]).toBe('Version 2 → 3')
    expect(texts).toContain('New step “Screen for sanctions”')
    expect(texts).toContain('Step “Email the welcome pack” removed')
    expect(texts).toContain("Step “Check the client's answers”: instructions and what it may use changed")
    expect(texts).toContain('“Screen for sanctions” must now use sanctions.screen')
    expect(texts).toContain("After “Check the client's answers”, checked now goes to “Screen for sanctions”")
    expect(texts).toContain('New example cases: “Sanctions hit”')
    expect(texts.join('\n')).not.toMatch(/workflow|yaml|API/i)
    expect(lines.find(l => l.text.startsWith('New step'))).toMatchObject({ kind: 'added', step: 'screen' })
  })

  it('names files, steps and pending edits', () => {
    expect(stepIdOfPath('workflows/client-intake/steps/screen.md')).toBe('screen')
    expect(stepIdOfPath('workflows/client-intake/workflow.yaml')).toBeUndefined()
    expect(fileLabel('workflows/client-intake/steps/screen.md', t, sampleDraftPlaybook)).toBe('Step “Screen for sanctions”')
    expect(fileLabel('workflows/client-intake/workflow.yaml', t)).toBe("The playbook's steps and routes")
    expect(pendingEdits(sampleDraft).map(e => e.id)).toEqual(['ed_3'])
    expect(stepsTouchedBy(sampleDraft.edits[0]!)).toEqual(['screen'])
  })

  it('finds a step file’s text, else rebuilds an added one from its diff', () => {
    expect(draftFileText(sampleDraft, 'workflows/client-intake/steps/check.md')).toContain('title: Check the client')
    const { fileTexts: _t, ...withoutTexts } = sampleDraft
    const draft: MwDraft = withoutTexts
    expect(draftFileText(draft, 'workflows/client-intake/steps/screen.md')).toContain('title: Screen for sanctions')
    expect(draftFileText(draft, 'workflows/client-intake/steps/check.md')).toBeUndefined()
  })

  it('sorts open drafts first, newest first', () => {
    expect(sortDrafts(sampleDraftSummaries).map(d => d.id)).toEqual(['drf_sanctions', 'drf_letter', 'drf_old'])
  })
})
