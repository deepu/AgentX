// Stage 4 walkthrough (doc 26 §11, "Everything has a page"): the playbook, run, record list, record
// and sign pages inside a study (Stage 3's shell), each holding that study's records, runs and
// waiting items only, and the two flows:
//   1. In Study MW-301, on "Send document reminders", the chat changes the study's own copy of the
//      playbook ("also copy the CRA on the second reminder") into a draft, runs it on site 101, and
//      the page sends it for review.
//   2. On MW-301's Sites, the chat filters the list ("which sites are still missing documents?") and
//      the filter is saved as a page in the study.
// Then the sidebar's counts in EDC's Study MW-207 (6 sites, 1 study) and eTMF's Study MW-207.
// The chat's words and its tool calls are scripted (every-page-replies.json); the tools themselves,
// the kernel, the test run and the screens are real. Needs the eTMF example's seeds and the fake Rave
// (README.md).
import { seedEveryPage } from './seed-every-page.mjs'

const wait = (win, ms) => win.waitForTimeout(ms)

async function poll(win, what, fn, arg, ms = 90000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await win.evaluate(fn, arg).catch((e) => ({ error: String(e) }))
    if (v && !v.error && v !== false) return v
    if (Date.now() > end) { console.log('TIMEOUT', what, JSON.stringify(v)); return null }
    await wait(win, 1500)
  }
}

async function ask(win, text, settle = 12000) {
  const box = win.locator('[data-testid="shell-composer"] textarea')
  await box.fill(text)
  await box.press('Enter')
  await wait(win, settle)
}

async function drag(win, from, to) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) { console.log('drag: no box'); return }
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await win.mouse.down()
  await win.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 4, { steps: 4 })
  await win.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 12 })
  await wait(win, 300)
  await win.mouse.up()
}

export default async ({ win, shot }) => {
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }) } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 120000 })
  console.log('SEED', JSON.stringify(await seedEveryPage(win), null, 1))
  const side = win.locator('[data-testid="project-sidebar"]')
  const page = win.locator('[data-testid="shell-page-column"]')
  const switcher = () => win.locator('[data-testid="project-switcher"]').click().then(() => wait(win, 700))
  const toProject = async (id) => { await switcher(); await win.locator(`[data-testid="switch-project-${id}"]`).click(); await wait(win, 4000) }
  await wait(win, 3000)
  // ---- The switcher: eTMF's studies and EDC's; into Study MW-301.
  await switcher()
  await shot('01-switcher')
  await win.locator('[data-testid="switch-project-mw301"]').click(); await wait(win, 4000)

  // "Send document reminders" on site 101 reaches "Approve the email".
  const chase = await poll(win, 'reminder at approve_email', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const cs = await window.electronAPI.memwiseListCases(ws, { workflowId: 'remind-site' })
    return cs.find((c) => c.state === 'approve_email') ?? false
  })
  console.log('CHASE', JSON.stringify(chase && { caseId: chase.caseId, state: chase.state, project: chase.project }))

  // ---- Playbook page: Study MW-301's own copy (the sidebar lists four playbooks, then "N more")
  const openPlaybook = async () => {
    const more = side.getByText(/^\d+ more$/)
    if (await more.count()) { await more.first().click(); await wait(win, 800) }
    await side.getByText('Send document reminders', { exact: false }).first().click()
  }
  await openPlaybook(); await wait(win, 3500)
  await shot('02-playbook')

  // ---- Flow 1: the chat drafts the study's copy and runs it on site 101
  await ask(win, 'Also copy the CRA on the second reminder', 4000)
  const draft = await poll(win, 'the chat\'s draft with its test run', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const ds = await window.electronAPI.memwiseListDrafts(ws)
    return ds.find((d) => d.workflowId === 'remind-site' && d.chatId && d.testRun) ?? false
  }, undefined, 240000)
  console.log('DRAFT', JSON.stringify(draft && { id: draft.id, chatId: draft.chatId, project: draft.project, testRun: draft.testRun, stage: draft.stage }))
  await wait(win, 6000)
  await shot('03-playbook-draft-from-chat')
  const toggle = page.locator('[data-action="toggle-draft"]')
  if (await toggle.count()) { await toggle.first().click(); await wait(win, 1500) }
  await shot('04-draft-changes-and-test-run')
  await page.locator('[data-action="send-for-review"]').first().click()
  await wait(win, 2500)
  await shot('05-sent-for-review-checking')
  const sent = await poll(win, 'the draft in review', async (id) => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const d = await window.electronAPI.memwiseGetDraft(ws, id)
    return d.stage === 'in_review' ? { stage: d.stage, caseId: d.caseId, files: d.files?.map((f) => f.writesTo ?? f.path) } : false
  }, draft?.id, 300000)
  console.log('SENT', JSON.stringify(sent))
  await wait(win, 2500)
  await shot('06-in-review')
  if (sent?.caseId) {
    // The change run waits at its review step (the review is a manager's).
    await page.locator('[data-testid="playbook-draft"] button', { hasText: /open the review/i }).first().click().catch((e) => console.log('open review', e.message))
    await wait(win, 3500)
    await shot('07-change-run-at-review')
  }

  // ---- Run page: the reminder's run, its waiting step answered in place
  await openPlaybook(); await wait(win, 2500)
  const run = page.locator(chase ? `[data-run="${chase.caseId}"]` : '[data-run]').first()
  if (await run.count()) await run.click(); else console.log('no run row')
  await wait(win, 3500)
  await shot('08-run')

  // ---- Sites: MW-301's own (the sidebar counts are the study's), then Flow 2
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3500)
  await shot('09-sites-mw301')
  console.log('SIDEBAR mw301', JSON.stringify(await side.innerText()))
  await ask(win, 'Which sites are still missing documents?', 10000)
  await win.waitForSelector('[data-testid="chat-filter"]', { timeout: 30000 }).catch(() => console.log('no chat filter shown'))
  await wait(win, 2000)
  await shot('10-sites-filtered-by-chat')
  await page.locator('[data-action="save-as-page"]').first().click().catch((e) => console.log('save', e.message))
  // A kept Stage 2 page opens in the study, its records block live.
  await win.waitForFunction(() => /[/=]page[/]/.test(decodeURIComponent(location.href)) || !!document.querySelector('[data-block="records"], [data-records-block]'), null, { timeout: 20000 }).catch(() => console.log('no page opened'))
  await wait(win, 3000)
  console.log('PAGE', JSON.stringify(await win.evaluate(() => { const t = document.body.innerText; return { url: location.href.split('#').pop(), rows: [...document.querySelectorAll('[data-testid="shell-page-column"] tbody tr')].map((r) => r.innerText.split('\t')[0]) } })))
  await shot('11-saved-as-page')

  // ---- Studies: one, with Rave's title
  await side.getByText('Studies', { exact: true }).click(); await wait(win, 3000)
  await shot('12-studies-mw301')
  await page.getByText('meriglutide', { exact: false }).first().click().catch((e) => console.log('study', e.message)); await wait(win, 3500)
  await shot('13-study-mw301-title-from-rave')

  // ---- Documents: Cards, drags
  await side.getByText('Documents', { exact: true }).click(); await wait(win, 3500)
  await page.locator('[data-layout="cards"]').click().catch(() => {}); await wait(win, 2500)
  await shot('14-documents-cards')
  const col = (s) => page.locator(`[data-column="${s}"]`)
  const card = (s, text) => (text ? col(s).locator('[data-card]', { hasText: text }) : col(s).locator('[data-card]')).first()
  // Only a playbook step sends a document to QC: refused, with the reason.
  if (await card('indexed').count()) { await drag(win, card('indexed'), col('in_qc')); await wait(win, 1500); await shot('15-drag-refused') }
  // A TMF specialist may re-index a rejected document: in a regulated project it asks for the reason.
  if (await card('rejected').count()) {
    await drag(win, card('rejected'), col('indexed')); await wait(win, 1500)
    await shot('16-drag-asks-reason')
    const reason = page.locator('[data-testid="records-board"] input').first()
    if (await reason.count()) {
      await reason.fill('The site sent a signed copy')
      await page.getByRole('button', { name: 'Save with reason' }).first().click().catch((e) => console.log('confirm', e.message))
      await wait(win, 3000)
      await shot('17-drag-moved')
    }
  }
  // Filing is signed: dropping a document in QC on Filed opens the step that signs it (the Sign page).
  const inQc = card('in_qc', 'Investigator CV')
  if (await inQc.count()) {
    await drag(win, inQc, col('filed')); await wait(win, 5000)
    await shot('18-sign')
    await page.locator('[data-signature-password]').fill('walkthrough-pass-1').catch((e) => console.log('password', e.message))
    await page.locator('[data-action="sign"]').click().catch((e) => console.log('sign', e.message))
    await wait(win, 6000)
    await shot('19-signed')
  } else console.log('no document in QC')

  // ---- Record pages
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3000)
  await page.locator('[data-action="clear-chat-filter"]').first().click().catch(() => {}); await wait(win, 1500)
  await page.getByText('Northgate', { exact: false }).first().click().catch((e) => console.log('site 101', e.message)); await wait(win, 4000)
  await shot('20-site')
  await side.getByText('Documents', { exact: true }).click(); await wait(win, 2500)
  await page.locator('[data-layout="list"]').click().catch(() => {}); await wait(win, 1500)
  await page.getByText('Lab normal ranges', { exact: false }).first().click().catch((e) => console.log('document', e.message)); await wait(win, 5000)
  await shot('21-document')
  await side.getByText('Waiting for you', { exact: true }).click(); await wait(win, 2500)
  await shot('22-waiting')

  // ---- The other study: eTMF's MW-207, then EDC's MW-207 (its 6 sites and 1 study, not both studies')
  await toProject('mw207')
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3500)
  console.log('SIDEBAR mw207', JSON.stringify(await side.innerText()))
  await shot('23-etmf-mw207-sites')
  await poll(win, 'EDC sites from Rave', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const r = await window.electronAPI.memwiseQueryRecords(ws, { entity: 'edc.Site', project: 'edc-mw207', limit: 1 }).catch(() => null)
    return r && r.total > 0 ? r.total : false
  }, undefined, 120000)
  await toProject('edc-mw207')
  await wait(win, 2000)
  console.log('SIDEBAR edc-mw207', JSON.stringify(await side.innerText()))
  await shot('24-edc-mw207-home')
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3500)
  await shot('25-edc-mw207-sites')
}
