// Stage 4 walkthrough (doc 26 §11, "Everything has a page"): the playbook, run, record list, record
// and sign pages of the eTMF project, and its two flows:
//   1. On "Chase missing documents", the chat changes the playbook ("also copy the CRA on the second
//      reminder") into a draft, runs it on site 104, and the page sends it for review.
//   2. On Sites, the chat filters the list ("which sites are still missing documents?") and the
//      filter is saved as a page.
// The chat's words and its tool calls are scripted (every-page-replies.json); the tools themselves,
// the kernel, the test run and the screens are real.
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
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 90000 })
  console.log('SEED', JSON.stringify(await seedEveryPage(win), null, 1))
  const side = win.locator('[data-testid="project-sidebar"]')
  const page = win.locator('[data-testid="shell-page-column"]')
  await wait(win, 4000)
  await win.locator('[data-testid="project-switcher"]').click(); await wait(win, 500)
  await win.locator('[data-testid="switch-project-etmf"]').click(); await wait(win, 3000)

  // The chase reaches "Approve the email" for DE-104.
  const chase = await poll(win, 'chase at approve_email', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const cs = await window.electronAPI.memwiseListCases(ws, { workflowId: 'chase-missing' })
    return cs.find((c) => c.state === 'approve_email') ?? false
  })
  console.log('CHASE', JSON.stringify(chase && { caseId: chase.caseId, state: chase.state }))

  // ---- Playbook page
  await side.getByText('Chase missing documents', { exact: false }).first().click(); await wait(win, 3500)
  await shot('01-playbook')

  // ---- Flow 1: the chat drafts the change and runs it on site 104
  await ask(win, 'Also copy the CRA on the second reminder', 4000)
  const draft = await poll(win, 'the chat\'s draft with its test run', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const ds = await window.electronAPI.memwiseListDrafts(ws)
    return ds.find((d) => d.workflowId === 'chase-missing' && d.chatId && d.testRun) ?? false
  }, undefined, 240000)
  console.log('DRAFT', JSON.stringify(draft && { id: draft.id, chatId: draft.chatId, testRun: draft.testRun, stage: draft.stage }))
  await wait(win, 6000)
  await shot('02-playbook-draft-from-chat')
  const toggle = page.locator('[data-action="toggle-draft"]')
  if (await toggle.count()) { await toggle.first().click(); await wait(win, 1500) }
  await shot('03-draft-changes-and-test-run')
  await page.locator('[data-action="send-for-review"]').first().click()
  await wait(win, 2500)
  await shot('04-sent-for-review-checking')
  const sent = await poll(win, 'the draft in review', async (id) => {
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const d = await window.electronAPI.memwiseGetDraft(ws, id)
    return d.stage === 'in_review' ? { stage: d.stage, caseId: d.caseId } : false
  }, draft?.id, 300000)
  console.log('SENT', JSON.stringify(sent))
  await wait(win, 2500)
  await shot('05-in-review')
  if (sent?.caseId) {
    // The change run waits at its review step (the review is a manager's).
    await page.locator('[data-testid="playbook-draft"] button', { hasText: /open the review/i }).first().click().catch((e) => console.log('open review', e.message))
    await wait(win, 3500)
    await shot('06-change-run-at-review')
  }

  // ---- Run page: the chase's run, its waiting step answered in place
  await side.getByText('Chase missing documents', { exact: false }).first().click(); await wait(win, 2500)
  const run = page.locator(chase ? `[data-run="${chase.caseId}"]` : '[data-run]').first()
  if (await run.count()) await run.click(); else console.log('no run row')
  await wait(win, 3500)
  await shot('07-run')

  // ---- Sites: List, then Flow 2
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3500)
  await shot('08-sites')
  await ask(win, 'Which sites are still missing documents?', 10000)
  await win.waitForSelector('[data-testid="chat-filter"]', { timeout: 30000 }).catch(() => console.log('no chat filter shown'))
  await wait(win, 2000)
  await shot('09-sites-filtered-by-chat')
  await page.locator('[data-action="save-as-page"]').first().click().catch((e) => console.log('save', e.message))
  await wait(win, 4000)
  await shot('10-saved-as-page')

  // ---- Documents: Cards, drags
  await side.getByText('Documents', { exact: true }).click(); await wait(win, 3500)
  await page.locator('[data-layout="cards"]').click().catch(() => {}); await wait(win, 2500)
  await shot('11-documents-cards')
  const col = (s) => page.locator(`[data-column="${s}"]`)
  const card = (s, text) => (text ? col(s).locator('[data-card]', { hasText: text }) : col(s).locator('[data-card]')).first()
  // Only a playbook step sends a document to QC: refused, with the reason.
  if (await card('indexed').count()) { await drag(win, card('indexed'), col('in_qc')); await wait(win, 1500); await shot('12-drag-refused') }
  // A TMF specialist may re-index a rejected document: in a regulated project it asks for the reason.
  if (await card('rejected').count()) {
    await drag(win, card('rejected'), col('indexed')); await wait(win, 1500)
    await shot('13-drag-asks-reason')
    const reason = page.locator('[data-testid="records-board"] input').first()
    if (await reason.count()) {
      await reason.fill('The site sent a signed copy')
      await page.getByRole('button', { name: 'Save with reason' }).first().click().catch((e) => console.log('confirm', e.message))
      await wait(win, 3000)
      await shot('14-drag-moved')
    }
  }
  // Filing is signed: dropping the CV on Filed opens the step that signs it (the Sign page).
  if (await card('in_qc', 'Investigator CV').count()) {
    await drag(win, card('in_qc', 'Investigator CV'), col('filed')); await wait(win, 5000)
    await shot('15-sign')
    await page.locator('[data-signature-password]').fill('walkthrough-pass-1').catch((e) => console.log('password', e.message))
    await page.locator('[data-action="sign"]').click().catch((e) => console.log('sign', e.message))
    await wait(win, 6000)
    await shot('16-signed')
  } else console.log('no Investigator CV in QC')

  // ---- Record pages
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3000)
  await page.locator('[data-action="clear-chat-filter"]').first().click().catch(() => {}); await wait(win, 1500)
  await page.getByText('DE-104', { exact: false }).first().click(); await wait(win, 4000)
  await shot('17-site')
  await side.getByText('Documents', { exact: true }).click(); await wait(win, 2500)
  await page.locator('[data-layout="list"]').click().catch(() => {}); await wait(win, 1500)
  await page.getByText('GCP certificates', { exact: false }).first().click(); await wait(win, 5000)
  await shot('18-document')
  await side.getByText('Waiting for you', { exact: true }).click(); await wait(win, 2500)
  await shot('19-waiting')
}
