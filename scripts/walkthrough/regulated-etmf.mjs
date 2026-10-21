// The regulated walkthrough (Stage 5, docs/memwise/26-projects-and-pages.md §8, §11) on the eTMF
// example, through the app's own calls and screens: three investigator CVs are filed by the AI and
// QC'd by the owner (two approved, the unsigned one sent back); CR-014 is opened on "File a TMF
// document", its QC change fails validation 2 of 3, the fix (a signature rule in the AI check)
// passes 3 of 3; the raiser signs it to QA; the MHRA inspector link is made in Project settings;
// then the change request, the audit trail (with the AI's entries) and the TMF index are shot.
//
// Needs fake-anthropic.mjs started with regulated-tools.mjs and WALKTHROUGH_INDEX set to a JSON
// file this script writes (the classifier's index for each file name), e.g.
//   WALKTHROUGH_INDEX=$dir/index.json node scripts/walkthrough/fake-anthropic.mjs 8800 \
//     scripts/walkthrough/regulated-replies.json scripts/walkthrough/regulated-tools.mjs
//   WALKTHROUGH_INDEX=$dir/index.json MEMWISE_REPO=$PWD xvfb-run -a -s "-screen 0 1440x900x24" \
//     node scripts/walkthrough/launch.mjs <configDir> <projectDir> <outDir> $PWD/scripts/walkthrough/regulated-etmf.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PASSWORD = 'walkthrough-pass-1'
const QC_PATH = 'domains/etmf/workflows/file-document/steps/qc.md'
const CLASSIFY_PATH = 'domains/etmf/workflows/file-document/steps/classify.md'
const SIGNED_RULE = 'A CV is signed and dated by the person it is about, within the last two years.'
const wait = (win, ms) => win.waitForTimeout(ms)

/** A one-page PDF with the given lines (a real file, so the document viewer shows it). */
function pdf(lines) {
  const esc = s => s.replace(/[\\()]/g, m => `\\${m}`)
  const stream = `BT /F1 12 Tf 72 740 Td 16 TL ${lines.map(l => `(${esc(l)}) Tj T*`).join(' ')} ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1').toString('base64')
}

const call = (win, fn, ...args) => win.evaluate(async ([fn, args]) => {
  const ws = new URLSearchParams(location.search).get('workspaceId')
  return window.electronAPI[fn](ws, ...args)
}, [fn, args])

const go = (win, route) => win.evaluate(r => window.dispatchEvent(new CustomEvent('memwise-navigate', { detail: { route: r }, bubbles: true })), route)

async function until(what, get, ok, ms = 90000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await get()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 800)}`)
    await new Promise(r => setTimeout(r, 1000))
  }
}

export default async ({ win, shot }) => {
  const projectDir = process.env.MEMWISE_PROJECT_DIR ?? process.argv[3]
  const indexFile = process.env.WALKTHROUGH_INDEX
  if (!indexFile) throw new Error('Set WALKTHROUGH_INDEX (the same file fake-anthropic.mjs reads).')
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }) } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 90000 })
  // Playbook steps call a model only through a connection with a key, read when the app starts:
  // the first launch gives the scripted connection a placeholder key (the fake server ignores it)
  // and stops; the next launch, on the same config folder, runs the walkthrough.
  const status = await call(win, 'memwiseStatus')
  if (!status.modelConfigured) {
    console.log('key', JSON.stringify(await win.evaluate(() => window.electronAPI.setupLlmConnection({ slug: 'walkthrough', credential: 'sk-ant-walkthrough-placeholder', updateOnly: true }))))
    console.log('Saved a placeholder key for the scripted connection. Launch again with the same config folder (and an empty postgres folder) to run the walkthrough.')
    return
  }

  // ---- the study, its sites and the CVs they owe (as the owner)
  const already = await call(win, 'memwiseQueryRecords', { entity: 'etmf.Sponsor' }).catch(() => null)
  if (already?.total) throw new Error('This walkthrough needs a fresh config folder and project.')
  await call(win, 'memwiseSetOwnPassword', { password: PASSWORD })
  const create = async (entity, values) => {
    const r = await call(win, 'memwiseCreateRecord', { entity, values, reason: 'study set-up' })
    if (!r.applied) throw new Error(`create ${entity}: ${r.message}`)
    return r.id
  }
  console.log('seeding')
  const sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' })
  const study = await create('etmf.Study', { code: 'MW-301', title: 'Aster-1 in advanced solid tumours', sponsor })
  const today = new Date().toISOString().slice(0, 10)
  const index = {}
  const files = []
  for (const [n, pi, signed] of [['101', 'Dr. Mei Chen', true], ['104', 'Dr. Jonas Weber', true], ['109', 'Dr. Claire Martin', false]]) {
    const site = await create('etmf.Site', { site_number: n, study })
    const person = await create('etmf.Person', { name: pi, role: 'Principal Investigator', site })
    await create('etmf.ExpectedDocument', { site, study, artifact: 'Protocol signature page', phase: 'start_up' })
    const expected = await create('etmf.ExpectedDocument', { site, study, artifact: 'Investigator CV', phase: 'start_up' })
    const name = `Investigator CV - site ${n}${signed ? '' : ' unsigned'}.pdf`
    index[name] = { artifact: 'Investigator CV', study, site, about: person, expected_document: expected, document_date: today, version: '1', signed }
    files.push({ name, signed, data: pdf([`Curriculum vitae: ${pi}`, `Principal Investigator, site ${n}, study MW-301`, '', signed ? `Signed: ${pi}   Date: ${today}` : 'Signature: ____________   Date: ________']) })
  }
  writeFileSync(indexFile, JSON.stringify(index, null, 2))

  console.log('index', indexFile)

  // ---- the CVs arrive; the AI classifies them; the owner QCs (signed)
  const cases = []
  for (const f of files) {
    const doc = await call(win, 'memwiseUploadFile', { name: f.name, mime: 'application/pdf', data: f.data })
    const c = await call(win, 'memwiseStartCase', { workflowId: 'file-document', values: { original: doc, sender: 'coordinator@site.example', received_at: new Date().toISOString() } })
    if (!c.caseId) throw new Error(`start ${f.name}: ${JSON.stringify(c)}`)
    cases.push({ ...f, caseId: c.caseId })
  }
  for (const c of cases) {
    const items = await until(`QC of ${c.name}`, () => call(win, 'memwiseListInbox'), xs => xs.some(i => i.caseId === c.caseId && i.stepRunId && /^QC/.test(i.stepTitle ?? '')), 120000)
    const qc = items.find(i => i.caseId === c.caseId && i.stepRunId && /^QC/.test(i.stepTitle ?? ''))
    const r = await call(win, 'memwiseSubmitStep', {
      stepRunId: qc.stepRunId, outcome: c.signed ? 'approved' : 'sent_back', signature: { password: PASSWORD },
      values: c.signed ? {} : { qc_comment: 'Not signed. Please sign and date it and send it again.' },
    })
    console.log('QC', c.name, r.applied ? 'ok' : JSON.stringify(r))
  }
  for (const c of cases) await until(`case of ${c.name} to leave QC`, () => call(win, 'memwiseGetCase', c.caseId), v => !!v && !['qc', 'file', 'classify', 'index', 'receive', 'send_to_qc'].includes(v.state))

  // ---- CR-014: the paper change log ended at CR-013
  const opened = await call(win, 'memwiseOpenChangeRequest', {
    workflowId: 'file-document', number: 14,
    title: 'Skip QC for CVs that pass every AI check',
    reason: 'QC of investigator CVs repeats the AI check and holds up site activation. CVs that fail any AI check still go to QC.',
  })
  const cr = opened.changeRequest
  console.log('CR', cr.label, cr.draftId)
  const live = p => readFileSync(join(projectDir, p), 'utf8')
  const write = (path, content, summary) => call(win, 'memwiseWriteDraft', { draftId: cr.draftId, summary, files: [{ path, content }] })
  console.log('write qc', JSON.stringify(await write(QC_PATH, live(QC_PATH).replace('title: QC and sign', 'title: QC by the TMF lead, except CVs that pass every AI check'), 'QC only for CVs the AI checks don\'t pass')))
  const first = await call(win, 'memwiseValidateChangeRequest', { crId: cr.id })
  console.log('validation 1', first.status, first.passed, '/', first.total)

  // The change request's page, with its first (failed) validation, and its chat.
  await go(win, `mw/etmf/change/${cr.label}`); await wait(win, 3500)
  await shot('01-change-failed')
  const box = win.locator('[data-testid="shell-composer"] textarea')
  if (await box.count()) {
    await box.fill('Why did validation fail?'); await box.press('Enter')
    await wait(win, 9000)
    await shot('02-change-chat')
  } else console.log('no composer on the change request page')

  // The fix the chat proposes: a signature rule in the AI check.
  console.log('write classify', JSON.stringify(await write(CLASSIFY_PATH, live(CLASSIFY_PATH).replace('checkpoint:\n', `checkpoint:\n  - ${SIGNED_RULE}\n`), 'The AI check now includes signature and date')))
  const second = await call(win, 'memwiseValidateChangeRequest', { crId: cr.id })
  console.log('validation 2', second.status, second.passed, '/', second.total)
  await go(win, 'mw/etmf'); await wait(win, 1000)
  await go(win, `mw/etmf/change/${cr.label}`); await wait(win, 3500)
  await shot('03-change-passed')
  await win.locator('[data-change-request]').first().screenshot({ path: `${process.argv[4]}/EChange.png` }).catch(e => console.log('EChange element shot', e.message))

  // Waiting for you: the raiser's sign-off.
  await go(win, 'mw/etmf/waiting'); await wait(win, 3000)
  await shot('04-waiting-signoff')

  // The raiser signs it to QA (Part 11: password and meaning).
  await go(win, `mw/etmf/change/${cr.label}`); await wait(win, 3000)
  await win.locator('[data-action="send"]').first().click(); await wait(win, 1200)
  await shot('05-sign-dialog')
  await win.locator('input[type="password"]').last().fill(PASSWORD)
  await win.getByRole('dialog').getByRole('button', { name: /send to qa|approve|sign/i }).last().click().catch(e => console.log('sign click', e.message))
  await wait(win, 4000)
  await shot('06-change-in-review')
  const after = await call(win, 'memwiseGetChangeRequest', { crId: cr.id })
  console.log('CR status', after.status, JSON.stringify(after.signoffs.map(s => [s.role, s.status])))

  // Project settings: give inspectors access.
  await go(win, 'mw/etmf/settings/inspectors'); await wait(win, 3000)
  await shot('07-inspectors')
  // With no link yet the form is open already.
  const newLink = win.locator('[data-action="new-link"]')
  if (await newLink.count()) { await newLink.click(); await wait(win, 600) }
  await win.locator('[data-field="name"]').fill('MHRA inspection')
  await win.locator('[data-field="inspectors"]').fill('GCP inspector, MHRA')
  await shot('08-inspectors-form')
  await win.locator('[data-action="create"]').click(); await wait(win, 2500)
  await shot('09-inspectors-created')

  // The audit trail, with the AI's entries.
  await go(win, 'mw/etmf/audit'); await wait(win, 3500)
  await shot('10-audit')
  const verify = win.locator('[data-action="verify"]')
  if (await verify.count()) { await verify.first().click(); await wait(win, 2500); await shot('11-audit-verified') }
  await win.locator('button[aria-pressed]').first().click(); await wait(win, 2500)
  await shot('11b-audit-people-and-ai')
  // One document's trail (the unsigned CV): the AI's entry with its model and quote, QC's signature.
  const unsigned = await call(win, 'memwiseGetCase', cases.find(c => !c.signed).caseId)
  const docId = unsigned.values?.document?.value ?? unsigned.values?.document
  if (typeof docId === 'string') {
    await go(win, `mw/etmf/audit/${encodeURIComponent(`etmf.Document:${docId}`)}`); await wait(win, 3500)
    await shot('11c-audit-document')
  } else console.log('no document on the unsigned case', JSON.stringify(unsigned.values?.document))

  // The TMF index and a zone.
  await go(win, 'mw/etmf/tmf'); await wait(win, 3500)
  await shot('12-tmf-index')
  await go(win, 'mw/etmf/tmf/site-management'); await wait(win, 3500)
  await shot('13-tmf-zone')
  console.log('URL', decodeURIComponent(win.url().split('route=')[1] ?? ''))
}
