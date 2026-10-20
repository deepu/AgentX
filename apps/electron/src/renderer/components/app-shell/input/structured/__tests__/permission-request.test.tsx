import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n } from '@memwise/shared/i18n/setupI18n'

// The UI kit pulls in the PDF block: pdf.js needs a browser and its worker is a Vite asset.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { PermissionRequest } = await import('../PermissionRequest')

const i18n = setupI18n([initReactI18next])
setI18n(i18n)
i18n.changeLanguage('en')

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const render = (request: Parameters<typeof PermissionRequest>[0]['request']) =>
  text(renderToStaticMarkup(createElement(PermissionRequest, { request, onResponse: () => {} })))

describe('PermissionRequest', () => {
  it('shows a playbook tool by its plain label, not its tool name', () => {
    const out = render({ sessionId: 's1', requestId: 'r1', toolName: 'mcp__session__playbook_finish', description: 'Send the draft for review', type: 'mcp_mutation' })
    expect(out).toContain('Send the draft for review')
    expect(out).not.toContain('mcp__session__playbook_finish')
    expect(out.match(/Send the draft for review/g)).toHaveLength(1)
  })

  it('does not repeat the raw name when the prompt carries it as the command', () => {
    const out = render({ sessionId: 's1', requestId: 'r2', toolName: 'mcp__session__playbook_finish', description: 'MCP: session/playbook_finish', command: 'mcp__session__playbook_finish', type: 'mcp_mutation' })
    expect(out).toContain('Send the draft for review')
    expect(out).not.toContain('mcp__session__playbook_finish')
  })

  it('keeps the tool name and command for other tools', () => {
    const out = render({ sessionId: 's1', requestId: 'r3', toolName: 'mcp__linear__createIssue', description: 'MCP: linear/createIssue', command: 'mcp__linear__createIssue', type: 'mcp_mutation' })
    expect(out).toContain('mcp__linear__createIssue')
    expect(out).toContain('MCP: linear/createIssue')
  })
})
