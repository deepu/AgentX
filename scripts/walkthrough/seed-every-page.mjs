// Seeds Stage 4's walkthrough (doc 26 §11) on top of the eTMF example's own seeds (Study MW-301 and
// MW-207, made from examples/etmf/projects/*/seed.yaml when the project folder is made), through the
// app's own calls, as the owner: the owner's signing password, site 101's CRA and first reminder (it
// still owes two documents), a few more MW-301 documents in different states, "Send document
// reminders" started on site 101 in Study MW-301 (it waits for the study manager's approval), and a
// CV that arrives by "File a TMF document" (it waits for the TMF specialist's signature).

/** A small real PDF, one text line per row (Helvetica), as base64. */
export function pdfBase64(pages) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const pageIds = pages.map((_, i) => 4 + i * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  pages.forEach((lines, i) => {
    const content = `BT /F1 16 Tf 72 760 Td ${lines.map((l) => `(${esc(l)}) Tj 0 -28 Td`).join(' ')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1').toString('base64')
}

const DOCS = [
  { name: '104-protocol-signature-page.pdf', site: '104', artifact: 'Protocol signature page', status: 'in_qc', pages: [['MW-301 Protocol version 3.0', 'Investigator signature page', 'Site 104, Kliniken am Stadtpark'], ['Dr. Jonas Weber', 'Signature', '2 Oct 2026']] },
  { name: '103-lab-ranges.pdf', site: '103', artifact: 'Lab normal ranges', status: 'indexed', pages: [['Hopital Saint-Clair', 'Normal ranges, haematology', 'Valid from 1 Sep 2026']] },
  { name: '104-sub-cv.pdf', site: '104', artifact: 'Sub-investigator CVs', status: 'rejected', pages: [['Curriculum vitae', 'Dr. Anna Krause', 'Sub-investigator'], ['Unsigned']] },
  { name: '103-irb.pdf', site: '103', artifact: 'IRB approval', status: 'received', pages: [['Comite de protection des personnes', 'Avis favorable', 'MW-301']] },
]

export async function seedEveryPage(win) {
  const docs = DOCS.map((d) => ({ ...d, data: pdfBase64(d.pages) }))
  const incoming = pdfBase64([['Dr. Helen Marsh', 'Curriculum vitae', 'Principal Investigator, site 101', 'Clinical research experience'], ['H. Marsh', 'Signature', '14 Oct 2026', 'Date']])
  return await win.evaluate(async ({ docs, incoming }) => {
    const api = window.electronAPI
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const project = 'mw301'
    const out = []
    const create = async (entity, values, status) => {
      const r = await api.memwiseCreateRecord(ws, { entity, values, project, ...(status ? { status } : {}), reason: 'study set-up' })
      if (!r.applied) throw new Error(`create ${entity}: ${r.message} ${JSON.stringify(r.errors ?? {})}`)
      return r.id
    }
    // The example's own seeds come first (made when the project folder is), with EDC's sites from Rave.
    // Wait until both studies are seeded (their document counts stop moving) and Rave has been read.
    const count = async (entity, p) => (await api.memwiseQueryRecords(ws, { entity, project: p, limit: 1 }).catch(() => null))?.total ?? 0
    let last = -1
    for (let i = 0; i < 90; i++) {
      const now = (await count('etmf.Document', 'mw301')) + (await count('etmf.Document', 'mw207'))
      const ready = (await count('etmf.Site', 'mw301')) >= 12 && (await count('etmf.Site', 'mw207')) >= 6 && (await count('edc.Site', 'edc-mw301')) > 0
      if (ready && now > 0 && now === last) break
      last = now
      await new Promise((r) => setTimeout(r, 3000))
    }
    const sites = await api.memwiseQueryRecords(ws, { entity: 'etmf.Site', project, limit: 50 })
    if (!sites?.total) throw new Error('Study MW-301 has no sites: launch with MEMWISE_EXAMPLE_PROJECT_DIR and a new project folder (README.md)')
    const site = (n) => {
      const row = sites.rows.find((r) => String(r.values?.site_number ?? r.title).split(' ')[0] === n)
      if (!row) throw new Error(`no site ${n} in MW-301: ${JSON.stringify(sites.rows.map((r) => [r.title, r.values]).slice(0, 3))}`)
      return row
    }
    const study = (await api.memwiseQueryRecords(ws, { entity: 'etmf.Study', project })).rows[0]
    out.push(`MW-301: ${sites.total} sites, study "${study?.title}"`)
    const already = await api.memwiseQueryRecords(ws, { entity: 'etmf.Reminder', project }).catch(() => null)
    if (already && already.total > 0) return [...out, 'already seeded']
    // The owner signs with a password (eTMF is regulated).
    const pw = await api.memwiseSetOwnPassword(ws, { password: 'walkthrough-pass-1' }).catch((e) => ({ applied: false, message: String(e) }))
    out.push(`password: ${pw.applied ? 'set' : pw.message ?? pw.code}`)
    // Site 101 (Leeds) still owes its Investigator CV and medical licence, and had its first reminder.
    const s101 = site('101')
    const upd = await api.memwiseUpdateRecord(ws, { entity: 'etmf.Site', id: s101.id, values: { cra_name: 'Priya Shah', cra_email: 'priya.shah@northlight.example' }, reason: 'CRA assigned' })
    out.push(`101 CRA: ${upd.applied ? 'ok' : upd.message}`)
    await create('etmf.Reminder', { site: s101.id, sent_to: 'owen.price@site101.example', subject: 'MW-301: 2 documents needed', sent_at: '2026-10-09T09:00:00Z' })
    for (const d of docs) {
      const file = await api.memwiseUploadFile(ws, { name: d.name, mime: 'application/pdf', data: d.data })
      try {
        await create('etmf.Document', { file, artifact: d.artifact, study: study.id, site: site(d.site).id, version: '1', received_at: '2026-10-12T09:00:00Z' }, d.status)
        out.push(`${d.artifact} (${d.site}): ${d.status}`)
      } catch (e) {
        out.push(`${d.artifact} (${d.site}): ${e.message}`)
      }
    }
    // "Send document reminders" on site 101, in the study's own copy of the playbook.
    const started = await api.memwiseStartCase(ws, { workflowId: 'remind-site', project, values: { site: s101.id } })
    out.push(`remind-site: ${started.caseId ?? JSON.stringify(started)}`)
    // A CV arrives: "File a TMF document" files it after the TMF specialist signs (the Sign page).
    const original = await api.memwiseUploadFile(ws, { name: 'marsh-cv.pdf', mime: 'application/pdf', data: incoming })
    const filing = await api.memwiseStartCase(ws, { workflowId: 'file-document', project, values: { original, sender: 'owen.price@site101.example', received_at: '2026-10-20T08:12:00Z' } })
    out.push(`file-document: ${filing.caseId ?? JSON.stringify(filing)}`)
    return out
  }, { docs, incoming })
}
