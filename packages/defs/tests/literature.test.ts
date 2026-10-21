// Literature (docs/memwise/25-literature-poc.md §3-§5) in the definitions: the quote normaliser,
// entity keys (D80), `quote_of` (D82), `keep_from_chat`, record-page `kpis`, interval charts and
// `chat`, free-page charts, and system steps that call a tool per item (`each`, `item.<path>`,
// `{ today }`, `{ now }`) or quote their sources (`quotes: required`, D81).
import { describe, expect, test } from 'bun:test';
import { checkProject, findQuote, loadProject, normalizeQuoteText, quoteIn, quoteInValue, type Diagnostic } from '../src/index.ts';
import { BASE, ENV, makeProject } from './fixture.ts';
import { brief, makeMulti, MULTI } from './phase6-fixture.ts';

const ARTICLE = 'domains/sales/entities/article.yaml';
const EVIDENCE = 'domains/sales/entities/evidence.yaml';
const BOARD = 'domains/sales/pages/evidence.yaml';

const LIT: Record<string, string> = {
  ...MULTI,
  [ARTICLE]: `entity: Article
title: "{title}"
key: [pmid]
fields:
  pmid: { type: Text, required: true }
  title: Text
  abstract: Text
  year: Number
relationships:
  evidence: many Evidence
calculated:
  evidence_count: { count: evidence }
page:
  layout: split
  header: [title]
  left: [{ viewer: abstract }]
  right:
    - kpis: [evidence_count, year]
    - chart: { kind: interval, of: evidence, label: "{outcome}", value: effect, low: ci_low, high: ci_high, unit: unit, where: "effect is set", title: Effects }
    - chart: { kind: bar, of: evidence, by: outcome }
    - chat
`,
  [EVIDENCE]: `entity: Evidence
title: "{outcome}"
keep_from_chat: true
fields:
  article: { type: Ref<Article>, required: true }
  outcome: Text
  effect: Number
  ci_low: Number
  ci_high: Number
  unit: Text
  quote: { type: Text, quote_of: article.abstract }
`,
  [BOARD]: `title: Evidence
params: { article: Ref<Article> }
blocks:
  - chart: { kind: bar, entity: Evidence, by: outcome, where: "article = params.article", title: By outcome }
  - chart: { kind: interval, entity: Evidence, label: "{outcome}", value: effect, low: ci_low, high: ci_high }
`,
};

async function checkLit(changes: Record<string, string | null> = {}): Promise<string[]> {
  const { project, diagnostics } = await loadProject(makeMulti(changes, LIT));
  return brief([...diagnostics, ...checkProject(project, { tools: {} })]);
}
const article = (find: string, replace: string) => ({ [ARTICLE]: LIT[ARTICLE]!.replace(find, replace) });
const evidence = (find: string, replace: string) => ({ [EVIDENCE]: LIT[EVIDENCE]!.replace(find, replace) });
const board = (find: string, replace: string) => ({ [BOARD]: LIT[BOARD]!.replace(find, replace) });

describe('the quote normaliser (one place, for the step engine, the record store and the viewer)', () => {
  const ABSTRACT = 'Between Aug 2021 and Mar 2023, 1613 (757 [46·9%] female) were randomly assigned. Weight fell by −6·7 kg (95% CI −7·2 to −6·1).';

  test('NFKC, case, whitespace, · as ., dashes and curly quotes', () => {
    expect(normalizeQuoteText('  Ｗeight\n\tFELL  by −6·7 kg ')).toBe('weight fell by -6.7 kg');
    expect(normalizeQuoteText('“open‐label” – ‘phase 3’')).toBe('"open-label" - \'phase 3\'');
  });

  test('findQuote gives offsets into the original text', () => {
    const hit = findQuote('weight fell by -6.7 KG', ABSTRACT)!;
    expect(ABSTRACT.slice(hit.start, hit.end)).toBe('Weight fell by −6·7 kg');
    const spaced = findQuote('1613  (757 [46.9%]   female)', ABSTRACT)!;
    expect(ABSTRACT.slice(spaced.start, spaced.end)).toBe('1613 (757 [46·9%] female)');
    expect(findQuote('1614 (757', ABSTRACT)).toBeUndefined();
    expect(findQuote('   ', ABSTRACT)).toBeUndefined();
  });

  test('quoteIn and quoteInValue look through strings and JSON text, not numbers', () => {
    expect(quoteIn('randomly ASSIGNED', ABSTRACT)).toBe(true);
    expect(quoteInValue('randomly assigned', { rows: [{ abstract: ABSTRACT }] })).toBe(true);
    expect(quoteInValue('randomly assigned', { content: [{ type: 'text', text: JSON.stringify({ abstract: ABSTRACT }) }] })).toBe(true);
    // A number a tool returned is a value, not words it was read from (in JSON text too); in prose it counts.
    expect(quoteInValue('1613', { n: 1613 })).toBe(false);
    expect(quoteInValue('1613', { content: [{ type: 'text', text: JSON.stringify({ n: 1613 }) }] })).toBe(false);
    expect(quoteInValue('1613', { rows: [{ abstract: ABSTRACT }] })).toBe(true);
    expect(quoteInValue('enrolled', { rows: [{ abstract: ABSTRACT }] })).toBe(false);
  });
});

describe('entity key, quote_of and keep_from_chat', () => {
  test('parsed onto the entity, and the fixture is clean', async () => {
    const { project, diagnostics } = await loadProject(makeMulti({}, LIT));
    expect(diagnostics).toEqual([]);
    expect(brief(checkProject(project, { tools: {} }))).toEqual([]);
    expect(project.entities['sales.Article']!.key).toEqual(['pmid']);
    expect(project.entities['sales.Evidence']!.keepFromChat).toBe(true);
    expect(project.entities['sales.Article']!.keepFromChat).toBeUndefined();
    expect(project.entities['sales.Evidence']!.fields.quote!.quoteOf).toEqual({ ref: 'article', field: 'abstract' });
  });

  test('a one-field key may be written without the list', async () => {
    const { project } = await loadProject(makeMulti(article('key: [pmid]', 'key: pmid'), LIT));
    expect(project.entities['sales.Article']!.key).toEqual(['pmid']);
  });

  test('key-unknown-field and key-field-not-required', async () => {
    expect(await checkLit(article('key: [pmid]', 'key: [pmd]'))).toEqual([`error key-unknown-field ${ARTICLE} key.0`]);
    expect(await checkLit(article('key: [pmid]', 'key: [pmid, title]'))).toEqual([`error key-field-not-required ${ARTICLE} key.1`]);
    // A key of several required fields is fine.
    const two = LIT[ARTICLE]!.replace('key: [pmid]', 'key: [pmid, year]').replace('  year: Number', '  year: { type: Number, required: true }');
    expect(await checkLit({ [ARTICLE]: two })).toEqual([]);
  });

  test('list: the default columns, each a field, a calculated field or status (list-unknown-field)', async () => {
    const listed = article('key: [pmid]', 'key: [pmid]\nlist: [year, evidence_count, status]');
    const { project } = await loadProject(makeMulti(listed, LIT));
    expect(project.entities['sales.Article']!.list).toEqual(['year', 'evidence_count', 'status']);
    expect(await checkLit(listed)).toEqual([]);
    expect(await checkLit(article('key: [pmid]', 'key: [pmid]\nlist: [year, abstrakt]'))).toEqual([`error list-unknown-field ${ARTICLE} list.1`]);
  });

  test('key-field-restricted: a key field may not have access:', async () => {
    expect(await checkLit(article('pmid: { type: Text, required: true }', 'pmid: { type: Text, required: true, access: [lead] }')))
      .toEqual([`error key-field-restricted ${ARTICLE} key.0`]);
  });

  test('quote-of-not-text and quote-of-unknown-field', async () => {
    expect(await checkLit(evidence('quote: { type: Text', 'quote: { type: Number'))).toEqual([`error quote-of-not-text ${EVIDENCE} fields.quote.quote_of`]);
    expect(await checkLit(evidence('quote_of: article.abstract', 'quote_of: outcome.abstract'))).toEqual([`error quote-of-unknown-field ${EVIDENCE} fields.quote.quote_of`]);
    expect(await checkLit(evidence('quote_of: article.abstract', 'quote_of: article.year'))).toEqual([`error quote-of-unknown-field ${EVIDENCE} fields.quote.quote_of`]);
    expect(await checkLit(evidence('quote_of: article.abstract', 'quote_of: abstract'))).toEqual([`error invalid-format ${EVIDENCE} fields.quote.quote_of`]);
  });
});

describe('record pages: kpis, charts, chat and a Text viewer', () => {
  test('parsed blocks', async () => {
    const { project } = await loadProject(makeMulti({}, LIT));
    const right = project.entities['sales.Article']!.page!.areas.right!;
    expect(right).toEqual([
      { kind: 'kpis', fields: ['evidence_count', 'year'] },
      { kind: 'chart', chart: 'interval', of: 'evidence', label: '{outcome}', value: 'effect', low: 'ci_low', high: 'ci_high', unit: 'unit', where: 'effect is set', title: 'Effects' },
      { kind: 'chart', chart: 'bar', of: 'evidence', by: 'outcome' },
      { kind: 'chat' },
    ]);
    expect(project.entities['sales.Article']!.page!.areas.left![0]).toEqual({ kind: 'viewer', field: 'abstract' });
  });

  test('kpis name calculated or Number fields', async () => {
    expect(await checkLit(article('kpis: [evidence_count, year]', 'kpis: [evidence_count, title]'))).toEqual([`error unknown-field ${ARTICLE} page.right`]);
  });

  test('chart fields: by, where, interval value/low/high as numbers, unit, label names', async () => {
    expect(await checkLit(article('by: outcome', 'by: colour'))).toEqual([`error unknown-field ${ARTICLE} page.right`]);
    expect(await checkLit(article('value: effect', 'value: outcome'))).toEqual([`error unknown-field ${ARTICLE} page.right`]);
    expect(await checkLit(article('high: ci_high', 'high: ci_top'))).toEqual([`error unknown-field ${ARTICLE} page.right`]);
    expect(await checkLit(article('label: "{outcome}"', 'label: "{outcom}"'))).toEqual([`error unknown-field ${ARTICLE} page.right`]);
    expect(await checkLit(article('where: "effect is set"', 'where: "efect is set"'))).toEqual([`error unknown-field ${ARTICLE} page.right`]);
    // An interval chart without its numbers, and an unknown chart key.
    expect(await checkLit(article('low: ci_low, ', ''))).toEqual([`error invalid-format ${ARTICLE} page.right.1.chart`]);
    expect(await checkLit(article('by: outcome', 'by: outcome, colour: red'))).toEqual([`warning unknown-key ${ARTICLE} page.right.2.chart.colour`]);
  });

  test('a viewer may show a Text field, not a Number', async () => {
    expect(await checkLit(article('viewer: abstract', 'viewer: year'))).toEqual([`error unknown-field ${ARTICLE} page.left`]);
  });
});

describe('free pages: chart blocks', () => {
  test('parsed, with params narrowing', async () => {
    const { project } = await loadProject(makeMulti({}, LIT));
    const page = project.domains!.sales!.pages['evidence']!;
    expect(page.blocks).toEqual([
      { kind: 'chart', chart: 'bar', entity: 'Evidence', by: 'outcome', where: 'article = params.article', title: 'By outcome' },
      { kind: 'chart', chart: 'interval', entity: 'Evidence', label: '{outcome}', value: 'effect', low: 'ci_low', high: 'ci_high' },
    ]);
  });

  test('unknown-entity, unknown-field, a bar chart without `by`, an interval without its numbers', async () => {
    expect(await checkLit(board('entity: Evidence, by', 'entity: Proof, by'))).toEqual([`error unknown-entity ${BOARD} blocks.0.chart.entity`]);
    expect(await checkLit(board('by: outcome', 'by: colour'))).toEqual([`error unknown-field ${BOARD} blocks.0.chart`]);
    expect(await checkLit(board('params.article', 'params.paper'))).toEqual([`error unknown-field ${BOARD} blocks.0.chart`]);
    expect(await checkLit(board('by: outcome, ', ''))).toEqual([`error invalid-format ${BOARD} blocks.0.chart`]);
    expect(await checkLit(board('value: effect, ', ''))).toEqual([`error invalid-format ${BOARD} blocks.1.chart`]);
  });
});

describe('system steps: each, item, today, now; quotes', () => {
  const WORK = 'workflows/demo/steps/work.md';
  const CASE = 'workflows/demo/case.yaml';
  const env = { tools: { ...ENV.tools, 'lookup.customer': { effect: 'read' as const, inputSchema: {
    type: 'object', properties: { name: { type: 'string' }, region: { type: 'string' }, at: { type: 'string' } }, required: ['name', 'region'], additionalProperties: false,
  } } } };
  const caseYaml = BASE[CASE]!.replace('  owner: Ref<Customer>', '  owner: Ref<Customer>\n  owners: List<Text>\n  since: Date');
  const system = (map: string, writes = '  owners: { type: List<Text>, from: { tool: lookup.customer, field: id } }') => [
    '---', 'title: Look up', 'performer: system', 'reads: [case.name, case.flags]', 'tools: { allowed: [lookup.customer], required: [lookup.customer] }',
    'outcomes: [done]', 'map:', map, 'writes:', writes, '---', 'Look each one up.', '',
  ].join('\n');
  const brief2 = (ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${d.code} ${d.path ?? ''}`);
  async function check(changes: Record<string, string>) {
    const { project, diagnostics } = await loadProject(makeProject({ [CASE]: caseYaml, ...changes }));
    return { project, out: brief2([...diagnostics, ...checkProject(project, env)]) };
  }

  test('parsed: each per tool, item paths, today and now', async () => {
    const { project, out } = await check({ [WORK]: system('  lookup.customer: { each: case.flags, name: item.note, region: { today: 7 }, at: { now: true } }') });
    expect(out).toEqual([]);
    const step = project.workflows.demo!.steps.work!;
    expect(step.each).toEqual({ 'lookup.customer': 'flags' });
    expect(step.map!['lookup.customer']).toEqual({ name: { item: 'note' }, region: { today: 7 }, at: { now: true } });
  });

  test('map-each-not-list, an unknown each field, and a malformed each', async () => {
    expect((await check({ [WORK]: system('  lookup.customer: { each: case.name, name: item, region: x }') })).out)
      .toContain('error map-each-not-list map.lookup.customer.each');
    expect((await check({ [WORK]: system('  lookup.customer: { each: case.nothing, name: item, region: x }') })).out)
      .toContain('error unknown-case-field map.lookup.customer.each');
    expect((await check({ [WORK]: system('  lookup.customer: { each: flags, name: x, region: x }') })).out)
      .toContain('error invalid-format map.lookup.customer.each');
  });

  test('map-item-without-each, an unknown item field, each-write-not-list', async () => {
    expect((await check({ [WORK]: system('  lookup.customer: { name: item.note, region: x }', '  owner: { type: Ref<Customer>, from: { tool: lookup.customer, field: id } }') })).out)
      .toEqual(['error map-item-without-each map.lookup.customer.name']);
    expect((await check({ [WORK]: system('  lookup.customer: { each: case.flags, name: item.colour, region: x }') })).out)
      .toEqual(['error unknown-case-field map.lookup.customer.name']);
    expect((await check({ [WORK]: system('  lookup.customer: { each: case.flags, name: item.note, region: x }', '  owner: { type: Ref<Customer>, from: { tool: lookup.customer, field: id } }') })).out)
      .toEqual(['error each-write-not-list writes.owner']);
  });

  test('each-target-not-keyed: creating once per item needs a key on the entity, or a re-entered step makes them again', async () => {
    const create = system('  domain.customer.create: { each: case.flags, name: item.note }', '  owners: { type: List<Text>, from: { tool: domain.customer.create, field: id } }')
      .replace(/lookup\.customer/g, 'domain.customer.create');
    expect((await check({ [WORK]: create })).out).toEqual(['warning each-target-not-keyed map.domain.customer.create.each']);
    const keyed = 'entity: Customer\nkey: [name]\nfields:\n  name: { type: Text, required: true }\n';
    expect((await check({ [WORK]: create, 'domain/entities/customer.yaml': keyed })).out).toEqual([]);
    // A tool that isn't a create (a read per item) needs no key.
    expect((await check({ [WORK]: system('  lookup.customer: { each: case.flags, name: item.note, region: x }') })).out).toEqual([]);
  });

  test('quotes: required is parsed on an agent step and ignored, with a warning, elsewhere', async () => {
    const agent = BASE[WORK]!.replace('outcomes: [done]', 'outcomes: [done]\nquotes: required');
    const { project, out } = await check({ [WORK]: agent });
    expect(out).toEqual([]);
    expect(project.workflows.demo!.steps.work!.quotes).toBe('required');
    expect((await check({ [WORK]: system('  lookup.customer: { name: case.name, region: x }', '  owner: { type: Ref<Customer>, from: { tool: lookup.customer, field: id } }').replace('outcomes: [done]', 'outcomes: [done]\nquotes: required') })).out)
      .toEqual(['warning quotes-ignored quotes']);
    expect((await check({ [WORK]: agent.replace('quotes: required', 'quotes: maybe') })).out).toContain('error invalid-format quotes');
  });
});
