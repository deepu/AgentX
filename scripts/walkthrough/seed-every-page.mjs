// Seeds the eTMF example for Stage 4's walkthrough (doc 26 §11), through the app's own calls, as the
// owner: a study with three sites in EDC and eTMF, their coordinators and CRAs, their expected
// documents (DE-104 still owes three and had its first reminder), a few TMF documents in different
// states, and a document that arrives by "File a TMF document". DE-104 then moves to Activating, which
// starts "Chase missing documents" for it.

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
  { name: 'de104-protocol-signature-page.pdf', site: 'DE-104', artifact: 'Protocol signature page', status: 'in_qc', pages: [['MW-301 Protocol version 3.0', 'Investigator signature page', 'Site DE-104, Charite Studienzentrum'], ['Dr. Jonas Weber', 'Signature', '2 Oct 2026']] },
  { name: 'fr201-lab-ranges.pdf', site: 'FR-201', artifact: 'Lab normal ranges', status: 'indexed', pages: [['Laboratoire Leon Berard', 'Normal ranges, haematology', 'Valid from 1 Sep 2026']] },
  { name: 'us012-gcp.pdf', site: 'US-012', artifact: 'GCP certificates', status: 'filed', pages: [['GCP certificate', 'Dr. Mei Chen', 'Completed 12 Jan 2026']] },
  { name: 'de104-sub-cv.pdf', site: 'DE-104', artifact: 'Sub-investigator CVs', status: 'rejected', pages: [['Curriculum vitae', 'Dr. Anna Krause', 'Sub-investigator'], ['Unsigned']] },
  { name: 'fr201-irb.pdf', site: 'FR-201', artifact: 'IRB approval', status: 'received', pages: [['Comite de protection des personnes', 'Avis favorable', 'MW-301']] },
  { name: 'us012-1572.pdf', site: 'US-012', artifact: 'FDA Form 1572', status: 'filed', pages: [['Form FDA 1572', 'Statement of investigator', 'Dr. Mei Chen']] },
]

export async function seedEveryPage(win) {
  const docs = DOCS.map((d) => ({ ...d, data: pdfBase64(d.pages) }))
  const incoming = pdfBase64([['Dr. med. Lena Vogel', 'Curriculum vitae', 'Principal Investigator', 'Clinical research experience'], ['L. Vogel', 'Signature', '14 Mar 2026', 'Date']])
  return await win.evaluate(async ({ docs, incoming }) => {
    const api = window.electronAPI
    const ws = new URLSearchParams(location.search).get('workspaceId')
    const out = []
    const create = async (entity, values, status) => {
      const r = await api.memwiseCreateRecord(ws, { entity, values, ...(status ? { status } : {}), reason: 'study set-up' })
      if (!r.applied) throw new Error(`create ${entity}: ${r.message} ${JSON.stringify(r.errors ?? {})}`)
      return r.id
    }
    const existing = await api.memwiseQueryRecords(ws, { entity: 'etmf.Sponsor' }).catch(() => null)
    if (existing && existing.total > 0) return ['already seeded']
    // The owner signs with a password (eTMF is regulated).
    const pw = await api.memwiseSetOwnPassword(ws, { password: 'walkthrough-pass-1' }).catch((e) => ({ applied: false, message: String(e) }))
    out.push(`password: ${pw.applied ? 'set' : pw.message ?? pw.code}`)
    const sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' })
    const study = await create('etmf.Study', { code: 'MW-301', title: 'A phase 3 study of MW-301 in solid tumours', sponsor })
    const artifacts = ['IRB approval', 'Clinical trial agreement', 'Investigator CV', 'Financial disclosure', 'Lab certification',
      'GCP certificates', 'FDA Form 1572', 'Protocol signature page', 'Lab normal ranges', 'Sub-investigator CVs']
    const sites = [
      { n: 'US-012', name: 'Harbor Oncology, Boston', pi: 'Dr. Mei Chen', filed: 10, coordinator: 'coordinator@harbor-oncology.example', cra: ['Tom Okafor', 'tom.okafor@northlight.example'] },
      { n: 'DE-104', name: 'Charite Studienzentrum, Berlin', pi: 'Dr. Jonas Weber', filed: 7, coordinator: 'coordinator@charite-studien.example', cra: ['Priya Shah', 'priya.shah@northlight.example'], reminded: true, pick: true },
      { n: 'FR-201', name: 'Centre Leon Berard, Lyon', pi: 'Dr. Claire Martin', filed: 4, coordinator: 'coordinator@leon-berard.example', cra: ['Priya Shah', 'priya.shah@northlight.example'] },
    ]
    const ids = {}
    for (const s of sites) {
      await create('edc.Site', { site_number: s.n, name: s.name, principal_investigator: s.pi }, 'active')
      const site = await create('etmf.Site', { site_number: s.n, study, coordinator_email: s.coordinator, cra_name: s.cra[0], cra_email: s.cra[1] })
      ids[s.n] = site
      await create('etmf.Person', { name: s.pi, role: 'Principal investigator', site })
      for (let i = 0; i < artifacts.length; i++) {
        await create('etmf.ExpectedDocument', { site, study, artifact: artifacts[i], phase: 'start_up' }, i < s.filed ? 'filed' : undefined)
      }
      if (s.reminded) await create('etmf.Reminder', { site, sent_to: s.coordinator, subject: 'MW-301: 3 documents needed', sent_at: '2026-10-09T09:00:00Z' })
      out.push(`${s.n} seeded`)
    }
    for (const d of docs) {
      const file = await api.memwiseUploadFile(ws, { name: d.name, mime: 'application/pdf', data: d.data })
      try {
        await create('etmf.Document', { file, artifact: d.artifact, study, site: ids[d.site], version: '1', received_at: '2026-10-12T09:00:00Z' }, d.status)
        out.push(`${d.artifact} (${d.site}): ${d.status}`)
      } catch (e) {
        out.push(`${d.artifact} (${d.site}): ${e.message}`)
      }
    }
    for (const s of sites.filter((x) => x.pick)) {
      const r = await api.memwiseTransitionRecord(ws, { entity: 'etmf.Site', id: ids[s.n], transition: 'picked', reason: 'Site selected: contract and budget signed' })
      out.push(`${s.n} picked: ${r.applied ? 'ok' : r.message}`)
    }
    // A CV arrives from US-012: "File a TMF document" files it after the TMF specialist signs.
    const original = await api.memwiseUploadFile(ws, { name: 'vogel-cv.pdf', mime: 'application/pdf', data: incoming })
    const started = await api.memwiseStartCase(ws, { workflowId: 'file-document', values: { original, sender: 'coordinator@harbor-oncology.example', received_at: '2026-10-20T08:12:00Z' } })
    out.push(`file-document: ${started.caseId ?? JSON.stringify(started)}`)
    return out
  }, { docs, incoming })
}
