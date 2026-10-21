// Stage 3 review fixes, through a real kernel on a small two-app workspace written here and Postgres:
// the app's own project stays listed while it holds work from before (D107), a project id is never
// an app's, every app a new project runs is one its maker may make projects in, a change that
// leaves a project not checking is undone (and another project's broken file blocks nothing), and
// "Describe it" reuses only the caller's own draft.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import type { ToolContext } from '@memwise/gateway';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { CREATE_DRAFT_PROJECT_TOOL, projectTools } from '../src/projects/tools.ts';
import type { Actor, Kernel, PersonActor } from '../src/types.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const FILES: Record<string, string> = {
  'workspace.yaml': 'workspace: Corner Shop\nroles:\n  owner: { title: Owner }\n  clerk: { title: Clerk }\n',
  'domains/shop/domain.yaml': 'domain: shop\nname: Shop\nowner: owner\n',
  'domains/shop/app.yaml': 'title: Shop\nversion: 1\nnouns: { one: shop, many: shops }\n',
  'domains/shop/entities/order.yaml': 'entity: Order\ntitle: "{item}"\nfields:\n  item: { type: Text, required: true }\nlifecycle: [open, done]\n',
  'domains/shop/workflows/take-order/workflow.yaml': 'workflow: take-order\nversion: 1\ntitle: Take an order\nowner: owner\nstart: pack\nsteps:\n  pack: { on: { packed: end } }\n',
  'domains/shop/workflows/take-order/case.yaml': 'case: take_order\nfields:\n  item: { type: Text, required: true }\n',
  'domains/shop/workflows/take-order/steps/pack.md': '---\ntitle: Pack it\nperformer: person\nassignee: clerk\nreads: [case.item]\noutcomes: [packed]\n---\nPack the order.\n',
  'domains/stock/domain.yaml': 'domain: stock\nname: Stock\nowner: owner\n',
  'domains/stock/app.yaml': 'title: Stock\nversion: 1\n',
  'domains/stock/entities/item.yaml': 'entity: Item\ntitle: "{name}"\nfields:\n  name: { type: Text, required: true }\nlifecycle: [listed]\n',
};

let db: TestDatabase;
let kernel: Kernel;
let root: string;
const SYSTEM: Actor = { kind: 'system' };
const PEOPLE = [
  { email: 'pat@shop.example', name: 'Pat', roles: ['owner'] },
  { email: 'quinn@shop.example', name: 'Quinn', roles: ['owner'] },
];
const actor = async (email: string): Promise<PersonActor> => kernel.people.actorFor((await kernel.people.byEmail(email))!.id) as Promise<PersonActor>;
const shopProjects = async () => (await kernel.projects.apps(SYSTEM)).find((a) => a.id === 'shop')!.projects.map((p) => p.id).sort();

describe.skipIf(!pgAvailable)('Stage 3 review: projects kept safe', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mw-review-'));
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    db = await kernelDatabase('mw_rt_review');
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: root, tools: [], modelRoles: {}, providers: [],
      filesDir: mkdtempSync(join(tmpdir(), 'mw-review-files-')), logLevel: 'error',
    });
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test("D107: the app's own project stays listed while it holds records and runs from before projects", async () => {
    // Before any project: the shop is one project, the app's own.
    expect(await shopProjects()).toEqual(['shop']);
    const order = await kernel.records.create({ entity: 'shop.Order', values: { item: 'Tea' }, project: 'shop' }, SYSTEM);
    expect(order).toMatchObject({ applied: true });
    await kernel.startRun({ workflowId: 'take-order', case: { item: 'Tea' }, project: 'shop' });

    // The first project, still a draft: the shop's own project and its work stay in the lists.
    await kernel.projects.create({ app: 'shop', name: 'North', id: 'north', people: PEOPLE }, SYSTEM);
    expect((await kernel.project()).project.projects!.shop).toBeUndefined();
    expect(await shopProjects()).toEqual(['north', 'shop']);
    expect(await kernel.projects.get('shop', SYSTEM)).toMatchObject({ id: 'shop', implicit: true, status: 'active' });
    // Started, too; and on the app home with its counts.
    await kernel.projects.start('north', SYSTEM);
    expect(await shopProjects()).toEqual(['north', 'shop']);
    const home = await kernel.projects.home('shop', SYSTEM);
    expect(home.rows.map((r) => r.project).sort()).toEqual(['north', 'shop']);
    expect(home.totals).toMatchObject({ projects: 2, active: 2 });
    expect((await kernel.listCases({ project: 'shop' }, SYSTEM)).length).toBe(1);
    // The stock app's own project holds nothing: with no project of its own it is its one project.
    expect((await kernel.projects.apps(SYSTEM)).find((a) => a.id === 'stock')!.projects.map((p) => p.id)).toEqual(['stock']);
  }, 60_000);

  test("a project's id is never an app's", async () => {
    await expect(kernel.projects.create({ app: 'shop', name: 'Stock', id: 'stock' }, SYSTEM)).rejects.toThrow('is the id of an app');
    await expect(kernel.projects.create({ app: 'shop', name: 'Shop', id: 'shop' }, SYSTEM)).rejects.toThrow('is the id of an app');
    // Named like an app, it gets an id of its own.
    const p = await kernel.projects.create({ app: 'shop', name: 'Stock' }, SYSTEM);
    expect(p.id).toBe('stock-2');
    await kernel.projects.discard(p.id, SYSTEM);
  });

  test('every app a new project runs is one its maker may make projects in', async () => {
    const pat = await actor('pat@shop.example');
    // Pat is the Shop's owner (in North) and has no role in Stock.
    await expect(kernel.projects.create({ app: 'shop', name: 'Both', also: ['stock'] }, pat)).rejects.toThrow('only the Owner in Stock');
    expect((await kernel.project()).project.projects!.both).toBeUndefined();
    // A project running both apps, where Quinn is only a clerk: Quinn may not copy it either.
    await kernel.projects.create({
      app: 'shop', name: 'Both', id: 'both', also: ['stock'],
      people: [{ email: 'quinn@shop.example', name: 'Quinn', roles: ['clerk'] }],
    }, SYSTEM);
    const quinn = await actor('quinn@shop.example');
    await expect(kernel.projects.create({ name: 'Both again', copyFrom: 'both' }, quinn)).rejects.toThrow('only the Owner in Stock');
    // One app only is fine.
    const mine = await kernel.projects.create({ app: 'shop', name: 'Pop-up' }, pat);
    expect(mine.apps).toEqual(['shop']);
    await kernel.projects.discard(mine.id, await actor('pat@shop.example'));
  });

  test("a change that leaves the project not checking is undone; another project's broken file blocks nothing", async () => {
    const file = join(root, 'projects/north/project.yaml');
    const before = readFileSync(file, 'utf8');
    await expect(kernel.projects.update('north', { people: [{ email: 'pat@shop.example', roles: ['nope'] }] }, SYSTEM))
      .rejects.toThrow(/nothing was changed.*not a role/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await kernel.projects.get('north', SYSTEM))!.people.map((p) => p.email)).toEqual(['pat@shop.example', 'quinn@shop.example']);

    // Both's file breaks (by hand, say): North still changes.
    const both = join(root, 'projects/both/project.yaml');
    const good = readFileSync(both, 'utf8');
    writeFileSync(both, good.replace('app: shop', 'app: nowhere'));
    expect(await kernel.projects.update('north', { name: 'North Street' }, SYSTEM)).toMatchObject({ name: 'North Street' });
    writeFileSync(both, good);
    await kernel.index();
  });

  test('"Describe it" reuses only the draft the caller made, never someone else\'s of the same name', async () => {
    const tool = projectTools(() => kernel.projects, (id) => kernel.people.actorFor(id)).find((t) => t.name === CREATE_DRAFT_PROJECT_TOOL)!;
    const as = async (email: string) => ({ token: { onBehalfOf: (await kernel.people.byEmail(email))!.id } }) as unknown as ToolContext;
    const draft = (r: unknown) => (r as { project: string }).project;
    const pats = draft(await tool.execute({ app: 'shop', name: 'Market stall', template: undefined } as never, await as('pat@shop.example')));
    const quinns = draft(await tool.execute({ app: 'shop', name: 'Market stall' } as never, await as('quinn@shop.example')));
    expect(quinns).not.toBe(pats);
    // Pat's retried call finds Pat's own.
    expect(draft(await tool.execute({ app: 'shop', name: 'Market stall' } as never, await as('pat@shop.example')))).toBe(pats);
    const listed = (await kernel.projects.list(SYSTEM, { app: 'shop' })).filter((p) => p.name === 'Market stall');
    expect(listed.map((p) => p.createdBy).sort()).toEqual([(await kernel.people.byEmail('pat@shop.example'))!.id, (await kernel.people.byEmail('quinn@shop.example'))!.id].sort());
  });
});
