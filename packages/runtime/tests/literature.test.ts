// Literature (docs/memwise/25-literature-poc.md §3-§6) in the kernel, against a real Postgres: an
// entity's key (one Article per PubMed id, race-safe, `get` by key), system steps calling a tool
// once per item, quotes on step writes lit up in the paper's text viewer, `quote_of` checked on
// every write with a flag when it isn't in the source, record-page kpis and charts, free-page
// charts, and rows kept from a chat.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgEntityStore, withActor, type TestDatabase } from '@memwise/db';
import { loadProject, type ProjectDefs, type ScriptedTurn } from '@memwise/defs';
import { scriptedProvider } from '@memwise/gateway';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel.ts';
import { QUOTE_FLAG_MESSAGE } from '../src/records/quotes.ts';
import type { Kernel, PersonActor, RecordPage } from '../src/types.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const PROJECT = fileURLToPath(new URL('./fixtures/literature-project', import.meta.url));

const ABSTRACT = 'This 72-week, phase 3, double-blind, placebo-controlled trial was conducted across 136 sites. '
  + '1613 (757 [46·9%] female) were randomly assigned. The mean change in bodyweight was −9·6% (95% CI −10·5 to −8·7) with 36 mg. Eli Lilly and Company.';
const ARTICLE_ID = 'arti_attain2';

// The extractor reads the paper, then finishes with a quote per value (the `n` one with plain
// dots and spaces, still found in the abstract's `46·9%`).
const EXTRACTOR: ScriptedTurn[] = [
  { toolCalls: [{ name: 'lit.article.get', args: { id: ARTICLE_ID } }] },
  { toolCalls: [{ name: 'step.finish', args: {
    outcome: 'extracted',
    writes: { n: 1613, sponsor: 'Eli Lilly and Company' },
    quotes: { n: '1613 (757 [46.9%]  female) were randomly assigned', sponsor: 'Eli Lilly and Company.' },
    rationale: '1613 were randomised; Lilly funded it.',
  } }] },
];

let db: TestDatabase;
let kernel: Kernel;
let project: ProjectDefs;
let lead: PersonActor;
let topic = '';

/** A record page's field values by name. */
const valuesOf = (page: RecordPage | undefined) => Object.fromEntries((page?.fields ?? []).map((f) => [f.name, f.value]));

async function finished(runId: string) {
  const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 });
  expect(run).toMatchObject({ state: 'end', status: 'done' });
  return run;
}

describe.skipIf(!pgAvailable)('Literature in the kernel', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_lit');
    project = (await loadProject(PROJECT)).project;
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: PROJECT, tools: [],
      modelRoles: { extractor: { provider: 'scripted', model: 'scripted' } }, providers: [scriptedProvider({ extractor: EXTRACTOR })],
      filesDir: mkdtempSync(join(tmpdir(), 'mw-lit-files-')), logLevel: 'error',
    });
    const diagnostics = await kernel.index();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const p = await kernel.people.create({ name: 'Lea Lead', email: 'lea@example.com', roles: ['lead', 'reviewer'], password: 'correct horse battery' });
    lead = await kernel.people.actorFor(p.id);
    const t = await kernel.records.create({ entity: 'lit.Topic', values: { name: 'Oral GLP-1s' }, reason: 'test' }, lead);
    expect(t.status).toBe('applied');
    topic = t.id!;
  }, 120_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
  }, 60_000);

  test('the key is a unique index: a person creating a second record with it is told so', async () => {
    const { rows } = await kernel.pool.query(`select indexdef from pg_indexes where schemaname = 'domain' and indexname = 'lit__article__key'`);
    expect(rows[0]?.indexdef).toContain('UNIQUE INDEX');
    const first = await kernel.records.create({ entity: 'lit.Article', id: ARTICLE_ID, values: { pmid: '41275875', title: 'ATTAIN-2', abstract: ABSTRACT, year: 2025 }, reason: 'test' }, lead);
    expect(first).toMatchObject({ status: 'applied', id: ARTICLE_ID });
    const again = await kernel.records.create({ entity: 'lit.Article', values: { pmid: '41275875', title: 'Again' }, reason: 'test' }, lead);
    expect(again).toMatchObject({ applied: false, status: 'invalid' });
    expect(again.message).toContain('already');
  });

  test('createKeyed: parallel creates of one key make one record; the rest are told it existed', async () => {
    const def = project.entities['lit.Article']!;
    const store = new PgEntityStore();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      withActor(kernel.pool, { kind: 'system' }, (q) => store.createKeyed(q, def, { pmid: 'race-1', title: `Copy ${i}` }))));
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.existed)).toHaveLength(1);
    const { rows } = await kernel.pool.query(`select count(*)::int as n from domain.lit__article where pmid = 'race-1'`);
    expect(rows[0].n).toBe(1);
  });

  test('a system step calls create once per row: a paper stored before comes back with existed: true', async () => {
    const rows = [
      { pmid: '41275875', title: 'ATTAIN-2 (again)', abstract: 'other', year: 2025 },
      { pmid: '40000001', title: 'Trial A', abstract: 'A trial.', year: 2024 },
      { pmid: '40000002', title: 'Review B', abstract: 'A review.', year: 2023 },
    ];
    const { runId, caseId } = await kernel.startRun({ workflowId: 'collect-papers', case: { rows } });
    await finished(runId);
    const articles = (await kernel.getCase(caseId))?.values.articles?.value as string[];
    expect(articles).toHaveLength(3);
    expect(articles[0]).toBe(ARTICLE_ID);
    // The existing paper is unchanged; the two new ones are stored once each.
    const attain = await kernel.records.page('lit.Article', ARTICLE_ID, lead);
    expect(valuesOf(attain).title).toBe('ATTAIN-2');
    const { rows: stored } = await kernel.pool.query(`select pmid from domain.lit__article where pmid like '4%' order by pmid`);
    expect(stored.map((r) => r.pmid)).toEqual(['40000001', '40000002', '41275875']);
    // One effect per item, keyed by its index.
    const { rows: effects } = await kernel.pool.query(`select idempotency_key from mw.effects where step_run_id like $1 order by idempotency_key`, [`${runId}/%`]);
    expect(effects.map((e) => e.idempotency_key.split(':').slice(1).join(':'))).toEqual(['lit.article.create:0', 'lit.article.create:1', 'lit.article.create:2']);
  }, 90_000);

  test('a step reading the paper quotes its sources; the viewer lights the quotes up in the abstract', async () => {
    const { runId } = await kernel.startRun({ workflowId: 'read-paper', case: { article: ARTICLE_ID } });
    await finished(runId);
    const page = (await kernel.records.page('lit.Article', ARTICLE_ID, lead))!;
    expect(valuesOf(page)).toMatchObject({ n: 1613, sponsor: 'Eli Lilly and Company' });
    const view = page.texts!.abstract!;
    expect(view.text).toBe(ABSTRACT);
    const own = view.highlights.filter((h) => h.kind === 'value');
    expect(own.map((h) => h.field).sort()).toEqual(['n', 'sponsor']);
    const n = own.find((h) => h.field === 'n')!;
    expect(n).toMatchObject({ found: true, value: 1613 });
    expect(ABSTRACT.slice(n.start, n.end)).toBe('1613 (757 [46·9%] female) were randomly assigned');
  }, 90_000);

  let evidence = '';
  test('quote_of: a quote not in the abstract flags the record; correcting it closes the flag', async () => {
    const bad = await kernel.records.create({ entity: 'lit.Evidence', values: {
      topic, article: ARTICLE_ID, outcome: 'Bodyweight', timepoint: 'Week 72', effect: -9.6, ci_low: -10.5, ci_high: -8.7, unit: '%',
      quote: 'bodyweight fell by 12%',
    }, reason: 'test' }, lead);
    expect(bad.status).toBe('applied');
    evidence = bad.id!;
    let flags = await kernel.records.flags({ entity: 'lit.Evidence', recordId: evidence, open: true });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.message).toStartWith(QUOTE_FLAG_MESSAGE);

    const fixed = await kernel.records.update({ entity: 'lit.Evidence', id: evidence, values: { quote: 'the mean change in bodyweight was -9.6% (95% CI -10.5 to -8.7) with 36 mg' }, reason: 'fix' }, lead);
    expect(fixed.status).toBe('applied');
    flags = await kernel.records.flags({ entity: 'lit.Evidence', recordId: evidence, open: true });
    expect(flags).toEqual([]);

    // The paper's viewer lights up the evidence quoting it too.
    const page = (await kernel.records.page('lit.Article', ARTICLE_ID, lead))!;
    const related = page.texts!.abstract!.highlights.filter((h) => h.kind === 'related');
    expect(related).toEqual([expect.objectContaining({ field: 'quote', found: true, record: expect.objectContaining({ entity: 'lit.Evidence', id: evidence }) })]);
  });

  test('keep: rows kept from a chat, created as the person with the chat as the reason; flags for quotes not found', async () => {
    const r = await kernel.records.keep({ entity: 'lit.Evidence', chatId: 'chat_42', rows: [
      { topic, article: ARTICLE_ID, outcome: 'Weight, 12 mg', effect: -7, ci_low: -7.8, ci_high: -6.2, unit: '%', quote: '1613 (757 [46·9%] female)' },
      { topic, article: ARTICLE_ID, outcome: 'Made up', effect: -20, ci_low: -21, ci_high: -19, unit: '%', quote: 'not in the paper at all' },
      { topic, outcome: 'No article' },
    ] }, lead);
    expect(r.entity).toBe('lit.Evidence');
    expect(r.rows[0]).toMatchObject({ quoteFound: true });
    expect(r.rows[1]).toMatchObject({ quoteFound: false });
    expect(r.rows[2]!.id).toBeUndefined();
    expect(r.rows[2]!.error).toBeTruthy();
    const kept = (await kernel.records.page('lit.Evidence', r.rows[0]!.id!, lead))!;
    expect(kept.status).toBe('kept');
    expect(kept.history[0]).toMatchObject({ reason: 'kept from chat chat_42', by: lead.personId });
    expect(await kernel.records.flags({ entity: 'lit.Evidence', recordId: r.rows[1]!.id!, open: true })).toHaveLength(1);
    // Reject the made-up one, so the interval chart leaves it out.
    expect((await kernel.records.transition({ entity: 'lit.Evidence', id: r.rows[1]!.id!, transition: 'reject', reason: 'made up' }, lead)).status).toBe('applied');

    await expect(kernel.records.keep({ entity: 'lit.Screening', chatId: 'chat_42', rows: [{}] }, lead)).rejects.toThrow(/keep_from_chat|kept from a chat/);
    await expect(kernel.records.keep({ entity: 'lit.Evidence', chatId: 'chat_42', rows: [{}] }, { kind: 'system' })).rejects.toThrow();
  });

  test('a record page: kpis, a bar chart counted in SQL, an interval chart of its related rows', async () => {
    const articles = (await kernel.pool.query(`select id, year from domain.lit__article where pmid like '4%'`)).rows;
    for (const a of articles) {
      await kernel.records.create({ entity: 'lit.Screening', values: { topic, article: a.id, decision: Number(a.year) === 2023 ? 'exclude' : 'include', year: Number(a.year) }, reason: 'test' }, lead);
    }
    const page = (await kernel.records.page('lit.Topic', topic, lead))!;
    expect(page.kpis).toEqual({
      included: { field: 'included', value: 2, type: 'Number' },
      evidence_kept: { field: 'evidence_kept', value: 2, type: 'Number' },
    });
    expect(page.charts!['main:1']).toEqual({
      kind: 'bar', title: 'Included papers by year', total: 2,
      data: [{ label: '2024', value: 1, key: '2024' }, { label: '2025', value: 1, key: '2025' }],
    });
    const interval = page.charts!['main:2']!;
    expect(interval).toMatchObject({ kind: 'interval', title: 'Effect vs placebo', unit: '%', total: 2 });
    expect(interval.data.map((d) => [d.label, d.value, d.low, d.high]).sort()).toEqual([
      ['Bodyweight (Week 72)', -9.6, -10.5, -8.7],
      ['Weight, 12 mg ()', -7, -7.8, -6.2],
    ].sort());
    expect(interval.data[0]!.record?.entity).toBe('lit.Evidence');
  });

  test('a free page: a donut counted per decision and an interval chart, narrowed by the topic', async () => {
    const d = await kernel.records.dashboard('lit', 'literature', { topic }, lead);
    expect(d.blocks[0]).toEqual({ kind: 'chart', chart: {
      kind: 'donut', title: 'Decisions', total: 3,
      data: [{ label: 'exclude', value: 1, key: 'exclude' }, { label: 'include', value: 2, key: 'include' }],
    } });
    const interval = d.blocks[1] as { kind: 'chart'; chart: { data: unknown[]; total: number } };
    expect(interval.chart.total).toBe(3); // the free page has no status filter: the rejected one is drawn too
    const other = await kernel.records.dashboard('lit', 'literature', { topic: 'topi_nothing' }, lead);
    expect(other.blocks[0]).toMatchObject({ kind: 'chart', chart: { total: 0, data: [] } });
  });
});
