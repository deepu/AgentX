/**
 * Stage 3 screens (doc 26 §3) rendered with the real English strings: the app home, Waiting for
 * you across projects, New project (form and draft), Project settings and a template update's
 * review; and the shell's model once projects are stored (a firm's project running two apps
 * counted once, the default domain's own project hidden, records scoped to the project), the new
 * routes, and the helpers the screens share.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import type {
  MwApp, MwAppHome, MwDomain, MwInboxItem, MwProjectDetail, MwTemplateUpdateItem, MwTemplateUpdateReview, MwWaitingGroup,
} from '@memwise/shared/protocol'
import { inboxItemProject } from '@memwise/shared/protocol'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { AppHomeView } = await import('../projects/AppHomeView')
const { WaitingAllView } = await import('../projects/WaitingAllView')
const { NewProjectView } = await import('../projects/NewProjectView')
const { ProjectSettingsView } = await import('../projects/ProjectSettingsView')
const { TemplateUpdateView } = await import('../projects/TemplateUpdateView')
const { draftLists, parseUpdateItemId, peopleLine, slugOf, sortGroups, templateLine } = await import('../projects/project-model')
const { waitingTotal } = await import('@/hooks/useMemwiseProjects')
const { caseProject, projectPlaybooks, projectRecordScope, storedShellApps, storedShellProjects } = await import('../project/project-model')
const { parseProjectSegments, projectRoute } = await import('../../../../shared/project-route')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const t = i18n.t.bind(i18n) as unknown as import('i18next').TFunction
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

// ---------------------------------------------------------------- fixtures

const summary = (id: string, extra: Partial<MwApp['projects'][number]> = {}): MwApp['projects'][number] => ({
  id, app: 'etmf', apps: ['etmf'], appTitle: 'eTMF', name: `Study ${id.toUpperCase()}`, status: 'active', templateVersion: 4, appVersion: 4, waiting: 0, ...extra,
})

const etmf: MwApp = {
  id: 'etmf', title: 'eTMF', version: 5, nouns: { one: 'study', many: 'studies' }, home: { title: 'TMF across studies', link: 'All studies' },
  templates: [{ id: 'phase3', title: 'Phase 3 study', description: 'Many sites, visits' }, { id: 'phase1', title: 'Phase 1 study', description: 'One site, volunteers', without: ['workflows/chase-missing'] }],
  projects: [
    summary('mw301', { study: 'MW-301', waiting: 3, update: { to: 5 } }),
    summary('mw207', { study: 'MW-207', waiting: 5 }),
    summary('mw310', { study: 'MW-310', status: 'draft', from: { project: 'mw301' } }),
  ],
  canCreate: true,
}

const home: MwAppHome = {
  app: 'etmf', title: 'TMF across studies', link: 'All studies', nouns: { one: 'study', many: 'studies' },
  columns: [{ label: 'Phase' }, { label: 'Sites', format: 'number' }, { label: 'Filed', format: 'percent' }],
  rows: [
    { project: 'mw301', name: 'Study MW-301', study: 'MW-301', status: 'active', values: [3, 12, 96], next: { label: 'Inspection', date: '2026-11-16' }, waiting: 3 },
    { project: 'mw310', name: 'Study MW-310', study: 'MW-310', status: 'draft', values: [3, null, null], next: { label: 'First site', date: '2027-01-15' }, waiting: 0 },
  ],
  totals: { projects: 2, active: 1, draft: 1, archived: 0 },
  headline: { label: 'Filed', value: 96 },
  milestones: [{ project: 'mw301', name: 'Study MW-301', label: 'Inspection', date: '2026-11-16' }],
  bottlenecks: [{ personId: 'tom', name: 'Tom Okafor', roles: ['TMF lead'], waiting: [{ project: 'mw301', projectName: 'MW-301', count: 8 }, { project: 'mw207', projectName: 'MW-207', count: 61 }], total: 69 }],
}

const input = (id: string, project: string, step: string, caseTitle: string, extra: Record<string, unknown> = {}): MwInboxItem => ({
  kind: 'input', id, runId: `r-${id}`, caseId: `c-${id}`, stepRunId: `s-${id}`, caseTitle, workflowId: 'review-visit', stepTitle: step, fields: [], since: '2026-10-14T09:00:00Z', project, ...extra,
} as unknown as MwInboxItem)

const update: MwTemplateUpdateItem = {
  kind: 'template-update', id: 'template-update:mw301:5', project: 'mw301', projectName: 'Study MW-301', app: 'etmf', appTitle: 'eTMF', from: 4, to: 5, title: 'Review the eTMF template, version 5', since: '2026-10-20T09:00:00Z',
}

const groups: MwWaitingGroup[] = [
  { project: 'lit', projectName: 'Literature search', app: 'literature', appTitle: 'Literature search', items: [input('l1', 'lit', 'Review an answer change', 'Weight loss')], updates: [] },
  {
    project: 'mw301', projectName: 'Study MW-301', app: 'etmf', appTitle: 'eTMF', updates: [update],
    items: [
      input('a', 'mw301', 'Sign the monitoring visit report', 'Site 101 · visit on 14 Oct', { dueAt: '2026-10-22T17:00:00Z' }),
      input('b', 'mw301', 'Approve a reminder email', 'Site 104 · 4 documents missing'),
    ],
  },
  { project: 'empty', projectName: 'Nothing', app: 'etmf', appTitle: 'eTMF', items: [], updates: [] },
]

const detail = (extra: Partial<MwProjectDetail> = {}): MwProjectDetail => ({
  ...summary('mw301', { study: 'MW-301', update: { to: 5 }, from: { template: 'phase3', version: 4 } }),
  people: [
    { email: 'anika@x.example', name: 'Anika Rao', roles: ['study_manager'], note: 'owner' },
    { email: 'priya@x.example', name: 'Priya Shah', roles: ['cra'], note: 'writes visit reports' },
  ],
  connections: [
    { id: 'storage', title: 'Study TMF storage', bound: 'project' },
    { id: 'vault', title: 'Veeva Vault', access: 'read', bound: 'app' },
  ],
  settings: { phase: 3, next_milestone: { label: 'Inspection', date: '2026-11-16' } },
  without: ['pages/safety-literature'],
  templateTitle: 'Phase 3 study',
  overrides: [{ path: 'workflows/chase-missing/workflow.yaml', workflow: 'chase-missing', title: 'Chase missing documents' }, { path: 'workflows/file-document/steps/check.md', workflow: 'file-document', title: 'File a document' }],
  playbooks: ['File a document', 'Chase missing documents', 'Review a visit report', 'Prepare a site visit', 'Close a site'].map((title, i) => ({ id: `w${i}`, title, version: 1, overridden: i < 2 })),
  pages: [{ id: 'tmf-by-site', title: 'TMF by site' }, { id: 'visits', title: 'Monitoring visits' }],
  recordTypes: [{ entity: 'etmf.Site', name: 'Site' }, { entity: 'etmf.Document', name: 'Document' }],
  canEdit: true,
  ...extra,
})

const roles = [{ id: 'study_manager', title: 'Study manager' }, { id: 'cra', title: 'CRA' }]

// ---------------------------------------------------------------- screens

describe('app home', () => {
  test('tiles, one row per study with its columns and next, and who is the bottleneck', () => {
    const html = render(<AppHomeView home={home} appTitle="eTMF" onOpenProject={() => {}} />)
    const words = text(html)
    expect(words).toContain('eTMF › All studies')
    expect(words).toContain('TMF across studies')
    expect(words).toContain('1 running, 1 draft')
    expect(words).toContain('96%')
    expect(words).toContain('Inspection')
    expect(html).toContain('data-project="mw301"')
    expect(html).toContain('data-status="draft"')
    // A draft has nothing to count yet, and its next is marked as a draft's.
    expect(words).toContain('n/a')
    expect(words).toMatch(/Draft · First site (15 Jan|Jan 15)/)
    expect(words).toContain('8 in MW-301 · 61 in MW-207')
  })
})

describe('Waiting for you, all projects', () => {
  test('groups most-waiting first, two rows each, then "N more in"; a template update sits in its project', () => {
    const html = render(<WaitingAllView groups={groups} playbookTitle={() => 'Review a visit report'} onOpenProject={() => {}} onOpenItem={() => {}} onReviewUpdate={() => {}} />)
    const words = text(html)
    expect(words).toContain('4 things across your projects, grouped by project')
    expect(html.indexOf('data-waiting-group="mw301"')).toBeLessThan(html.indexOf('data-waiting-group="lit"'))
    expect(html).not.toContain('data-waiting-group="empty"')
    expect(words).toContain('eTMF · Study MW-301 3')
    expect(words).toContain('Review the eTMF template, version 5')
    expect(words).toContain('Sign the monitoring visit report')
    expect(words).not.toContain('Approve a reminder email')
    expect(words).toContain('1 more in Study MW-301')
    expect(words).toContain('From Review a visit report')
    expect(words).toContain('Open project')
  })

  test('nothing waiting', () => {
    expect(text(render(<WaitingAllView groups={[]} />))).toContain('Nothing is waiting for you.')
  })
})

describe('New project', () => {
  test('the form: name, study, and start from a template, a copy of a study, or blank', () => {
    const html = render(<NewProjectView app={etmf} onCreate={() => {}} onDescribe={() => {}} />)
    const words = text(html)
    expect(words).toContain('eTMF › New study')
    expect(html).toContain('data-source="template:phase3"')
    expect(html).toContain('data-selected="true" data-source="template:phase3"')
    expect(words).toContain('Copy a study')
    expect(words).toContain('Start from MW-301')
    expect(words).toContain('Describe it')
    expect(words).toContain('Nothing runs until you start it.')
    // No name yet: nothing to make.
    expect(html).toMatch(/data-action="create"[^>]*disabled|disabled=""[^>]*data-action="create"/)
  })

  test('the draft: pages with what it leaves out struck, playbooks, records, people; Discard and Start', () => {
    const draft = detail({ id: 'mw310', name: 'Study MW-310', status: 'draft', from: { project: 'mw301' } })
    const html = render(<NewProjectView app={etmf} draft={draft} roleTitle={id => roles.find(r => r.id === id)?.title ?? id} onDiscard={() => {}} onStart={() => {}} />)
    const words = text(html)
    expect(words).toContain('Study MW-310')
    expect(words).toContain('Draft')
    expect(html).toMatch(/data-left-out[^>]*>Safety literature</)
    expect(words).toContain('Pages 2')
    expect(words).toContain('Playbooks 5')
    expect(words).toContain('2 more')
    expect(words).toContain('Site Document')
    expect(words).toContain('Anika Rao, study manager · Priya Shah, CRA')
    expect(html).toContain('data-action="start"')
    expect(words).toContain('Start study')
    expect(html).toContain('data-selected="true" data-source="copy"')
    expect(words).toContain('Start from MW-301')
  })
})

describe('Project settings', () => {
  test('template line and the update to review, people with roles here, connections, settings, actions', () => {
    const html = render(<ProjectSettingsView project={detail()} roles={roles} onReviewUpdate={() => {}} onChangePeople={() => {}} onArchive={() => {}} onSaveAsTemplate={() => {}} />)
    const words = text(html)
    expect(words).toContain('Started from Phase 3 study, version 4 · this project changed 2 playbooks')
    expect(words).toContain('Version 5 is out')
    expect(html).toContain('data-action="review-update"')
    expect(words).toContain('Study manager · owner')
    expect(words).toContain('CRA · writes visit reports')
    expect(words).toContain('Veeva Vault · read only · the app\'s')
    expect(html).toContain('data-bound="project"')
    expect(words).toContain('Inspection · 2026-11-16')
    expect(html).toContain('data-action="archive"')
    expect(html).toContain('data-action="save-template"')
    expect(html).not.toContain('data-action="start"')
    expect(html).toContain('data-add-person')
  })

  test('a firm project running two apps says so; someone who cannot edit gets no buttons', () => {
    const html = render(<ProjectSettingsView project={detail({ apps: ['etmf', 'edc'], canEdit: false })} appTitle={id => (id === 'edc' ? 'EDC' : id)} />)
    expect(text(html)).toContain('Also runs EDC')
    expect(html).not.toContain('data-actions')
    expect(html).not.toContain('data-add-person')
  })
})

describe('template update', () => {
  const review: MwTemplateUpdateReview = {
    item: update,
    changes: [
      { path: 'workflows/chase-missing/workflow.yaml', kind: 'changed', workflow: 'chase-missing', project: 'overridden-same', title: 'Chase missing documents', note: '' },
      { path: 'workflows/file-document/steps/check.md', kind: 'changed', workflow: 'file-document', project: 'takes', title: 'File a document', note: '' },
    ],
    nothingChanges: false,
    summary: '',
    test: { workflowId: 'file-document', title: 'Ethics approval letter, site 109', status: 'same', differences: [], examples: { passed: 3, total: 3 } },
  }

  test('what each change means here, the test run, Take and Skip', () => {
    const html = render(<TemplateUpdateView review={review} onTake={() => {}} onSkip={() => {}} onTest={() => {}} />)
    const words = text(html)
    expect(words).toContain('eTMF template, version 5')
    expect(words).toContain('This project already does that, so nothing changes here')
    expect(words).toContain('Taking the update brings this in')
    expect(words).toContain('Ethics approval letter, site 109 ran the same on the new version')
    expect(words).toContain('3 of 3 examples pass')
    expect(words).toContain('Take version 5')
    expect(words).toContain('Skip this version')
  })

  test('taken: the version it is on now, and the way back to the project', () => {
    const html = render(<TemplateUpdateView review={{ ...review, test: undefined }} taken={{ version: 5, removed: ['workflows/chase-missing/workflow.yaml'] }} onOpenProject={() => {}} />)
    const words = text(html)
    expect(words).toContain('Now on version 5. 1 of its own changes now matches the template and goes.')
    expect(html).not.toContain('data-action="take"')
    expect(html).toContain('data-action="open-project"')
  })
})

// ---------------------------------------------------------------- the shell with stored projects

describe('the shell, projects stored', () => {
  const firm = (id: string, apps: string[], waiting: number): MwApp['projects'][number] => ({ ...summary(id, { app: apps[0]!, apps, appTitle: apps[0]!.toUpperCase(), name: id, waiting }) })
  const gst: MwApp = { ...etmf, id: 'gst', title: 'GST', home: undefined, templates: [], projects: [firm('firm', ['gst', 'itr'], 4)] }
  const itr: MwApp = { ...etmf, id: 'itr', title: 'Income tax', home: undefined, templates: [], projects: [firm('firm', ['gst', 'itr'], 4)], canCreate: false }
  const main: MwApp = { ...etmf, id: 'domain', title: 'Main', home: undefined, templates: [], projects: [summary('domain', { app: 'domain', apps: ['domain'], implicit: true, name: 'Main' })], canCreate: false }
  const domains = [{ id: 'domain', name: 'Main', regulated: false, workflows: [], entities: [], pages: [] }, { id: 'gst', name: 'GST', regulated: true, workflows: [], entities: [], pages: [] }] as unknown as MwDomain[]

  test("a firm's one project runs two apps: listed once, under both apps, counted once", () => {
    const projects = storedShellProjects([gst, itr, main], domains, 'Northlight')
    expect(projects.map(p => p.id)).toEqual(['firm'])
    expect(projects[0]).toMatchObject({ domain: 'gst', apps: ['gst', 'itr'], stored: true, regulated: true, waiting: 4 })
    const apps = storedShellApps([gst, itr, main], projects)
    expect(apps.map(a => [a.id, a.projects.map(p => p.id)])).toEqual([['gst', ['firm']], ['itr', ['firm']]])
    expect(waitingTotal([gst, itr])).toBe(4)
    expect(projectRecordScope(projects[0]!)).toEqual({ domain: 'gst', project: 'firm' })
    expect(projectPlaybooks(projects[0]!, [{ id: 'gst-return', domain: 'gst' }, { id: 'itr-return', domain: 'itr' }, { id: 'other', domain: 'x' }] as never).map(p => p.id)).toEqual(['gst-return', 'itr-return'])
  })

  test('the default domain shows only alone; archived studies go last; drafts keep their status', () => {
    expect(storedShellProjects([main], domains, 'Northlight').map(p => [p.id, p.name])).toEqual([['domain', 'Northlight']])
    const app = { ...etmf, projects: [summary('old', { status: 'archived' }), ...etmf.projects] }
    const projects = storedShellProjects([app], domains)
    expect(projects.map(p => p.id)).toEqual(['mw301', 'mw207', 'mw310', 'old'])
    expect(projects.find(p => p.id === 'mw310')?.status).toBe('draft')
    expect(projects.find(p => p.id === 'mw301')?.update).toEqual({ to: 5 })
  })

  test("an item or a run says its project; Stage 1's domain answer stays the fallback", () => {
    const lookups = { workflowDomain: () => 'etmf', entityDomain: () => 'etmf' }
    expect(inboxItemProject(input('x', 'mw207', 's', 'c'), lookups)).toBe('mw207')
    expect(inboxItemProject({ ...input('x', 'mw207', 's', 'c'), project: undefined } as MwInboxItem, lookups)).toBe('etmf')
    expect(caseProject({ project: 'mw301', domain: 'etmf' })).toBe('mw301')
    expect(caseProject({ domain: 'etmf' })).toBe('etmf')
  })

  test('routes: the app home and New project under all projects, a template update in its project', () => {
    for (const details of [{ type: 'app', appId: 'etmf' }, { type: 'new', appId: 'etmf' }] as const) {
      const route = projectRoute('*', details)
      expect(parseProjectSegments(route.split('/'))).toEqual({ projectId: '*', details })
    }
    const route = projectRoute('mw301', { type: 'update', itemId: 'template-update:mw301:5' })
    expect(route).toBe('mw/mw301/update/template-update%3Amw301%3A5')
    expect(parseProjectSegments(route.split('/'))).toEqual({ projectId: 'mw301', details: { type: 'update', itemId: 'template-update:mw301:5' } })
  })
})

describe('helpers', () => {
  test('template line, draft lists, people line, update ids, slugs, group order', () => {
    expect(templateLine(detail({ from: { project: 'mw301' }, overrides: [] }), t)).toBe('Copied from mw301, version 4')
    expect(templateLine(detail({ templateTitle: undefined, from: { blank: true }, overrides: [] }), t)).toBe('Started blank, version 4')
    expect(draftLists(detail({ without: ['pages/safety-literature', 'workflows/chase-missing'] }))).toMatchObject({ pagesLeftOut: ['Safety literature'], playbooksLeftOut: ['Chase missing'], records: ['Site', 'Document'] })
    expect(peopleLine([{ email: 'a@x', roles: ['cra'] }], () => 'CRA')).toBe('a@x, CRA')
    expect(parseUpdateItemId('template-update:mw301:5')).toEqual({ projectId: 'mw301', to: 5 })
    expect(parseUpdateItemId('approval:1')).toBeUndefined()
    expect(slugOf('Study MW-310')).toBe('study-mw-310')
    expect(sortGroups(groups).map(g => g.project)).toEqual(['mw301', 'lit'])
  })
})
