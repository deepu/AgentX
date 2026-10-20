// Phase 6 (24 §2, §4, §6-§8, §11): the workspace and domains, and the new parts of entity,
// workflow, step, page, view and example files.
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkProject, DEFAULT_DOMAIN, defaultPageLayout, entityToolNames, entityTools, handoffArg, loadProject, parseDuration,
  parseEntityFile, parseExampleFile, parsePageFile, parseStepFile, parseValueType, parseViewFile, parseWorkflowFile, parseWorkspaceFile,
} from '../src/index.ts';
import { SAMPLE } from './fixture.ts';
import { brief, makeMulti } from './phase6-fixture.ts';

describe('loading a workspace with domains', () => {
  test('the two-domain project loads and checks clean', async () => {
    const { project, diagnostics } = await loadProject(makeMulti());
    expect([...brief(diagnostics), ...brief(checkProject(project, { tools: {} }))]).toEqual([]);
    expect(project.workspace).toMatchObject({ name: 'Acme', stormLimit: 10, policy: { effects: { irreversible: 'deny' } }, file: 'workspace.yaml' });
    expect(project.roles).toEqual({ clerk: { id: 'clerk', title: 'Clerk' }, boss: { id: 'boss', title: 'Boss' } });
    // Entities by key; the same name in two domains is two entity types.
    expect(Object.keys(project.entities).sort()).toEqual(['ops.Account', 'sales.Account', 'sales.Order']);
    expect(project.entities['ops.Account']!.domain).toBe('ops');
    expect(project.workflows.onboard!.domain).toBe('sales');
    expect(project.workflows['ops-setup']!.domain).toBe('ops');
    // No domain/ and no workflows/: no default domain.
    expect(Object.keys(project.domains!).sort()).toEqual(['ops', 'sales']);
    expect(project.domains!.sales).toMatchObject({
      id: 'sales', name: 'Sales', owner: 'boss', intake: { address: 'sales' }, dir: 'domains/sales',
      entities: ['sales.Account', 'sales.Order'], workflows: ['onboard'], policy: { modelRoles: ['worker', 'verifier'] },
    });
    expect(project.domains!.ops).toMatchObject({ name: 'Operations', acceptsFrom: ['sales'] });
    expect(project.domainPolicy).toBeUndefined();
  });

  test('a transition without `by` gets [step, role:<domain owner>]', async () => {
    const { project } = await loadProject(makeMulti());
    const chart = project.entities['sales.Account']!.lifecycleChart!;
    expect(chart.transitions.won!.by).toEqual([{ kind: 'step' }, { kind: 'role', role: 'boss' }]);
    // Used in `on:` but never declared: the same default.
    expect(chart.transitions.lost).toEqual({ name: 'lost', by: [{ kind: 'step' }, { kind: 'role', role: 'boss' }] });
  });

  test('a record trigger without `with:` passes the record to the one Ref to it', async () => {
    const { project } = await loadProject(makeMulti());
    expect(project.workflows.onboard!.startsOn).toEqual([{ kind: 'entered', entity: 'Account', state: 'active', with: { account: 'record' } }]);
  });

  test('Phase 2-5 projects load as before, in the default domain', async () => {
    const { project, diagnostics } = await loadProject(SAMPLE);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.entities).sort()).toEqual(['Customer', 'Engagement']);
    expect(project.entities.Customer!.domain).toBe(DEFAULT_DOMAIN);
    expect(project.workspace).toBeUndefined();
    expect(Object.keys(project.domains!)).toEqual([DEFAULT_DOMAIN]);
    expect(project.domains!.domain).toMatchObject({ name: 'Main', dir: 'domain', entities: ['Customer', 'Engagement'], policy: project.domainPolicy });
    expect(project.domains!.domain!.workflows.sort()).toEqual(Object.keys(project.workflows).sort());
    for (const wf of Object.values(project.workflows)) expect(wf.domain).toBe(DEFAULT_DOMAIN);
    // The list form of a lifecycle also becomes a chart.
    const customer = project.entities.Customer!;
    expect(customer.lifecycle).toEqual(['prospect', 'active', 'dormant', 'closed']);
    expect(customer.lifecycleChart).toMatchObject({ initial: 'prospect', fromList: true });
    expect(customer.lifecycleChart!.states.prospect!.on).toEqual({ to_active: 'active', to_dormant: 'dormant', to_closed: 'closed' });
    expect(Object.keys(customer.lifecycleChart!.transitions).sort()).toEqual(['to_active', 'to_closed', 'to_dormant', 'to_prospect']);
  });

  test('a default domain beside other domains, with roles from both files', async () => {
    const root = makeMulti({
      'domain/roles.yaml': 'roles:\n  staff: Staff\n',
      'domain/domain.yaml': 'name: Client intake\n',
      'domain/entities/customer.yaml': 'entity: Customer\nfields:\n  name: Text\n',
      'workflows/hello/workflow.yaml': 'workflow: hello\nversion: 1\nstart: a\nsteps:\n  a: { on: { done: end }, wait: { timeout: 1d -> end } }\n',
      'workflows/hello/case.yaml': 'case: hello\nfields:\n  customer: Ref<Customer>\n',
    });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.roles).sort()).toEqual(['boss', 'clerk', 'staff']);
    expect(project.domains!.domain).toMatchObject({ name: 'Client intake', entities: ['Customer'], workflows: ['hello'] });
    expect(project.entities.Customer!.domain).toBe('domain');
    expect(project.workflows.hello!.domain).toBe('domain');
  });

  test('duplicate-role: a role in workspace.yaml and domain/roles.yaml', async () => {
    const { diagnostics } = await loadProject(makeMulti({ 'domain/roles.yaml': 'roles:\n  boss: Boss\n' }));
    expect(diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'duplicate-role', file: 'domain/roles.yaml', line: 2, path: 'roles.boss' })]);
  });

  test('invalid-domain-id, and `domain` is the default domain', async () => {
    const { project, diagnostics } = await loadProject(makeMulti({ 'domains/Bad-Name/domain.yaml': 'name: Bad\n', 'domains/domain/domain.yaml': 'name: Clash\n' }));
    expect(brief(diagnostics)).toEqual(['error invalid-domain-id domains/Bad-Name', 'error invalid-domain-id domains/domain']);
    expect(Object.keys(project.domains!).sort()).toEqual(['ops', 'sales']);
  });

  test('duplicate-entity within a domain; duplicate-workflow across domains', async () => {
    const { diagnostics } = await loadProject(makeMulti({
      'domains/sales/entities/account2.yaml': 'entity: Account\nfields:\n  name: Text\n',
      'domains/ops/workflows/onboard/workflow.yaml': 'workflow: onboard\nversion: 1\nstart: a\nsteps:\n  a: { on: { done: end } }\n',
      'domains/ops/workflows/onboard/case.yaml': 'case: x\nfields: {}\n',
    }));
    expect(brief(diagnostics)).toEqual(['error duplicate-entity domains/sales/entities/account2.yaml', 'error duplicate-workflow domains/sales/workflows/onboard/workflow.yaml']);
  });

  test('bindings-per-domain-later and domain-id-mismatch', async () => {
    const root = makeMulti({ 'domains/sales/domain.yaml': 'domain: shop\nname: Sales\nowner: boss\nintake: { address: sales }\n' });
    mkdirSync(join(root, 'domains/ops/bindings'), { recursive: true });
    const { diagnostics } = await loadProject(root);
    expect(brief(diagnostics)).toEqual(['warning bindings-per-domain-later domains/ops/bindings', 'warning domain-id-mismatch domains/sales/domain.yaml domain']);
  });

  test('pages and views load into their domain', async () => {
    const { project, diagnostics } = await loadProject(makeMulti({
      'domains/sales/views/big.yaml': 'entity: Order\nfilter: "total > 1000"\nsort: [-placed, { field: total }]\ncolumns: [total, placed]\n',
      'domains/sales/pages/board.yaml': 'title: Sales board\nblocks:\n  - kpi: { label: Orders, value: { count: Order } }\n  - list: { view: big }\n',
    }));
    expect(diagnostics).toEqual([]);
    expect(project.domains!.sales!.views.big).toEqual({
      id: 'big', title: 'big', entity: 'Order', filter: 'total > 1000', sort: [{ field: 'placed', desc: true }, { field: 'total' }],
      columns: ['total', 'placed'], layout: 'table', file: 'domains/sales/views/big.yaml',
    });
    expect(project.domains!.sales!.pages.board!.blocks).toEqual([
      { kind: 'kpi', label: 'Orders', value: { count: 'Order' } },
      { kind: 'list', view: 'big' },
    ]);
  });
});

describe('entity files', () => {
  const ENTITY = `entity: Site
title: "{site_number} · {name}"
parent: study
fields:
  site_number: { type: Text, required: true, controlled: false }
  study: Ref<Study>
  other: Ref<edc.Site>
relationships:
  documents: many Document
  expected: { many: ExpectedDocument, via: site }
  sponsor: { one: Sponsor }
  remote: many edc.Visit
calculated:
  complete: { percent: expected, where: "status = 'filed'" }
  total:    { sum: documents, field: pages }
  days:     { formula: "days_since(activated_on)", description: Days open }
links:
  edc.Site: { match: [site_number], follow: [name, address] }
  ctms.Site: { match: { site_number: number } }
lifecycle:
  initial: selected
  states:
    selected:   { on: { picked: activating } }
    activating: { on: { approved: open }, after: { 60d: { remind: study_manager }, 90d: { transition: dropped } } }
    open: {}
  transitions:
    picked:   { by: [role:study_manager, "source:domain:edc"] }
    approved: { by: step, guard: "complete = 100%", signed: true }
invariants:
  - "status = 'open' implies site_number is set"
page:
  layout: split
  header: [title, status]
  left: [{ viewer: file }]
  right: [{ fields: [site_number, study] }, checks, { related: [documents] }, { chart: { kind: bar, of: documents, by: status } }]
  below: [mentions, notes]
`;

  test('parses title, parent, relationships, calculated fields, links, the statechart, invariants and the page', () => {
    const { value: e, diagnostics } = parseEntityFile(ENTITY, 'domains/etmf/entities/site.yaml');
    expect(diagnostics).toEqual([]);
    expect(e!.title).toBe('{site_number} · {name}');
    expect(e!.parent).toBe('study');
    expect(e!.fields.site_number!.controlled).toBe(false);
    expect(e!.fields.other!.type).toEqual({ kind: 'ref', entity: 'edc.Site' });
    expect(e!.relationships).toEqual({
      documents: { cardinality: 'many', target: 'Document' },
      expected: { cardinality: 'many', target: 'ExpectedDocument', via: 'site' },
      sponsor: { cardinality: 'one', target: 'Sponsor' },
      remote: { cardinality: 'many', target: 'edc.Visit' },
    });
    expect(e!.calculated).toEqual({
      complete: { kind: 'rollup', rollup: 'percent', of: 'expected', where: "status = 'filed'" },
      total: { kind: 'rollup', rollup: 'sum', of: 'documents', field: 'pages' },
      days: { kind: 'formula', formula: 'days_since(activated_on)', description: 'Days open' },
    });
    expect(e!.links).toEqual({
      'edc.Site': { target: 'edc.Site', match: { site_number: 'site_number' }, follow: ['name', 'address'] },
      'ctms.Site': { target: 'ctms.Site', match: { site_number: 'number' }, follow: [] },
    });
    expect(e!.lifecycle).toEqual(['selected', 'activating', 'open']);
    expect(e!.lifecycleChart).toEqual({
      initial: 'selected',
      states: {
        selected: { name: 'selected', on: { picked: 'activating' } },
        activating: { name: 'activating', on: { approved: 'open' }, after: [{ afterMs: 60 * 86_400_000, remind: 'study_manager' }, { afterMs: 90 * 86_400_000, transition: 'dropped' }] },
        open: { name: 'open', on: {} },
      },
      transitions: {
        picked: { name: 'picked', by: [{ kind: 'role', role: 'study_manager' }, { kind: 'source', source: 'domain:edc' }] },
        approved: { name: 'approved', by: [{ kind: 'step' }], guard: 'complete = 100%', signed: true },
      },
    });
    expect(e!.invariants).toEqual(["status = 'open' implies site_number is set"]);
    expect(e!.page).toEqual({
      layout: 'split',
      header: ['title', 'status'],
      areas: {
        // `details` was left out, so it goes at the end of the first area.
        left: [{ kind: 'viewer', field: 'file' }, { kind: 'details' }],
        right: [{ kind: 'fields', fields: ['site_number', 'study'] }, { kind: 'checks' }, { kind: 'related', relationships: ['documents'] }, { kind: 'chart', chart: 'bar', of: 'documents', by: 'status' }],
        below: [{ kind: 'mentions' }, { kind: 'notes' }],
      },
    });
  });

  test('unknown-page-block, page-area-not-in-layout, and bad timers and actors', () => {
    const { diagnostics } = parseEntityFile(`entity: X
fields: { a: Text }
lifecycle:
  initial: a
  states:
    a: { on: { go: b }, after: { soon: { remind: x }, 1d: {} } }
    b: {}
  transitions:
    go: { by: [anyone] }
page:
  layout: single
  main: [details, sparkle, { gallery: [a] }]
  left: [notes]
`, 'x.yaml');
    expect(brief(diagnostics)).toEqual([
      'error invalid-format x.yaml lifecycle.states.a.after.soon',
      'error invalid-format x.yaml lifecycle.states.a.after.1d',
      'error invalid-format x.yaml lifecycle.transitions.go.by.0',
      'error unknown-page-block x.yaml page.main.1',
      'error unknown-page-block x.yaml page.main.2',
      'error page-area-not-in-layout x.yaml page.left',
    ]);
  });

  test('defaultPageLayout: single, title and status, every field, lifecycle, related, cases, notes, mentions, history', () => {
    const { value } = parseEntityFile('entity: A\nfields:\n  x: Text\n  y: Date\nrelationships:\n  bs: many B\n  c: one C\nlifecycle: [new, done]\n', 'a.yaml');
    expect(value!.page).toBeUndefined();
    expect(defaultPageLayout(value!)).toEqual({
      layout: 'single', header: ['title', 'status'], isDefault: true,
      areas: { main: [
        { kind: 'fields', fields: ['x', 'y'] }, { kind: 'details' }, { kind: 'lifecycle' }, { kind: 'related', relationships: ['bs'] },
        { kind: 'cases' }, { kind: 'notes' }, { kind: 'mentions' }, { kind: 'history' },
      ] },
    });
  });

  test('retention durations in years, and Ref to another domain\'s entity', () => {
    expect(parseDuration('25y')).toBe(25 * 365 * 86_400_000);
    expect(parseValueType('Ref<edc.Site>')).toEqual({ kind: 'ref', entity: 'edc.Site' });
    expect(parseValueType('Ref<edc.Site.x>')).toBeUndefined();
  });
});

describe('workflow files: triggers and block states', () => {
  const SHAPE = `workflow: w
version: 1
start: a
starts_on:
  - entered: Site.activating
    with: { site: record }
  - created: Document
  - changed: { entity: Site, fields: [status, name] }
    as: boss
  - changed: Site
  - before: { field: Person.cv_expires, by: 30d }
    with: { person: record }
  - after: { field: etmf.Site.activated_on, by: 1w }
  - every: 2w
    at: "06:00"
    on: monday
  - message: { address: etmf }
    with: { sender: message.from, docs: message.attachments, count: 3 }
steps:
  a:
    start: { workflow: other, with: { document: case.document, note: "Hello", n: 2 } }
    on: { started: b }
  b:
    call: { workflow: child, with: { x: case.x.y }, returns: { filed_id: case.document } }
    on: { filed: c, failed: c }
  c:
    for_each: { items: case.sites, as: site, call: { workflow: child, with: { site: item, name: item.name } }, join: 2 }
    on: { done: d }
  d:
    for_each: { items: case.sites, start: { workflow: child } }
    on: { started: e }
  e:
    wait_until: { record: case.site, condition: "start_up_pack_complete = 100%" }
    on: { met: end }
    wait: { remind: 7d, timeout: 60d → end }
`;

  test('parses every trigger kind', () => {
    const { value, diagnostics } = parseWorkflowFile(SHAPE, 'w.yaml');
    expect(diagnostics).toEqual([]);
    expect(value!.startsOn).toEqual([
      { kind: 'entered', entity: 'Site', state: 'activating', with: { site: 'record' } },
      { kind: 'created', entity: 'Document', with: {} },
      { kind: 'changed', entity: 'Site', fields: ['status', 'name'], with: {}, as: 'boss' },
      { kind: 'changed', entity: 'Site', with: {} },
      { kind: 'date', entity: 'Person', field: 'cv_expires', direction: 'before', offsetMs: 30 * 86_400_000, with: { person: 'record' } },
      { kind: 'date', entity: 'etmf.Site', field: 'activated_on', direction: 'after', offsetMs: 7 * 86_400_000, with: {} },
      { kind: 'every', everyMs: 14 * 86_400_000, at: '06:00', on: 'monday', with: {} },
      { kind: 'message', address: 'etmf', with: { sender: 'message.from', docs: 'message.attachments', count: '3' } },
    ]);
  });

  test('parses the four blocks', () => {
    const { value } = parseWorkflowFile(SHAPE, 'w.yaml');
    const s = value!.states;
    expect(s.a!.block).toEqual({ kind: 'start', workflow: 'other', with: { document: { case: 'document' }, note: { value: 'Hello' }, n: { value: 2 } } });
    expect(s.b!.block).toEqual({ kind: 'call', workflow: 'child', with: { x: { case: 'x.y' } }, returns: { filed_id: 'document' } });
    expect(s.c!.block).toEqual({ kind: 'for_each', items: 'sites', as: 'site', mode: 'call', workflow: 'child', with: { site: { item: '' }, name: { item: 'name' } }, join: 2 });
    expect(s.d!.block).toEqual({ kind: 'for_each', items: 'sites', mode: 'start', workflow: 'child', with: {}, join: 'all' });
    expect(s.e!.block).toEqual({ kind: 'wait_until', record: 'site', condition: 'start_up_pack_complete = 100%' });
    expect(s.e!.wait).toEqual({ remindMs: 7 * 86_400_000, timeout: { afterMs: 60 * 86_400_000, target: 'end' } });
    expect(handoffArg('record')).toEqual({ record: true });
    expect(handoffArg({ value: 'case.x' })).toEqual({ value: 'case.x' });
  });

  test('invalid-trigger and several-blocks', () => {
    const { diagnostics } = parseWorkflowFile(`workflow: w
version: 1
start: a
starts_on:
  - entered: Site.open
    created: Site
  - with: { a: record }
steps:
  a:
    start: { workflow: x }
    call: { workflow: y }
    on: { started: end }
`, 'w.yaml');
    expect(brief(diagnostics)).toEqual(['error several-blocks w.yaml steps.a', 'error invalid-trigger w.yaml starts_on.0', 'error invalid-trigger w.yaml starts_on.1']);
  });

  test('a workflow without Phase 6 keys parses as before', () => {
    const { value } = parseWorkflowFile('workflow: w\nversion: 1\nstart: a\nsteps:\n  a: { on: { done: end } }\n', 'w.yaml');
    expect(value).toEqual({ id: 'w', version: 1, start: 'a', states: { a: { name: 'a', on: { done: 'end' } } } });
  });
});

describe('step, example, page and view files', () => {
  test('sign: and review:', () => {
    const step = (front: string) => parseStepFile(`---\ntitle: QC\nperformer: person\nassignee: x\noutcomes: [approved]\n${front}---\nCheck it.\n`, 's.md');
    expect(step('sign: "Reviewed and approved for filing"\nreview: { kind: document, record: case.document }\n').value).toMatchObject({
      sign: 'Reviewed and approved for filing', review: { kind: 'document', record: 'document' },
    });
    expect(step('review: document\n').value!.review).toEqual({ kind: 'document', record: '' });
    expect(step('review: { kind: table, items: case.rows }\n').value!.review).toEqual({ kind: 'table', items: 'rows' });
    expect(step('review: diff\n').value!.review).toEqual({ kind: 'diff' });
    expect(step('').value!.review).toBeUndefined();
  });

  test('records: in an example case', () => {
    const { value, diagnostics } = parseExampleFile('case: {}\nrecords:\n  Site:\n    - { id: site_1, site_number: US-012, status: activating }\n  edc.Site: []\nexpect: {}\n', 'e.yaml');
    expect(diagnostics).toEqual([]);
    expect(value!.records).toEqual({ Site: [{ id: 'site_1', site_number: 'US-012', status: 'activating' }], 'edc.Site': [] });
  });

  test('a dashboard: kpis, tables, lists, heatmaps and text; unknown blocks', () => {
    const { value, diagnostics } = parsePageFile(`title: Health
under: Study
params: { study: Ref<Study> }
blocks:
  - kpi: { label: Complete, value: { percent: ExpectedDocument, where: "status = 'filed'", of: "study = params.study" }, target: 95 }
  - kpi: { label: Pages, value: { sum: Document, field: pages } }
  - table: { title: Missing, view: missing }
  - list: { view: { entity: Document, filter: "status = 'in_qc'", sort: [-received_at] } }
  - heatmap: { rows: { entity: Site }, columns: [{ label: Start-up, value: start_up_pack_complete }] }
  - text: Hello
  - sparkline: { of: x }
  - kpi: { label: Broken }
`, 'domains/etmf/pages/health.yaml');
    expect(brief(diagnostics)).toEqual([
      'error unknown-page-block domains/etmf/pages/health.yaml blocks.6',
      'error invalid-format domains/etmf/pages/health.yaml blocks.7.kpi.value',
    ]);
    expect(value).toMatchObject({ id: 'health', title: 'Health', under: { entity: 'Study' }, params: { study: 'Ref<Study>' } });
    expect(value!.blocks).toEqual([
      { kind: 'kpi', label: 'Complete', value: { percent: 'ExpectedDocument', where: "status = 'filed'", of: 'study = params.study' }, target: 95, format: 'percent' },
      { kind: 'kpi', label: 'Pages', value: { sum: 'Document', field: 'pages' } },
      { kind: 'table', title: 'Missing', view: 'missing' },
      { kind: 'list', view: { entity: 'Document', filter: "status = 'in_qc'", sort: [{ field: 'received_at', desc: true }], layout: 'table' } },
      { kind: 'heatmap', rows: { entity: 'Site' }, columns: [{ label: 'Start-up', value: 'start_up_pack_complete' }] },
      { kind: 'text', markdown: 'Hello' },
    ]);
  });

  test('a view: board layout, id from the file name', () => {
    const { value } = parseViewFile('title: Sites by status\nentity: Site\nlayout: board\n', 'domains/etmf/views/sites-board.yaml');
    expect(value).toEqual({ id: 'sites-board', title: 'Sites by status', entity: 'Site', layout: 'board', file: 'domains/etmf/views/sites-board.yaml' });
  });

  test('workspace.yaml: the name defaults to the folder', () => {
    const { value } = parseWorkspaceFile('roles:\n  a: A\n', 'workspace.yaml', 'my-firm');
    expect(value!.workspace).toEqual({ name: 'my-firm', file: 'workspace.yaml' });
    expect(value!.roles).toEqual({ a: { id: 'a', title: 'A' } });
  });
});

describe('entity tools', () => {
  test('`<domain>.<snake>.<verb>`, with their effect classes', () => {
    expect(entityToolNames({ entity: 'ExpectedDocument', domain: 'etmf' })).toEqual({
      create: 'etmf.expected_document.create', get: 'etmf.expected_document.get', update: 'etmf.expected_document.update',
      transition: 'etmf.expected_document.transition', list: 'etmf.expected_document.list',
    });
    expect(entityToolNames('Customer').create).toBe('domain.customer.create');
    const tools = entityTools({ 'etmf.Site': { entity: 'Site', domain: 'etmf' } });
    expect(Object.fromEntries(Object.entries(tools).map(([n, t]) => [n, t.effect]))).toEqual({
      'etmf.site.create': 'write', 'etmf.site.get': 'read', 'etmf.site.update': 'write', 'etmf.site.transition': 'write', 'etmf.site.list': 'read',
    });
    expect(tools['etmf.site.list']).toEqual({ effect: 'read', entity: 'etmf.Site', verb: 'list' });
  });

  test('checkProject counts them as bound', async () => {
    const root = makeMulti({
      'domains/sales/workflows/onboard/steps/welcome.md': '---\ntitle: Welcome\nperformer: agent\nmodel: worker\nreads: [case.account]\nwrites:\n  note: Text\ntools:\n  allowed: [sales.account.get, sales.order.list, sales.nothing.get]\noutcomes: [done]\n---\nLook.\n',
    });
    const { project } = await loadProject(root);
    expect(brief(checkProject(project, { tools: {} }))).toEqual(['error unknown-tool domains/sales/workflows/onboard/steps/welcome.md tools.allowed.2']);
  });
});
