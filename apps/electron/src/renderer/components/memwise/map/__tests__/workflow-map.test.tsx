import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n } from '@memwise/shared/i18n/setupI18n'
import { WorkflowMap } from '../index'
import { sampleHighlightPath, sampleLiveCounts, samplePlaybook, sampleRoles } from '../../playbook/sample-playbook'

const i18n = setupI18n([initReactI18next])
// setupI18n is once per process: if another test file set it up without the React binding, bind it here.
setI18n(i18n)
i18n.changeLanguage('en')

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

describe('WorkflowMap', () => {
  it('draws every step, the end and the edges in design mode', () => {
    const html = renderToStaticMarkup(createElement(WorkflowMap, { playbook: samplePlaybook, roles: sampleRoles, onSelectState: () => {} }))
    const out = text(html)
    for (const title of ['Client fills in the intake form', "Check the client's answers", 'Manager approves onboarding', 'Create the customer', 'Needs a person', 'Finished']) {
      expect(out).toContain(title)
    }
    expect(out).toContain('needs info')
    expect(out).toContain('no answer in 7 days')
    expect((html.match(/data-edge=/g) ?? []).length).toBe(11)
    // Clickable steps are buttons; the end is not.
    expect((html.match(/<button/g) ?? []).length).toBe(5)
    expect(html).not.toContain('memwise.map.')
  })

  it('shows counts and a case path in live mode', () => {
    const html = renderToStaticMarkup(createElement(WorkflowMap, { playbook: samplePlaybook, mode: 'live', live: sampleLiveCounts, highlightPath: sampleHighlightPath }))
    expect(html).toContain('3 open runs here')
    expect(html).toContain('aria-current="step"')
    expect(text(html)).toContain('Now')
    expect(text(html)).toContain("This run's path")
    expect(html).toContain('stroke="var(--accent-raw)"')
  })
})
