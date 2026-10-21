import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n } from '@memwise/shared/i18n/setupI18n'
import { samplePlaybook, sampleRoles } from '../sample-playbook'

// The markdown renderer pulls in the PDF block: pdf.js needs a browser and its worker is a Vite asset.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { EffectivePolicyView, PlaybookView, StepDetail } = await import('../index')

const i18n = setupI18n([initReactI18next])
// setupI18n is once per process: if another test file set it up without the React binding, bind it here.
setI18n(i18n)
i18n.changeLanguage('en')

/** Text content only, so assertions don't depend on markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ')

describe('PlaybookView', () => {
  const html = renderToStaticMarkup(createElement(PlaybookView, { playbook: samplePlaybook, roles: sampleRoles }))
  const out = text(html)

  it('reads as numbered steps with who does each', () => {
    expect(out).toContain('Client intake')
    expect(out).toContain('Version 1')
    expect(out).toContain('4 steps')
    expect(out).toContain('Client fills in the intake form')
    expect(out).toContain("Check the client's answers")
    expect(out).toContain('Manager approves onboarding')
    expect(out).toContain('Create the customer')
    for (const tag of ['Agent', 'Manager', 'Client', 'Automatic', 'Staff can fill it in for them']) expect(out).toContain(tag)
    expect(out).toContain('Needs a person')
    expect(html).not.toContain('memwise.playbook.')
  })

  it('says what happens next in words', () => {
    expect(out).toContain('If checked → Manager approves onboarding')
    expect(out).toContain('If needs info → back to Client fills in the intake form')
    expect(out).toContain('If sent back → back to Client fills in the intake form')
    expect(out).toContain('If done → the run is finished')
    expect(out).toContain('If failed or needs person → Needs a person')
    expect(out).toContain('Reminder after 3 days, goes to Needs a person after 7 days')
    expect(out).toContain('Closes after 7 days if nothing happens')
  })

  it('shows tools with their effect, approvals, reads, writes and checkpoints', () => {
    expect(out).toContain('gst.validate_gstin')
    expect(out).toContain('Must use')
    expect(out).toContain('Sends')
    expect(out).toContain('Needs approval')
    expect(out).toContain('every flag names the document it came from')
    expect(out).toContain('client name')
    expect(out).toContain('Identifier(GSTIN)')
    expect(out).toContain('List<Flag>')
    // Instructions come through the markdown renderer.
    expect(html).toContain('<strong')
  })

  it('lists diagnostics at the top', () => {
    expect(out).toContain('1 thing to check in this playbook')
    expect(out).toContain("The email plugin's daily sending limit")
  })

  it('shows the effective policy of a step it opens', () => {
    const open = text(renderToStaticMarkup(createElement(PlaybookView, { playbook: samplePlaybook, roles: sampleRoles, selectedStepId: 'check' })))
    expect(open).toContain('Rules this step follows')
    expect(open).toContain('40,000')
    expect(open).toContain('This step')
  })
})

describe('EffectivePolicyView', () => {
  // Source paths may wrap after their slashes; drop those break points for the assertions.
  const out = text(renderToStaticMarkup(createElement(EffectivePolicyView, { rules: samplePlaybook.steps.check!.policy }))).replace(/\/ /g, '/')

  it('labels each rule with its layer and source', () => {
    expect(out).toContain('Sends Needs approval Your project domain/policy.yaml')
    expect(out).toContain("Can't be undone Not allowed This playbook workflows/client-intake/policy.yaml")
    expect(out).toContain('Tokens 40,000 This step')
    expect(out).toContain('Platform default')
    expect(out).toContain('Plugin email')
    expect(out).toContain('Not enforced yet')
  })

  it('says so when there are no rules', () => {
    expect(text(renderToStaticMarkup(createElement(EffectivePolicyView, { rules: [] })))).toContain('No rules apply to this step.')
  })
})

describe('StepDetail', () => {
  it('renders a whole step on its own', () => {
    const out = text(renderToStaticMarkup(createElement(StepDetail, { step: samplePlaybook.steps.verify!, playbook: samplePlaybook, roles: sampleRoles })))
    expect(out).toContain('Manager approves onboarding')
    expect(out).toContain('Manager')
    expect(out).toContain('If approved → Create the customer')
    expect(out).toContain('Reminder after 1 day, goes to Needs a person after 3 days')
    expect(out).toContain('Exactly as written')
    expect(out).toContain('workflows/client-intake/steps/verify.md')
  })
})
