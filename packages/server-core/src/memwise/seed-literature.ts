/**
 * The Literature search home as the mocks show it (docs/memwise/26-projects-and-pages.md §6, mock
 * LHome), for walkthroughs and screenshots: pages GLP-1 (sums up its sub-pages) › Weight loss,
 * Type 2 diabetes, Side effects (a draft); Heart failure (sums up three sub-pages); Pipeline watch
 * (monthly); Papers read from PubMed; Enquiries; one answer change waiting on Weight loss
 * (ATTAIN-MAINTAIN, found by Monday's refresh) and one reply waiting for the lead's signature.
 *
 * Papers: only ATTAIN-2's PMID and DOI are PubMed's; the other PMIDs (99001…) are placeholders,
 * and every abstract is condensed from the mocks' text, so each number on the pages is quoted from
 * one. Nothing here calls a model or PubMed: the pending change is put up by starting the
 * Literature's "Refresh a page" at its compare step, and the reply by starting "Answer an enquiry"
 * at its sign step, so both wait in "Waiting for you" as real reviews.
 *
 * Run it once on an empty Literature project (it does nothing when GLP-1 is already there).
 */
import type { Kernel, PersonActor } from '@memwise/runtime'

export interface LiteratureSeedOptions {
  /** The medical affairs lead (role `lead`): keeps the pages and reviews their changes. */
  lead: string
  /** Who asked the questions the pages were made from ("made from Omar's question"); default the lead. */
  askedBy?: string
  project?: string
}

export interface LiteratureSeed {
  created: boolean
  pages: Record<string, string>
  papers: Record<string, string>
  enquiries: Record<string, string>
  /** The waiting answer change on Weight loss. */
  changeId?: string
  refreshRunId?: string
  signRunId?: string
}

const ENTITY = { article: 'literature.Article', enquiry: 'literature.Enquiry' }
const REFRESH = 'refresh-literature-page'
const ATTAIN_2_DOI = 'https://doi.org/10.1016/S0140-6736(25)02165-8'
const MAINTAIN_DOI = 'https://doi.org/10.1038/s41591-026-04386-7'

interface Paper {
  key: string
  pmid: string
  doi?: string
  title: string
  journal: string
  year: number
  published: string
  authors: string
  abstract: string
  n?: number
  weeks?: number
  phase: string
  study_type: string
  intervention?: string
  condition?: string
  sponsor?: string
}

/** The Papers the pages quote (mock LLibrary). */
export const SEED_PAPERS: Paper[] = [
  {
    key: 'oasis1', pmid: '99001001', title: 'Oral semaglutide 50 mg taken once per day in adults with overweight or obesity (OASIS 1): a randomised, double-blind, placebo-controlled, phase 3 trial.',
    journal: 'Lancet', year: 2023, published: '2023-06-26', authors: 'Knop FK, Aroda VR, do Vale RD, et al.', n: 667, weeks: 68, phase: 'phase_3', study_type: 'randomised_trial',
    intervention: 'Oral semaglutide 50 mg once daily', condition: 'Overweight or obesity without type 2 diabetes', sponsor: 'Novo Nordisk',
    abstract: 'In this 68-week, phase 3 trial, 667 adults with overweight or obesity were randomly assigned to oral semaglutide 50 mg or placebo. The mean change in bodyweight was -15·1% with oral semaglutide 50 mg and -2·4% with placebo. Novo Nordisk.',
  },
  {
    key: 'oasis2', pmid: '99001002', title: 'Oral semaglutide 50 mg in East Asian adults with overweight or obesity (OASIS 2): a randomised, double-blind, placebo-controlled, phase 3 trial.',
    journal: 'JAMA Intern Med', year: 2025, published: '2025-03-10', authors: 'Kadowaki T, Kim SG, Lee J, et al.', n: 201, weeks: 68, phase: 'phase_3', study_type: 'randomised_trial',
    intervention: 'Oral semaglutide 50 mg once daily', condition: 'Overweight or obesity in East Asian adults, 25% with type 2 diabetes', sponsor: 'Novo Nordisk',
    abstract: 'In this 68-week, phase 3 trial, 201 East Asian adults with overweight or obesity, 25% with type 2 diabetes, were randomly assigned to oral semaglutide 50 mg or placebo. The mean change in bodyweight was -14·3% with oral semaglutide and -1·3% with placebo. Novo Nordisk.',
  },
  {
    key: 'oasis4', pmid: '99001004', title: 'Oral semaglutide 25 mg in adults with overweight or obesity (OASIS 4): a randomised, double-blind, placebo-controlled trial.',
    journal: 'N Engl J Med', year: 2025, published: '2025-09-17', authors: 'Wharton S, Lingvay I, Bogdanski P, et al.', n: 307, weeks: 64, phase: 'phase_3', study_type: 'randomised_trial',
    intervention: 'Oral semaglutide 25 mg once daily', condition: 'Overweight or obesity', sponsor: 'Novo Nordisk',
    abstract: 'In this 64-week, phase 3 trial, 307 adults with overweight or obesity were randomly assigned to oral semaglutide 25 mg or placebo. The mean change in bodyweight was -13·6% with oral semaglutide 25 mg and -2·2% with placebo. Novo Nordisk.',
  },
  {
    key: 'attain1', pmid: '99001011', title: 'Orforglipron, an oral small-molecule GLP-1 receptor agonist, in adults with obesity (ATTAIN-1).',
    journal: 'N Engl J Med', year: 2025, published: '2025-09-16', authors: 'Wharton S, Aronne LJ, Stefanski A, et al.', n: 3127, weeks: 72, phase: 'phase_3', study_type: 'randomised_trial',
    intervention: 'Orforglipron 6 mg, 12 mg or 36 mg once daily', condition: 'Obesity without type 2 diabetes', sponsor: 'Eli Lilly and Company',
    abstract: 'In this 72-week, phase 3 trial, 3127 adults with obesity were randomly assigned to orforglipron or placebo. The mean change in bodyweight was -11·2% with orforglipron 36 mg and -2·1% with placebo. Eli Lilly and Company.',
  },
  {
    key: 'attain2', pmid: '41275875', doi: '10.1016/S0140-6736(25)02165-8',
    title: 'Orforglipron, an oral small-molecule GLP-1 receptor agonist, for the treatment of obesity in people with type 2 diabetes (ATTAIN-2): a phase 3, double-blind, randomised, multicentre, placebo-controlled trial.',
    journal: 'Lancet', year: 2025, published: '2025-11-20', authors: 'Horn DB, Ryan DH, Kis SG, et al.', n: 1613, weeks: 72, phase: 'phase_3', study_type: 'randomised_trial',
    intervention: 'Orforglipron 6 mg, 12 mg or 36 mg once daily, by mouth', condition: 'Obesity in adults with type 2 diabetes', sponsor: 'Eli Lilly and Company',
    abstract: 'This 72-week, phase 3, double-blind, placebo-controlled trial was conducted across 136 sites in ten countries. 1613 (757 [46·9%] female) were randomly assigned. The mean percent change in bodyweight from baseline to week 72 was -9·6% (-10·5 to -8·7) with 36 mg orforglipron (ETD -7·1 [-8·2 to -6·1]; p<0·0001), versus -2·5% (-3·0 to -1·9) with placebo. Treatment discontinuations due to adverse events (mainly gastrointestinal-related) were higher for orforglipron (6·1-9·9%) versus placebo (4·1%). Eli Lilly and Company.',
  },
  {
    key: 'maintain', pmid: '99001020', doi: '10.1038/s41591-026-04386-7',
    title: 'Orforglipron for weight maintenance after switching from injectable incretin therapy (ATTAIN-MAINTAIN): a randomised, double-blind, placebo-controlled, phase 3 trial.',
    journal: 'Nat Med', year: 2026, published: '2026-05-27', authors: 'Aronne LJ, Horn DB, le Roux CW, et al.', n: 376, weeks: 52, phase: 'phase_3', study_type: 'randomised_trial',
    intervention: 'Orforglipron once daily after weekly injections', condition: 'Obesity after weight loss on injectable incretins', sponsor: 'Eli Lilly and Company',
    abstract: 'In this 52-week, phase 3 trial, 376 participants who had lost weight on tirzepatide (n=205) or semaglutide (n=171) were randomly assigned to switch to orforglipron or placebo. Cohort 1 participants who achieved body weight plateau maintained a model-based estimate (MBE) of 74·7% (s.e.m. 4·05) of body weight reduction with orforglipron compared with an MBE of 49·2% (s.e.m. 3·92) with placebo. In cohort 2, 79·3% of the weight lost on semaglutide was maintained with orforglipron versus 37·6% with placebo. Eli Lilly and Company.',
  },
  {
    key: 'indirect', pmid: '99001030', title: 'Oral versus injected semaglutide for weight loss: an indirect comparison of OASIS 4 and STEP 1.',
    journal: 'Diabetes Obes Metab', year: 2026, published: '2026-04-02', authors: 'Plotkin M, Sato R, Owusu A, et al.', phase: 'not_a_trial', study_type: 'systematic_review',
    abstract: 'An indirect comparison found oral semaglutide 25 mg and the weekly 2·4 mg injection gave similar weight loss (difference 1·0 points, 95% CI -1·6 to 3·6). It compares two separate trials.',
  },
  {
    key: 'cognition', pmid: '99001040', title: 'Semaglutide for cognitive dysfunction in depression: a 16-week randomised trial.',
    journal: 'Med', year: 2025, published: '2025-08-12', authors: 'Example R, Sample T, et al.', n: 72, weeks: 16, phase: 'phase_2', study_type: 'randomised_trial',
    abstract: 'In this 16-week trial, 72 adults with depression were randomly assigned to oral semaglutide 14 mg or placebo. Cognitive function was the primary outcome; weight was a secondary outcome.',
  },
]

const q = (text: string, cite: string, href?: string) => ({ text, cite, ...(href ? { href } : {}) })
const fence = (lang: string, value: unknown) => ['```' + lang, JSON.stringify(value), '```'].join('\n')

const WEIGHT_HEADLINE = 'Oral GLP-1s gave **9 to 13 points more** weight loss than placebo over 64 to 72 weeks. In people with type 2 diabetes, **7 points**.'
const WEIGHT_TRIALS = fence('table', {
  columns: [{ key: 'trial', label: 'Trial' }, { key: 'drug', label: 'Drug' }, { key: 'people', label: 'People' }, { key: 'weeks', label: 'Weeks' }, { key: 'on', label: 'On drug' }, { key: 'placebo', label: 'Placebo' }],
  rows: [
    { trial: 'OASIS 1', drug: 'Semaglutide 50 mg', people: { text: '667', quote: q('667 adults with overweight or obesity were randomly assigned', 'OASIS 1 · Knop FK et al. Lancet 2023') }, weeks: '68', on: { text: '−15.1%', quote: q('-15·1% with oral semaglutide 50 mg', 'OASIS 1 · Knop FK et al. Lancet 2023') }, placebo: '−2.4%' },
    { trial: 'OASIS 2', drug: 'Semaglutide 50 mg', people: '201', weeks: '68', on: { text: '−14.3%', quote: q('-14·3% with oral semaglutide', 'OASIS 2 · Kadowaki T et al. JAMA Intern Med 2025') }, placebo: '−1.3%' },
    { trial: 'OASIS 4', drug: 'Semaglutide 25 mg', people: '307', weeks: '64', on: { text: '−13.6%', quote: q('-13·6% with oral semaglutide 25 mg', 'OASIS 4 · Wharton S et al. N Engl J Med 2025') }, placebo: '−2.2%' },
    { trial: 'ATTAIN-1', drug: 'Orforglipron 36 mg', people: '3,127', weeks: '72', on: { text: '−11.2%', quote: q('-11·2% with orforglipron 36 mg', 'ATTAIN-1 · Wharton S et al. N Engl J Med 2025') }, placebo: '−2.1%' },
    { trial: { text: 'ATTAIN-2', href: ATTAIN_2_DOI }, drug: 'Orforglipron 36 mg, T2D', people: { text: '1,613', quote: q('1613 (757 [46·9%] female) were randomly assigned', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI) }, weeks: '72', on: { text: '−9.6%', quote: q('-9·6% (-10·5 to -8·7) with 36 mg orforglipron', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI) }, placebo: '−2.5%' },
  ],
})
const WEIGHT_BODY = [
  WEIGHT_HEADLINE, '',
  fence('chart', {
    kind: 'bar', title: 'Extra weight lost vs placebo, percentage points', unit: 'points',
    data: [{ label: 'OASIS 2', value: 13.1 }, { label: 'OASIS 1', value: 12.7 }, { label: 'OASIS 4', value: 11.4 }, { label: 'ATTAIN-1', value: 9.1 }, { label: 'ATTAIN-2', value: 7.1 }],
    source: 'ATTAIN-1 is worked out from its two arms. Indirect comparisons are noted, not charted.',
  }), '',
  '## Trials', '', WEIGHT_TRIALS, '',
  '## Note under the chart', '',
  'An **indirect** comparison found oral semaglutide 25 mg and the weekly 2.4 mg injection gave similar weight loss (difference 1.0 points, 95% CI −1.6 to 3.6). It compares two separate trials, so it isn\'t in the chart. Plotkin M et al. 2026.',
].join('\n')
const MAINTAIN_SECTION = [
  '## Keeping weight off after injections', '',
  'ATTAIN-MAINTAIN: people who switched from weekly injections to orforglipron kept **75 to 79%** of the weight lost, against 38 to 49% on placebo, at 52 weeks.', '',
  fence('table', {
    columns: [{ key: 'from', label: 'Switched from' }, { key: 'drug', label: 'Kept on orforglipron' }, { key: 'placebo', label: 'Kept on placebo' }],
    rows: [
      { from: 'Tirzepatide (205 people)', drug: { text: '74.7%', quote: q('maintained a model-based estimate (MBE) of 74·7% (s.e.m. 4·05) of body weight reduction with orforglipron compared with an MBE of 49·2% (s.e.m. 3·92) with placebo', 'ATTAIN-MAINTAIN · Aronne LJ et al. Nat Med 2026', MAINTAIN_DOI) }, placebo: '49.2%' },
      { from: 'Semaglutide (171 people)', drug: { text: '79.3%', quote: q('79·3% of the weight lost on semaglutide was maintained with orforglipron versus 37·6% with placebo', 'ATTAIN-MAINTAIN · Aronne LJ et al. Nat Med 2026', MAINTAIN_DOI) }, placebo: '37.6%' },
    ],
  }),
].join('\n')

const T2D_BODY = [
  '**ATTAIN-2: 7.1 points more** weight loss than placebo at 36 mg over 72 weeks, in adults with obesity and type 2 diabetes.', '',
  '## The trial', '',
  fence('tiles', { tiles: [{ label: 'People', value: '1,613', note: 'randomised' }, { label: 'Weeks', value: '72' }, { label: 'Difference, 36 mg', value: '−7.1', note: '95% CI −8.2 to −6.1' }] }), '',
  fence('table', {
    columns: [{ key: 'dose', label: 'Dose' }, { key: 'change', label: 'Weight change' }],
    rows: [
      { dose: 'Orforglipron 36 mg', change: { text: '−9.6%', quote: q('-9·6% (-10·5 to -8·7) with 36 mg orforglipron', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI) } },
      { dose: 'Placebo', change: { text: '−2.5%', quote: q('-2·5% (-3·0 to -1·9) with placebo', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI) } },
    ],
  }),
].join('\n')

const SIDE_BODY = [
  '**5 to 10%** stopped orforglipron because of side effects, against 3 to 4% on placebo, mostly for stomach and gut problems.', '',
  '## Stopping because of side effects', '',
  fence('table', {
    columns: [{ key: 'trial', label: 'Trial' }, { key: 'drug', label: 'Stopped on the drug' }, { key: 'placebo', label: 'On placebo' }],
    rows: [{ trial: { text: 'ATTAIN-2', href: ATTAIN_2_DOI }, drug: { text: '6.1–9.9%', quote: q('higher for orforglipron (6·1-9·9%) versus placebo (4·1%)', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI) }, placebo: '4.1%' }],
  }),
].join('\n')

const GLP1_BODY = [
  'Oral GLP-1s give **9 to 13 points more** weight loss than placebo over 64 to 72 weeks, and about **7 points** in people with type 2 diabetes.', '',
  '```subpages', '{}', '```', '',
  'Papers under GLP-1 are in Papers.',
].join('\n')

const HF_KIDS = [
  { title: 'HFpEF', question: 'Do SGLT2 inhibitors help heart failure with preserved ejection fraction?', body: 'SGLT2 inhibitors cut worsening heart failure or cardiovascular death by about a fifth in heart failure with preserved ejection fraction.' },
  { title: 'HFrEF', question: 'Do SGLT2 inhibitors help heart failure with reduced ejection fraction?', body: 'SGLT2 inhibitors cut worsening heart failure or cardiovascular death by about a quarter in heart failure with reduced ejection fraction.' },
  { title: 'Without diabetes', question: 'Do SGLT2 inhibitors help people with heart failure who don\'t have diabetes?', body: 'The benefit is the same with or without diabetes.' },
]

export async function seedLiteratureHome(kernel: Kernel, opts: LiteratureSeedOptions): Promise<LiteratureSeed> {
  const project = opts.project ?? 'literature'
  const lead: PersonActor = await actorOf(kernel, opts.lead)
  const asker: PersonActor = opts.askedBy ? await actorOf(kernel, opts.askedBy) : lead
  const system = { kind: 'system' } as const

  const existing = (await kernel.pages.list(project, lead)).find((p) => p.title === 'GLP-1' && !p.parent)
  if (existing) return { created: false, pages: { glp1: existing.id }, papers: {}, enquiries: {} }

  // ---- Papers, read once.
  const papers: Record<string, string> = {}
  for (const p of SEED_PAPERS) {
    const { key, ...v } = p
    const r = await kernel.records.create({
      entity: ENTITY.article, status: 'read', reason: 'Read for the Literature walkthrough',
      values: { ...v, article_types: v.study_type === 'randomised_trial' ? ['Journal Article', 'Randomized Controlled Trial'] : ['Journal Article'] },
    }, system)
    if (r.status !== 'applied' || !r.id) throw new Error(`The paper ${p.title} could not be stored: ${r.message ?? r.status}`)
    papers[key] = r.id
  }

  // ---- Pages.
  const ok = <T extends { applied: boolean; message?: string; page?: { id: string } }>(r: T, what: string) => {
    if (!r.applied || !r.page) throw new Error(`${what}: ${r.message ?? 'refused'}`)
    return r.page.id
  }
  const make = async (input: Parameters<Kernel['pages']['create']>[0], by: PersonActor, keep?: { every: string }) => {
    const id = ok(await kernel.pages.create(input, by), input.title)
    if (keep) ok(await kernel.pages.keep(id, keep, lead), `Keeping ${input.title}`)
    return id
  }
  const pages: Record<string, string> = {}
  pages.glp1 = await make({ project, title: 'GLP-1', question: 'What do oral GLP-1s do, by outcome?', body: GLP1_BODY, sumsChildren: true, reason: 'Made the page' }, lead, { every: 'mon' })
  pages.weight = await make({ project, title: 'Weight loss', parent: pages.glp1, question: 'How much weight do people lose on oral GLP-1s?', body: WEIGHT_BODY, reason: 'Asked a question' }, asker, { every: 'mon' })
  pages.t2d = await make({ project, title: 'Type 2 diabetes', parent: pages.glp1, question: 'How much weight do people with type 2 diabetes lose on oral GLP-1s?', body: T2D_BODY, reason: 'Asked a question' }, lead, { every: 'mon' })
  pages.side = await make({ project, title: 'Side effects', parent: pages.glp1, question: 'How often do people stop oral GLP-1s because of side effects?', body: SIDE_BODY, reason: 'Asked a question' }, asker)
  pages.hf = await make({ project, title: 'Heart failure', question: 'What do SGLT2 inhibitors do in heart failure?', body: 'SGLT2 inhibitors cut hospitalisation for heart failure, with or without diabetes.\n\n```subpages\n{}\n```', sumsChildren: true }, lead, { every: 'mon' })
  for (const k of HF_KIDS) pages[`hf_${k.title}`] = await make({ project, title: k.title, parent: pages.hf, question: k.question, body: k.body }, lead, { every: 'mon' })
  pages.pipeline = await make({
    project, title: 'Pipeline watch', question: 'Which oral GLP-1s are coming, and how far along are they?',
    body: 'Two oral GLP-1s have phase 3 results for weight: orforglipron (ATTAIN-1, ATTAIN-2) and oral semaglutide 25 mg (OASIS 4). The monthly digest emails it to 6 people.',
  }, lead, { every: 'month' })

  // Each kept page's last refresh found nothing new (Type 2 diabetes: "nothing new Mon").
  for (const id of [pages.t2d, pages.hf, ...HF_KIDS.map((k) => pages[`hf_${k.title}`]!), pages.pipeline]) {
    const p = await kernel.pages.get(id!, lead)
    await (kernel.pages as unknown as PagesCompare).compare({ page: id!, body: p!.written, reason: 'schedule' })
  }
  // The sub-pages' summary refreshes aren't run here: their parents say what they summed up.
  for (const id of [pages.glp1, pages.hf]) {
    const p = await kernel.pages.get(id!, lead)
    if (p?.refresh?.summaryDue) await kernel.pool.query(`update mw.pages set refresh = refresh - 'summaryDue' - 'summary_due' where id = $1`, [id])
  }

  // ---- Monday's refresh of Weight loss found ATTAIN-MAINTAIN: the change waits for review.
  const started = await kernel.startRun({
    workflowId: REFRESH, startAt: 'compare', by: `page:${pages.weight}`,
    case: {
      page: pages.weight, reason: 'schedule', body: `${WEIGHT_BODY}\n\n${MAINTAIN_SECTION}`,
      label: '1 new trial', change_title: 'ATTAIN-MAINTAIN added',
      plus: 'after switching from weekly injections, people on orforglipron kept 75 to 79% of the weight they had lost, against 38 to 49% on placebo.',
      found_count: 3, new_articles: [papers.maintain],
      left_out: [
        { title: 'Oral versus injected semaglutide for weight loss: an indirect comparison', why: 'Not a trial: it compares two separate trials, so it is noted under the chart, not counted' },
        { title: 'Semaglutide for cognitive dysfunction in depression', why: '16 weeks, weight a secondary outcome' },
      ],
    },
  })
  const change = await waitFor(async () => (await kernel.pages.get(pages.weight!, lead))?.pendingChange?.id)

  // ---- Enquiries: one answered, one waiting for the lead's signature.
  const enquiries: Record<string, string> = {}
  const enquiry = async (key: string, values: Record<string, unknown>, status: string) => {
    const r = await kernel.records.create({ entity: ENTITY.enquiry, status, reason: 'Seeded for the Literature walkthrough', values }, system)
    if (r.status !== 'applied' || !r.id) throw new Error(`The enquiry ${String(values.subject)} could not be stored: ${r.message ?? r.status}`)
    enquiries[key] = r.id
  }
  await enquiry('meiLin', {
    from: 'mei.lin@example.org', from_name: 'Dr Mei Lin', subject: 'ATTAIN-2 and HbA1c',
    question: 'How much did HbA1c fall with orforglipron in ATTAIN-2?', received: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    reply: 'Dear Dr Lin,\n\nATTAIN-2 reports weight as its primary outcome; the abstract gives a 7.1-point greater fall in bodyweight with 36 mg than with placebo [1].\n\n[1] Horn DB et al. Lancet 2025.',
    references: [ATTAIN_2_DOI], pages: [pages.t2d],
  }, 'sent')
  const ADEYEMI_REPLY = 'Dear Dr Adeyemi,\n\nThe two have not been compared head to head. An indirect comparison of separate trials found similar weight loss with oral semaglutide 25 mg and the weekly 2.4 mg injection: a difference of 1.0 percentage points (95% CI −1.6 to 3.6) [1]. Because the trials were separate, this is weaker evidence than a direct trial.\n\n[1] Plotkin M et al. Diabetes Obes Metab 2026.'
  await enquiry('adeyemi', {
    from: 'ruth.adeyemi@example.org', from_name: 'Dr Ruth Adeyemi', subject: 'Is oral semaglutide 25 mg as good as the injection?',
    question: 'Is oral semaglutide 25 mg as good as the weekly 2.4 mg injection for weight loss?', received: new Date(Date.now() - 86_400_000).toISOString(),
    reply: ADEYEMI_REPLY, references: ['Plotkin M et al. Diabetes Obes Metab 2026'], pages: [pages.weight],
  }, 'drafted')
  const sign = await kernel.startRun({
    workflowId: 'answer-enquiry', startAt: 'sign', by: lead.personId,
    case: {
      sender: 'ruth.adeyemi@example.org', subject: 'Is oral semaglutide 25 mg as good as the injection?',
      question: 'Is oral semaglutide 25 mg as good as the weekly 2.4 mg injection for weight loss?',
      enquiry: enquiries.adeyemi, reply: ADEYEMI_REPLY, references: ['Plotkin M et al. Diabetes Obes Metab 2026'],
      evidence: 'Weight loss (kept page): an indirect comparison found similar weight loss, a difference of 1.0 points (95% CI −1.6 to 3.6).', pages: [pages.weight],
    },
  })

  return { created: true, pages, papers, enquiries, ...(change ? { changeId: change } : {}), refreshRunId: started.runId, signRunId: sign.runId }
}

interface PagesCompare {
  compare(input: { page: string; body: string; reason?: string }): Promise<{ outcome: string }>
}

async function actorOf(kernel: Kernel, personId: string): Promise<PersonActor> {
  const p = await kernel.people.get(personId)
  if (!p) throw new Error(`There is no person ${personId}`)
  return { kind: 'person', personId: p.id, roles: p.roles } as PersonActor
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== undefined || Date.now() > deadline) return v
    await new Promise((r) => setTimeout(r, 100))
  }
}
