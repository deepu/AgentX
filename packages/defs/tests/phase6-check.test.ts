// Phase 6 checks (24 §4-§11): one test (or more) per diagnostic code, on variants of the
// two-domain fixture, plus the condition checker and the eTMF example.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  callOutcomes, checkCondition, checkProject, entityConditionScope, entityTools, formats, handoffFields, indexProject, loadProject,
  relationshipInverse, scopedEntities, splitFrontMatter, type DefinitionRef, type IndexedDefinition,
} from '../src/index.ts';
import { brief, checkMulti, ETMF, MULTI } from './phase6-fixture.ts';

const ACCOUNT = 'domains/sales/entities/account.yaml';
const OPS_ACCOUNT = 'domains/ops/entities/account.yaml';
const ONBOARD = 'domains/sales/workflows/onboard/workflow.yaml';
const WELCOME = 'domains/sales/workflows/onboard/steps/welcome.md';
const SETUP = 'domains/ops/workflows/ops-setup/workflow.yaml';

/** MULTI's account.yaml with `find` replaced. */
const account = (find: string, replace: string) => ({ [ACCOUNT]: MULTI[ACCOUNT]!.replace(find, replace) });
/** MULTI's onboard workflow.yaml with `find` replaced. */
const onboard = (find: string, replace: string) => ({ [ONBOARD]: MULTI[ONBOARD]!.replace(find, replace) });

describe('the condition checker', () => {
  const scope = { total: 'number' as const, name: { kind: 'text' as const }, due: { kind: 'scalar' as const, name: 'Date' as const }, ok: 'boolean' as const, status: { kind: 'text' as const, values: ['open', 'shipped'] } };

  test('a good condition has no problems', () => {
    expect(checkCondition("total > 100 and status = 'open' and due <= today + 30d and ok", scope).problems).toEqual([]);
    expect(checkCondition('days_since(due) > 3 or due - today < 5', scope).problems).toEqual([]);
  });

  test('unknown names, with their position', () => {
    expect(checkCondition('totl > 1', scope).problems).toEqual([
      expect.objectContaining({ severity: 'error', code: 'unknown-field', pos: 0 }),
    ]);
    expect(checkCondition('total > 1 and params.study = name', scope, { params: { region: 'text' } }).problems).toEqual([
      expect.objectContaining({ code: 'unknown-field', pos: 14, message: expect.stringContaining('no parameter `study`') }),
    ]);
    expect(checkCondition('name = params.region', scope, { params: { region: 'text' } }).problems).toEqual([]);
  });

  test('type clashes: number against text, yes/no as a number, a number as a condition', () => {
    const codes = (src: string, opts = {}) => checkCondition(src, scope, opts).problems.map((p) => `${p.code} ${p.pos} ${p.message}`);
    expect(codes("total = 'many'")).toEqual(['invalid-condition 0 compares a number with text']);
    expect(codes('ok + 1 > 2')).toEqual(["invalid-condition 0 can't add a number to yes/no"]);
    expect(codes('total')).toEqual(['invalid-condition 0 this is a number, not a yes/no condition']);
    expect(codes('total * 2', { expect: 'any' })).toEqual([]);
    expect(codes('ok > true')).toEqual(['invalid-condition 0 yes/no values have no order: use = or !=']);
    expect(codes("lower(total) = 'x'")).toEqual(['invalid-condition 6 lower takes text; this is a number']);
    expect(codes('status = ')).toEqual(['invalid-condition 9 the condition ends too early']);
  });

  test('unknown-value: a literal a field never holds is a warning', () => {
    expect(checkCondition("status = 'shiped'", scope).problems).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'unknown-value', message: "'shiped' is never a value here (it is one of open, shipped)" }),
    ]);
    expect(checkCondition("status in ('open', 'lost')", scope).problems.map((p) => p.code)).toEqual(['unknown-value']);
  });

  test('an entity scope: fields, one relationships, calculated, followed fields, status, id and timestamps', async () => {
    const { project } = await loadProject(ETMF);
    const site = project.entities['etmf.Site']!;
    const scope = entityConditionScope(site, scopedEntities(project.entities, 'etmf'));
    expect(scope.start_up_pack_complete).toBe('number');
    expect(scope.name).toEqual({ kind: 'scalar', name: 'Text' });          // followed from edc.Site
    expect(scope.status).toEqual({ kind: 'text', values: ['selected', 'activating', 'open', 'closing', 'closed'] });
    expect(scope.days_open).toBe('number');
    expect(scope.created_at).toBe('datetime');
  });
});

describe('entity checks', () => {
  test('unknown-entity: a relationship or Ref to nothing', async () => {
    const ds = await checkMulti(account('  orders: many Order', '  orders: many Order\n  widgets: many Widget\n'));
    expect(ds).toEqual(['error unknown-entity domains/sales/entities/account.yaml relationships.widgets']);
    expect(await checkMulti({ 'domains/sales/entities/order.yaml': MULTI['domains/sales/entities/order.yaml']! + 'relationships:\n  boss: one ops.Nobody\n' }))
      .toEqual(['error unknown-entity domains/sales/entities/order.yaml relationships.boss']);
    // Another domain's entity by its key is fine.
    expect(await checkMulti({ 'domains/sales/entities/order.yaml': MULTI['domains/sales/entities/order.yaml']! + 'relationships:\n  ops_account: one ops.Account\n' })).toEqual([]);
  });

  test('ambiguous-inverse, and a `via` that points nowhere', async () => {
    const order = MULTI['domains/sales/entities/order.yaml']!.replace('  total: Number', '  total: Number\n  referrer: Ref<Account>');
    expect(await checkMulti({ 'domains/sales/entities/order.yaml': order })).toEqual([`error ambiguous-inverse ${ACCOUNT} relationships.orders`]);
    expect(await checkMulti({ 'domains/sales/entities/order.yaml': order, ...account('orders: many Order', 'orders: { many: Order, via: referrer }') })).toEqual([]);
    expect(await checkMulti(account('orders: many Order', 'orders: { many: Order, via: buyer }'))).toEqual([`error unknown-field ${ACCOUNT} relationships.orders.via`]);
    const lonely = MULTI['domains/sales/entities/order.yaml']!.replace('  account: Ref<Account>\n', '');
    expect(await checkMulti({ 'domains/sales/entities/order.yaml': lonely })).toEqual([`error ambiguous-inverse ${ACCOUNT} relationships.orders`]);
  });

  test('relationshipInverse finds the field pointing back', async () => {
    const { project } = await loadProject(ETMF);
    const site = project.entities['etmf.Site']!;
    const scoped = scopedEntities(project.entities, 'etmf');
    expect(relationshipInverse(site, site.relationships.documents!, scoped)).toMatchObject({ field: 'site', candidates: ['site'] });
    expect(relationshipInverse(site, site.relationships.expected_documents!, scoped).field).toBe('site');
  });

  test('unknown-field: title, parent, calculated, match, follow, page blocks', async () => {
    expect(await checkMulti(account('title: "{name} ({region})"', 'title: "{nam}"'))).toEqual([`error unknown-field ${ACCOUNT} title`]);
    expect(await checkMulti(account('fields:', 'parent: region\nfields:'))).toEqual([`error unknown-field ${ACCOUNT} parent`]);
    expect(await checkMulti(account('order_count: { count: orders }', 'order_count: { count: region }'))).toEqual([`error unknown-field ${ACCOUNT} calculated.order_count.count`]);
    expect(await checkMulti(account('order_count: { count: orders }', 'order_count: { sum: orders, field: weight }'))).toEqual([`error unknown-field ${ACCOUNT} calculated.order_count.field`]);
    expect(await checkMulti({ [OPS_ACCOUNT]: MULTI[OPS_ACCOUNT]!.replace('{ number: name }', '{ number: nam }') })).toEqual([`error unknown-field ${OPS_ACCOUNT} links.sales.Account.match`]);
    expect(await checkMulti({ [OPS_ACCOUNT]: MULTI[OPS_ACCOUNT]!.replace('follow: [region]', 'follow: [colour]') })).toEqual([`error unknown-field ${OPS_ACCOUNT} links.sales.Account.follow.0`]);
    const page = 'page:\n  layout: split\n  header: [title, status, nope]\n  left: [{ viewer: name }, { fields: [region, gone] }]\n  right: [{ related: [region] }, { chart: { kind: bar, of: orders, by: colour } }]\n';
    expect(await checkMulti({ [ACCOUNT]: MULTI[ACCOUNT]! + page })).toEqual([
      `error unknown-field ${ACCOUNT} page.header.2`,
      `error unknown-field ${ACCOUNT} page.left`,
      `error unknown-field ${ACCOUNT} page.left`,
      `error unknown-field ${ACCOUNT} page.right`,
      `error unknown-field ${ACCOUNT} page.right`,
    ]);
  });

  test('duplicate-field: a calculated field named like a field', async () => {
    expect(await checkMulti(account('order_count: { count: orders }', 'order_count: { count: orders }\n  name: { count: orders }'))).toEqual([`error duplicate-field ${ACCOUNT} calculated.name`]);
  });

  test('unknown-link and followed-field-clash', async () => {
    expect(await checkMulti({ [OPS_ACCOUNT]: MULTI[OPS_ACCOUNT]!.replace('sales.Account:', 'sales.Acount:') })).toEqual([`error unknown-link ${OPS_ACCOUNT} links.sales.Acount`]);
    expect(await checkMulti({ [OPS_ACCOUNT]: MULTI[OPS_ACCOUNT]!.replace('sales.Account:', 'ops.Account:') })).toEqual([`error unknown-link ${OPS_ACCOUNT} links.ops.Account`]);
    expect(await checkMulti({ [OPS_ACCOUNT]: MULTI[OPS_ACCOUNT]!.replace('  number: Text', '  number: Text\n  region: Text') }))
      .toEqual([`error followed-field-clash ${OPS_ACCOUNT} links.sales.Account.follow.0`]);
  });

  test('invalid-condition and unknown-field in guards, rollup filters, formulas and invariants', async () => {
    expect(await checkMulti(account('guard: "order_count > 0"', 'guard: "order_count > \'none\'"'))).toEqual([`error invalid-condition ${ACCOUNT} lifecycle.transitions.won.guard`]);
    expect(await checkMulti(account('guard: "order_count > 0"', 'guard: "orders_count > 0"'))).toEqual([`error unknown-field ${ACCOUNT} lifecycle.transitions.won.guard`]);
    expect(await checkMulti(account(`where: "status = 'shipped'"`, `where: "status = "`))).toEqual([`error invalid-condition ${ACCOUNT} calculated.shipped.where`]);
    // A rollup's filter reads the related entity's fields, not this one's.
    expect(await checkMulti(account(`where: "status = 'shipped'"`, `where: "region = 'north'"`))).toEqual([`error unknown-field ${ACCOUNT} calculated.shipped.where`]);
    expect(await checkMulti(account('calculated:', 'calculated:\n  age: { formula: "days_since(name)" }'))).toEqual([`error invalid-condition ${ACCOUNT} calculated.age.formula`]);
    expect(await checkMulti({ [ACCOUNT]: MULTI[ACCOUNT]! + 'invariants:\n  - "vip implies regoin is set"\n' })).toEqual([`error unknown-field ${ACCOUNT} invariants.0`]);
    expect(await checkMulti({ [ACCOUNT]: MULTI[ACCOUNT]! + "invariants:\n  - \"status = 'gone' implies vip\"\n" })).toEqual([`warning unknown-value ${ACCOUNT} invariants.0`]);
  });

  test('lifecycle-unknown-state, unused-transition, unreachable-lifecycle-state, lifecycle-unknown-transition', async () => {
    expect(await checkMulti(account('initial: lead', 'initial: leed'))).toEqual([
      `error lifecycle-unknown-state ${ACCOUNT} lifecycle.initial`,
    ]);
    expect(await checkMulti(account('lost: lead', 'lost: gone'))).toEqual([`error lifecycle-unknown-state ${ACCOUNT} lifecycle.states.active.on.lost`]);
    expect(await checkMulti(account('    won: { guard: "order_count > 0" }', '    won: { guard: "order_count > 0" }\n    refund: {}'))).toEqual([`warning unused-transition ${ACCOUNT} lifecycle.transitions.refund`]);
    expect(await checkMulti(account('    active: { on: { lost: lead } }', '    active: { on: { lost: lead } }\n    archived: {}'))).toEqual([`warning unreachable-lifecycle-state ${ACCOUNT} lifecycle.states.archived`]);
    expect(await checkMulti(account('    active: { on: { lost: lead } }', '    active: { on: { lost: lead }, after: { 30d: { transition: won } } }'))).toEqual([`error lifecycle-unknown-transition ${ACCOUNT} lifecycle.states.active.after`]);
  });

  test('unknown-role and unknown-domain in transitions; signed-not-regulated', async () => {
    expect(await checkMulti(account('won: { guard: "order_count > 0" }', 'won: { by: [role:ghost, "source:domain:nowhere", source:crm], guard: "order_count > 0" }'))).toEqual([
      `error unknown-role ${ACCOUNT} lifecycle.transitions.won.by.0`,
      `error unknown-domain ${ACCOUNT} lifecycle.transitions.won.by.1`,
    ]);
    expect(await checkMulti(account('    active: { on: { lost: lead } }', '    active: { on: { lost: lead }, after: { 30d: { remind: ghost } } }'))).toEqual([`error unknown-role ${ACCOUNT} lifecycle.states.active.after`]);
    expect(await checkMulti(account('won: { guard: "order_count > 0" }', 'won: { guard: "order_count > 0", signed: true }'))).toEqual([`warning signed-not-regulated ${ACCOUNT} lifecycle.transitions.won.signed`]);
    expect(await checkMulti({
      ...account('won: { guard: "order_count > 0" }', 'won: { guard: "order_count > 0", signed: true }'),
      'domains/sales/domain.yaml': MULTI['domains/sales/domain.yaml']! + 'regulated: true\n',
    })).toEqual([]);
  });
});

describe('domain, view and page checks', () => {
  test('unknown-role owner, unknown-domain in accepts_from, duplicate-intake-address', async () => {
    expect(await checkMulti({ 'domains/sales/domain.yaml': 'name: Sales\nowner: ghost\nintake: { address: sales }\naccepts_from: [nowhere]\n' })).toEqual([
      'error unknown-role domains/sales/domain.yaml owner',
      'error unknown-domain domains/sales/domain.yaml accepts_from.0',
      // The transitions that leave out `by` default to the owner's role.
      `error unknown-role ${ACCOUNT} lifecycle.transitions.won.by.1`,
      `error unknown-role ${ACCOUNT} lifecycle.transitions.lost.by.1`,
    ]);
    expect(await checkMulti({ 'domains/ops/domain.yaml': 'name: Operations\naccepts_from: [sales]\nintake: { address: sales }\n' }))
      .toEqual(['error duplicate-intake-address domains/sales/domain.yaml intake.address']);
  });

  test('views: unknown-entity, unknown-field in the filter, sort, group and columns', async () => {
    expect(await checkMulti({ 'domains/sales/views/v.yaml': 'entity: Widget\n' })).toEqual(['error unknown-entity domains/sales/views/v.yaml entity']);
    expect(await checkMulti({ 'domains/sales/views/v.yaml': 'entity: Account\nfilter: "regoin = \'x\'"\nsort: [-opend]\ngroup: colour\ncolumns: [title, name, size]\n' })).toEqual([
      'error unknown-field domains/sales/views/v.yaml filter',
      'error unknown-field domains/sales/views/v.yaml sort.0',
      'error unknown-field domains/sales/views/v.yaml group',
      'error unknown-field domains/sales/views/v.yaml columns.2',
    ]);
    // Another domain's entity by its key, with its followed field.
    expect(await checkMulti({ 'domains/sales/views/v.yaml': 'entity: ops.Account\ncolumns: [number, region]\n' })).toEqual([]);
  });

  test('pages: unknown-view, unknown-entity, unknown-field, parameters', async () => {
    const page = `title: Board
under: Account
params: { account: Ref<Account>, other: Ref<Nope> }
blocks:
  - kpi: { label: A, value: { count: Order, where: "account = params.account" } }
  - kpi: { label: B, value: { count: Widget } }
  - kpi: { label: C, value: { sum: Order, field: weight, where: "account = params.acount" } }
  - table: { view: missing }
  - list: { view: { entity: Order, columns: [colour] } }
  - heatmap: { rows: { entity: Account }, columns: [{ label: Orders, value: order_count }, { label: X, value: nope }] }
`;
    expect(await checkMulti({ 'domains/sales/pages/board.yaml': page })).toEqual([
      'error unknown-entity domains/sales/pages/board.yaml params.other',
      'error unknown-entity domains/sales/pages/board.yaml blocks.1.kpi.value',
      'error unknown-field domains/sales/pages/board.yaml blocks.2.kpi.value.where',
      'error unknown-field domains/sales/pages/board.yaml blocks.2.kpi.value.field',
      'error unknown-view domains/sales/pages/board.yaml blocks.3.table.view',
      'error unknown-field domains/sales/pages/board.yaml blocks.4.list.view.columns.0',
      'error unknown-field domains/sales/pages/board.yaml blocks.5.heatmap.columns.1',
    ]);
  });
});

describe('trigger checks', () => {
  test('unknown-entity, unknown-state, unknown-field, date-trigger-not-date', async () => {
    expect(await checkMulti(onboard('  - entered: Account.active', '  - created: Widget'))).toEqual([`error unknown-entity ${ONBOARD} starts_on.0.created`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - entered: Account.gone'))).toEqual([`error unknown-state ${ONBOARD} starts_on.0.entered`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - changed: { entity: Account, fields: [regoin] }'))).toEqual([`error unknown-field ${ONBOARD} starts_on.0.changed.fields`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - before: { field: Account.name, by: 1d }'))).toEqual([`error date-trigger-not-date ${ONBOARD} starts_on.0.before.field`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - after: { field: Account.closed_on, by: 1d }'))).toEqual([`error unknown-field ${ONBOARD} starts_on.0.after.field`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - before: { field: Account.opened, by: 1d }'))).toEqual([]);
  });

  test('with: unknown-case-field, not-a-start-field, handoff-type-mismatch, invalid-trigger-value, unknown-message-field', async () => {
    expect(await checkMulti(onboard('  - entered: Account.active', '  - entered: Account.active\n    with: { account: record, nope: x }'))).toEqual([`error unknown-case-field ${ONBOARD} starts_on.0.with.nope`]);
    const agentWelcome = MULTI[WELCOME]!.replace('performer: person\nassignee: clerk', 'performer: agent\nmodel: worker');
    expect(await checkMulti({ [WELCOME]: agentWelcome, ...onboard('  - entered: Account.active', '  - entered: Account.active\n    with: { account: record, note: hi }') }))
      .toEqual([`error not-a-start-field ${ONBOARD} starts_on.0.with.note`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - entered: Account.active\n    with: { note: record }'))).toEqual([`error handoff-type-mismatch ${ONBOARD} starts_on.0.with.note`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - every: 1d\n    with: { account: record }'))).toEqual([`error invalid-trigger-value ${ONBOARD} starts_on.0.with.account`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - entered: Account.active\n    with: { account: record, note: message.subject }'))).toEqual([`error invalid-trigger-value ${ONBOARD} starts_on.0.with.note`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - message: { address: sales }\n    with: { note: message.body }'))).toEqual([`error unknown-message-field ${ONBOARD} starts_on.0.with.note`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - message: { address: sales }\n    with: { note: message.text }'))).toEqual([]);
  });

  test('unknown-intake-address, unknown-role in as:, trigger-without-record, a bad weekday', async () => {
    expect(await checkMulti(onboard('  - entered: Account.active', '  - message: { address: shop }'))).toEqual([`error unknown-intake-address ${ONBOARD} starts_on.0.message.address`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - entered: Account.active\n    as: ghost'))).toEqual([`error unknown-role ${ONBOARD} starts_on.0.as`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - entered: Account.active\n    with: { note: welcome }'))).toEqual([`warning trigger-without-record ${ONBOARD} starts_on.0`]);
    expect(await checkMulti(onboard('  - entered: Account.active', '  - every: 1w\n    on: someday'))).toEqual([`error invalid-format ${ONBOARD} starts_on.0.on`]);
  });
});

describe('block checks', () => {
  const handOff = (block: string) => onboard('    start: { workflow: ops-setup, with: { account: case.account, note: case.note } }\n    on: { started: end }', block);

  test('unknown-workflow and cross-domain-not-allowed', async () => {
    expect(await checkMulti(handOff('    start: { workflow: nope }\n    on: { started: end }'))).toEqual([`error unknown-workflow ${ONBOARD} steps.hand_off.start.workflow`]);
    expect(await checkMulti({ 'domains/ops/domain.yaml': 'name: Operations\n' })).toEqual([`error cross-domain-not-allowed ${ONBOARD} steps.hand_off.start.workflow`]);
  });

  test('handoff-unknown-field, handoff-missing-field, handoff-type-mismatch, unknown-case-field, item-outside-for-each', async () => {
    expect(await checkMulti(handOff('    start: { workflow: ops-setup, with: { account: case.account, colour: case.note } }\n    on: { started: end }')))
      .toEqual([`error handoff-unknown-field ${ONBOARD} steps.hand_off.start.with.colour`]);
    expect(await checkMulti({
      'domains/ops/workflows/ops-setup/case.yaml': 'case: setup\nfields:\n  account: { type: Ref<sales.Account>, required: true }\n  note: Text\n',
      ...handOff('    start: { workflow: ops-setup, with: { note: case.note } }\n    on: { started: end }'),
    })).toEqual([`error handoff-missing-field ${ONBOARD} steps.hand_off.start.with`]);
    expect(await checkMulti(handOff('    start: { workflow: ops-setup, with: { account: case.note } }\n    on: { started: end }')))
      .toEqual([`error handoff-type-mismatch ${ONBOARD} steps.hand_off.start.with.account`]);
    expect(await checkMulti(handOff('    start: { workflow: ops-setup, with: { account: case.acount } }\n    on: { started: end }')))
      .toEqual([`error unknown-case-field ${ONBOARD} steps.hand_off.start.with.account`]);
    expect(await checkMulti(handOff('    start: { workflow: ops-setup, with: { account: item } }\n    on: { started: end }')))
      .toEqual([`error item-outside-for-each ${ONBOARD} steps.hand_off.start.with.account`]);
    // A literal is fine; so is a Ref named by key on one side and bare on the other.
    expect(await checkMulti(handOff('    start: { workflow: ops-setup, with: { note: "From sales" } }\n    on: { started: end }'))).toEqual([]);
  });

  test('for_each: for-each-not-list, and item typed as the list element', async () => {
    const withList = { 'domains/sales/workflows/onboard/case.yaml': 'case: onboarding\nfields:\n  account: Ref<Account>\n  note: Text\n  accounts: List<Ref<Account>>\n  notes: List<Text>\n' };
    expect(await checkMulti({ ...withList, ...handOff('    for_each: { items: case.note, start: { workflow: ops-setup, with: { account: item } } }\n    on: { started: end }') }))
      .toEqual([`error for-each-not-list ${ONBOARD} steps.hand_off.for_each.items`]);
    expect(await checkMulti({ ...withList, ...handOff('    for_each: { items: case.accounts, start: { workflow: ops-setup, with: { account: item } } }\n    on: { started: end }') })).toEqual([]);
    expect(await checkMulti({ ...withList, ...handOff('    for_each: { items: case.notes, start: { workflow: ops-setup, with: { account: item } } }\n    on: { started: end }') }))
      .toEqual([`error handoff-type-mismatch ${ONBOARD} steps.hand_off.for_each.start.with.account`]);
    expect(await checkMulti({ ...withList, ...handOff('    for_each: { items: case.accounts, call: { workflow: ops-setup, with: { account: item } } }\n    on: { done: end, failed: end }') })).toEqual([]);
  });

  test('unknown-block-event and block-event-without-transition', async () => {
    expect(await checkMulti(handOff('    start: { workflow: ops-setup }\n    on: { started: end, done: end }'))).toEqual([`error unknown-block-event ${ONBOARD} steps.hand_off.on.done`]);
    expect(await checkMulti(handOff('    start: { workflow: ops-setup }\n    on: { needs_person: end }'))).toEqual([`error block-event-without-transition ${ONBOARD} steps.hand_off.on`]);
    // call: the child's outcomes (the events into its `end`) and failed.
    expect(await checkMulti(handOff('    call: { workflow: ops-setup }\n    on: { done: end, failed: end }'))).toEqual([]);
    expect(await checkMulti(handOff('    call: { workflow: ops-setup }\n    on: { done: end, filed: end }'))).toEqual([
      `error unknown-block-event ${ONBOARD} steps.hand_off.on.filed`,
      `warning block-event-without-transition ${ONBOARD} steps.hand_off.on`,
    ]);
  });

  test('call: returns names fields of both cases', async () => {
    expect(await checkMulti(handOff('    call: { workflow: ops-setup, returns: { note: note } }\n    on: { done: end, failed: end }'))).toEqual([]);
    expect(await checkMulti(handOff('    call: { workflow: ops-setup, returns: { colour: shade } }\n    on: { done: end, failed: end }'))).toEqual([
      `error handoff-unknown-field ${ONBOARD} steps.hand_off.call.returns.colour`,
      `error handoff-unknown-field ${ONBOARD} steps.hand_off.call.returns.colour`,
    ]);
  });

  test('call-loop: A calls B calls A', async () => {
    const ds = await checkMulti({
      'domains/sales/domain.yaml': MULTI['domains/sales/domain.yaml']! + 'accepts_from: [ops]\n',
      ...handOff('    call: { workflow: ops-setup }\n    on: { done: end, failed: end }'),
      [SETUP]: 'workflow: ops-setup\nversion: 1\nstart: back\nsteps:\n  back:\n    call: { workflow: onboard }\n    on: { done: end, started: end, failed: end }\n',
    });
    expect(ds).toContain(`error call-loop ${ONBOARD} steps.hand_off`);
    expect(ds).toContain(`error call-loop ${SETUP} steps.back`);
  });

  test('wait_until: wait-record-not-ref, a condition checked against the record\'s entity', async () => {
    const wait = (block: string) => handOff(`    wait_until: ${block}\n    on: { met: end }\n    wait: { timeout: 7d -> end }`);
    expect(await checkMulti(wait('{ record: case.account, condition: "order_count > 2" }'))).toEqual([]);
    expect(await checkMulti(wait('{ record: case.note, condition: "order_count > 2" }'))).toEqual([`error wait-record-not-ref ${ONBOARD} steps.hand_off.wait_until.record`]);
    expect(await checkMulti(wait('{ record: case.account, condition: "orders > 2" }'))).toEqual([`error unknown-field ${ONBOARD} steps.hand_off.wait_until.condition`]);
    expect(await checkMulti(handOff('    wait_until: { record: case.account, condition: "vip" }\n    on: { met: end }'))).toEqual([`warning wait-without-timeout ${ONBOARD} steps.hand_off`]);
  });

  test('block-with-step', async () => {
    expect(await checkMulti({ 'domains/sales/workflows/onboard/steps/hand_off.md': '---\ntitle: X\nperformer: person\nassignee: clerk\noutcomes: [started]\n---\nX\n' }))
      .toContain(`error block-with-step ${ONBOARD} steps.hand_off`);
  });
});

describe('sign and review', () => {
  test('sign-on-non-person-step', async () => {
    const agent = MULTI[WELCOME]!.replace('performer: person\nassignee: clerk', 'performer: agent\nmodel: worker\nsign: Approved');
    expect(await checkMulti({ [WELCOME]: agent })).toEqual([`error sign-on-non-person-step ${WELCOME} sign`]);
    expect(await checkMulti({ [WELCOME]: MULTI[WELCOME]!.replace('outcomes: [done]', 'outcomes: [done]\nsign: Approved') })).toEqual([]);
  });

  test('review-record-not-ref and review-items-not-list', async () => {
    const review = (r: string, reads = '[case.account]') => ({ [WELCOME]: MULTI[WELCOME]!.replace('reads: [case.account]', `reads: ${reads}\nreview: ${r}`) });
    expect(await checkMulti(review('{ kind: document, record: case.account }'))).toEqual([]);
    expect(await checkMulti(review('document'))).toEqual([]); // the one Ref it reads
    expect(await checkMulti(review('document', '[case.note]'))).toEqual([`error review-record-not-ref ${WELCOME} review`]);
    expect(await checkMulti(review('{ kind: document, record: case.note }'))).toEqual([`error review-record-not-ref ${WELCOME} review.record`]);
    expect(await checkMulti(review('{ kind: table, items: case.note }'))).toEqual([`error review-items-not-list ${WELCOME} review.items`]);
  });
});

describe('example cases with records', () => {
  test('unknown-entity, example-unknown-field, example-invalid-value', async () => {
    const ex = 'case: {}\nrecords:\n  Widget: [{ a: 1 }]\n  Account:\n    - { id: acct_1, name: Acme, colour: red, status: lost }\n  Order:\n    - { account: acct_1, total: lots }\n  ops.Account:\n    - { number: A-1 }\nsubmit:\n  welcome: { outcome: done }\nexpect: { state: hand_off }\n';
    expect(await checkMulti({ 'domains/sales/workflows/onboard/examples/e.yaml': ex })).toEqual([
      'error unknown-entity domains/sales/workflows/onboard/examples/e.yaml records.Widget',
      'error example-unknown-field domains/sales/workflows/onboard/examples/e.yaml records.Account.0.colour',
      'error example-invalid-value domains/sales/workflows/onboard/examples/e.yaml records.Account.0.status',
      'error example-invalid-value domains/sales/workflows/onboard/examples/e.yaml records.Order.0.total',
    ]);
  });
});

describe('the eTMF example (examples/etmf)', () => {
  test('loads with no diagnostics and checks clean with only the entity tools bound', async () => {
    const { project, diagnostics } = await loadProject(ETMF);
    expect(diagnostics).toEqual([]);
    const tools = Object.fromEntries(Object.entries(entityTools(project.entities)).map(([n, t]) => [n, { effect: t.effect }]));
    expect(brief(checkProject(project, { tools }))).toEqual([]);
    expect(brief(checkProject(project, { tools: {} }))).toEqual([]);
  });

  test('two domains, a regulated one, its entities and playbooks', async () => {
    const { project } = await loadProject(ETMF);
    expect(project.workspace).toMatchObject({ name: 'Northlight CRO', policy: { effects: { outbound: 'approve', irreversible: 'deny' } } });
    expect(Object.keys(project.roles).sort()).toEqual(['cra', 'study_manager', 'tmf_specialist']);
    expect(Object.keys(project.domains!).sort()).toEqual(['edc', 'etmf']);
    expect(project.domains!.etmf).toMatchObject({ name: 'eTMF', regulated: true, retentionMs: 25 * 365 * 86_400_000, owner: 'study_manager', intake: { address: 'etmf' } });
    expect(project.domains!.etmf!.policy!.modelRoles).toEqual(expect.arrayContaining(['router', 'classifier', 'verifier']));
    expect(Object.keys(project.entities).sort()).toEqual(['edc.Site', 'etmf.Document', 'etmf.ExpectedDocument', 'etmf.Person', 'etmf.Site', 'etmf.Sponsor', 'etmf.Study']);
    expect(Object.keys(project.workflows).sort()).toEqual(['activate-site', 'file-document', 'fix-rejected-document', 'route-message', 'watch-expiries']);
    expect(Object.keys(project.domains!.etmf!.views).sort()).toEqual(['documents-in-qc', 'missing-documents', 'sites', 'sites-board']);
    expect(Object.keys(project.domains!.etmf!.pages)).toEqual(['tmf-health']);

    const site = project.entities['etmf.Site']!;
    expect(site.links!['edc.Site']).toEqual({ target: 'edc.Site', match: { site_number: 'site_number' }, follow: ['name', 'address', 'principal_investigator'] });
    expect(site.lifecycleChart!.transitions.approved).toEqual({ name: 'approved', by: [{ kind: 'step' }], guard: 'start_up_pack_complete = 100%' });
    expect(project.entities['etmf.Document']!.lifecycleChart!.transitions.file!.signed).toBe(true);

    const fd = project.workflows['file-document']!;
    expect(fd.steps.qc).toMatchObject({ performer: 'person', sign: 'Reviewed and approved for filing', review: { kind: 'document', record: 'document' } });
    expect(fd.states.start_fix!.block).toEqual({ kind: 'start', workflow: 'fix-rejected-document', with: { document: { case: 'document' }, note: { case: 'qc_comment' } } });
    expect(callOutcomes(fd).sort()).toEqual(['discarded', 'failed', 'filed', 'started']);
    expect(handoffFields(fd)).toEqual(['original', 'sender', 'received_at', 'qc_comment']);
    expect(project.workflows['activate-site']!.startsOn).toEqual([{ kind: 'entered', entity: 'Site', state: 'activating', with: { site: 'record' } }]);
    expect(project.workflows['watch-expiries']!.startsOn).toEqual([
      { kind: 'date', entity: 'Person', field: 'cv_expires', direction: 'before', offsetMs: 30 * 86_400_000, with: { person: 'record' }, as: 'tmf_specialist' },
    ]);
    // One model role per agent step, so the scripted provider plays each its own script.
    const agentRoles = Object.values(project.workflows).flatMap((w) => Object.values(w.steps)).filter((s) => s.performer === 'agent').map((s) => s.model);
    expect(agentRoles.sort()).toEqual(['classifier', 'router']);
    for (const wf of Object.values(project.workflows)) expect(wf.examples.length).toBeGreaterThan(0);
  });

  test('every file matches its format', () => {
    const y = (p: string) => parse(readFileSync(join(ETMF, p), 'utf8'));
    const cases: [keyof typeof formats, string][] = [
      ['workspace', 'workspace.yaml'], ['domain', 'domains/etmf/domain.yaml'], ['domain', 'domains/edc/domain.yaml'], ['policy', 'domains/etmf/policy.yaml'],
      ...['sponsor', 'study', 'site', 'person', 'document', 'expected_document'].map((e): [keyof typeof formats, string] => ['entity', `domains/etmf/entities/${e}.yaml`]),
      ['entity', 'domains/edc/entities/site.yaml'], ['page', 'domains/etmf/pages/tmf-health.yaml'],
      ...['sites', 'sites-board', 'missing-documents', 'documents-in-qc'].map((v): [keyof typeof formats, string] => ['view', `domains/etmf/views/${v}.yaml`]),
      ...['route-message', 'file-document', 'activate-site', 'watch-expiries', 'fix-rejected-document'].flatMap((w): [keyof typeof formats, string][] => [
        ['workflow', `domains/etmf/workflows/${w}/workflow.yaml`], ['case', `domains/etmf/workflows/${w}/case.yaml`],
      ]),
      ['example', 'domains/etmf/workflows/file-document/examples/files-a-pi-cv.yaml'],
    ];
    for (const [format, file] of cases) expect([file, formats[format].safeParse(y(file)).error]).toEqual([file, undefined]);
    const qc = parse(splitFrontMatter(readFileSync(join(ETMF, 'domains/etmf/workflows/file-document/steps/qc.md'), 'utf8'))!.yaml);
    expect(formats.step.safeParse(qc).error).toBeUndefined();
  });

  test('indexes entity types by key, domains, pages, views and per-domain policies', async () => {
    const { project } = await loadProject(ETMF);
    const defs: IndexedDefinition[] = [];
    const refs: DefinitionRef[] = [];
    await indexProject(project, { upsert: async (d, r) => { defs.push(...d); refs.push(...r); }, getWorkflow: async () => undefined, latestWorkflow: async () => undefined });
    const rows = defs.filter((d) => d.kind !== 'step' && d.kind !== 'case_type' && d.kind !== 'workflow').map((d) => `${d.kind} ${d.id}`).sort();
    expect(rows).toEqual([
      'domain edc', 'domain etmf',
      'entity_type edc.Site', 'entity_type etmf.Document', 'entity_type etmf.ExpectedDocument', 'entity_type etmf.Person',
      'entity_type etmf.Site', 'entity_type etmf.Sponsor', 'entity_type etmf.Study',
      'page etmf/tmf-health',
      'policy domain:etmf', 'policy workspace',
      'view etmf/documents-in-qc', 'view etmf/missing-documents', 'view etmf/sites', 'view etmf/sites-board',
    ]);
    const from = (id: string) => [...new Set(refs.filter((r) => r.fromId === id).map((r) => `${r.toKind} ${r.toId}`))].sort();
    expect(from('etmf.Site')).toEqual(['entity_type edc.Site', 'entity_type etmf.Document', 'entity_type etmf.ExpectedDocument', 'entity_type etmf.Person', 'entity_type etmf.Study']);
    expect(from('route-message')).toEqual(expect.arrayContaining(['policy domain:etmf', 'policy workspace', 'workflow file-document']));
    expect(from('activate-site')).toEqual(expect.arrayContaining(['entity_type etmf.Site']));
    expect(from('etmf/tmf-health')).toEqual(['entity_type etmf.Document', 'entity_type etmf.ExpectedDocument', 'entity_type etmf.Person', 'entity_type etmf.Site', 'entity_type etmf.Study']);
  });
});
