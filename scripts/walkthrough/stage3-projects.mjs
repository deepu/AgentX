// Stage 3 walkthrough: the switcher on stored projects, Waiting for you across projects, the app home,
// Project settings, a template update reviewed and taken, and New project (a card, and described in chat).
import { readFileSync } from 'node:fs'
const wait = (win, ms) => win.waitForTimeout(ms)
const proj = (process.env.MEMWISE_REPO ?? process.cwd()) + '/examples/etmf'
export default async ({ win, shot }) => {
  const log = (...a) => console.log('STEP', ...a)
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }) } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 120000 })
  await wait(win, 8000)
  const api = (method, ...args) => win.evaluate(async ([method, args]) => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    return await window.electronAPI[method](ws, ...args)
  }, [method, args])
  const apps = await api('memwiseListApps')
  log('apps', JSON.stringify(apps.map(a => [a.id, a.projects.map(p => `${p.id}:${p.status}:${p.waiting}`)])))
  const switcher = () => win.locator('[data-testid="project-switcher"]').click().then(() => wait(win, 700))
  const side = win.locator('[data-testid="project-sidebar"]')
  const page = win.locator('[data-testid="shell-page-column"]')

  // 1. The switcher: studies under eTMF, the draft tagged, "All studies", + New project.
  await switcher()
  await shot('01-switcher')
  await win.locator('[data-testid="switch-project-mw301"]').click(); await wait(win, 4000)
  await shot('02-mw301-home')
  log('sidebar', (await side.innerText()).replace(/\s+/g, ' ').slice(0, 400))

  // 2. Project settings (mock Settings).
  await side.getByText('Project settings', { exact: true }).click(); await wait(win, 3000)
  await shot('03-settings')

  // 3. A template update: version 5 waits 5 days in Chase missing documents (MW-301 already does).
  const file = readFileSync(`${proj}/domains/etmf/workflows/chase-missing/workflow.yaml`, 'utf8')
  const v5 = file.replace('version: 1', 'version: 2').replace(/(wait_for_documents:[\s\S]*?timeout: )3d/, '$15d')
  const published = await api('memwisePublishTemplate', { appId: 'etmf', files: { 'workflows/chase-missing/workflow.yaml': v5 } })
  log('published', JSON.stringify({ version: published.version, updates: published.updates.map(u => u.project) }))
  await wait(win, 4000)
  await shot('04-settings-update-out')

  // 4. Waiting for you, all projects (mock XWaitingAll), with its chat.
  await switcher()
  await win.getByText('Waiting for you, all projects', { exact: true }).click(); await wait(win, 3500)
  const box = win.locator('[data-testid="shell-composer"] textarea')
  if (await box.count()) { await box.fill('What needs me first?'); await box.press('Enter'); await wait(win, 8000) }
  await shot('05-waiting-all')

  // 5. MW-301's review says it already does that; MW-207's is taken after a test run.
  await win.locator('[data-waiting-group="mw301"] [data-action="open-item"]').first().click(); await wait(win, 4000)
  await shot('06-review-mw301')
  log('mw301 review', (await page.innerText()).replace(/\s+/g, ' ').slice(0, 500))
  await switcher()
  await win.getByText('Waiting for you, all projects', { exact: true }).click(); await wait(win, 2500)
  await win.locator('[data-waiting-group="mw207"] [data-action="open-item"]').first().click(); await wait(win, 4000)
  await page.locator('[data-action="test"]').click().catch(e => log('no test button', e.message)); await wait(win, 12000)
  await shot('07-review-mw207-tested')
  await page.locator('[data-action="take"]').click(); await wait(win, 4000)
  await shot('08-review-mw207-taken')
  log('mw207 taken', (await page.innerText()).replace(/\s+/g, ' ').slice(0, 300))

  // 6. The app home (mock EPortfolio).
  await switcher()
  await win.locator('[data-testid="app-home-etmf"]').click(); await wait(win, 4000)
  await shot('09-app-home')
  log('app home', (await page.innerText()).replace(/\s+/g, ' ').slice(0, 500))

  // 7. New project from a card: Phase 1 leaves out Chase missing documents; then discard it.
  await switcher()
  await win.getByText('New project', { exact: true }).click(); await wait(win, 3000)
  await shot('10-new-project')
  await page.locator('[data-field="name"]').fill('Study MW-312')
  await page.locator('[data-field="study"]').fill('MW-312')
  await page.locator('[data-source="template:phase1"]').click()
  await page.locator('[data-action="create"]').click(); await wait(win, 5000)
  await shot('11-new-from-card')
  log('card draft', (await page.innerText()).replace(/\s+/g, ' ').slice(0, 500))
  await page.locator('[data-action="discard"]').click(); await wait(win, 4000)

  // 8. New project described in chat (mock NewProject): the chat drafts it, then Start study.
  await switcher()
  await win.getByText('New project', { exact: true }).click(); await wait(win, 3000)
  const chatBox = win.locator('[data-testid="shell-composer"] textarea')
  await chatBox.fill('Start Study MW-311. Same setup as MW-301, but a fresh start: Priya is the CRA again, and Tom files documents.')
  await chatBox.press('Enter'); await wait(win, 15000)
  await shot('12-new-described')
  log('described', (await page.innerText()).replace(/\s+/g, ' ').slice(0, 500))
  const start = page.locator('[data-action="start"]')
  if (await start.count()) { await start.click(); await wait(win, 6000); await shot('13-started') } else log('no draft to start')
  log('after start url', decodeURIComponent(win.url().split('route=')[1] ?? ''))

  // 9. The copied draft MW-310: its Home is its draft.
  await switcher()
  await win.locator('[data-testid="switch-project-study-mw-310"], [data-testid="switch-project-mw310"]').first().click(); await wait(win, 4000)
  await shot('14-draft-home')
  const final = await api('memwiseListApps')
  log('apps after', JSON.stringify(final.map(a => [a.id, a.projects.map(p => `${p.id}:${p.status}:v${p.templateVersion}:${p.waiting}`)])))
}
