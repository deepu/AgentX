// Phase 6 fixtures: a small eTMF-like regulated domain `etmf`, an `edc` domain it links to,
// and one entity of the default domain. Written by hand (the loader is another piece's).
import type { CalculatedFieldDef, DomainDef, EntityTypeDef, FieldDef, LifecycleDef, StepToken, ValueType } from '@memwise/defs';
import type { Actor } from '../src/index.ts';

function valueType(src: string): ValueType {
  const ref = /^Ref<(.+)>$/.exec(src);
  if (ref) return { kind: 'ref', entity: ref[1]! };
  return { kind: 'scalar', name: src as 'Text' };
}

export function f(type: string, extra: Partial<FieldDef> = {}): FieldDef {
  return { type: valueType(type), typeSource: type, ...extra };
}

export function entity(domain: string, name: string, def: Partial<EntityTypeDef> = {}): EntityTypeDef {
  return { entity: name, domain, fields: {}, relationships: {}, file: `${domain}/entities/${name}.yaml`, hash: 'h', ...def };
}

const rollup = (r: Omit<Extract<CalculatedFieldDef, { kind: 'rollup' }>, 'kind'>): CalculatedFieldDef => ({ kind: 'rollup', ...r });
const formula = (formula: string): CalculatedFieldDef => ({ kind: 'formula', formula });

const siteChart: LifecycleDef = {
  initial: 'selected',
  states: {
    selected: { name: 'selected', on: { picked: 'activating' } },
    activating: { name: 'activating', on: { approved: 'open' } },
    open: { name: 'open', on: {} },
  },
  transitions: {
    picked: { name: 'picked', by: [{ kind: 'role', role: 'study_manager' }] },
    approved: { name: 'approved', by: [{ kind: 'step' }], guard: 'start_up_pack_complete = 100% and sponsor_approved' },
  },
};

export function fixtureEntities(): Record<string, EntityTypeDef> {
  const sponsor = entity('etmf', 'Sponsor', { fields: { name: f('Text') } });
  const study = entity('etmf', 'Study', {
    fields: { title: f('Text'), sponsor: f('Ref<Sponsor>') },
    relationships: { sites: { cardinality: 'many', target: 'Site' } },
    calculated: {
      sites_total: rollup({ rollup: 'count', of: 'sites' }),
      sites_ready: rollup({ rollup: 'count', of: 'sites', where: 'start_up_pack_complete = 100%' }),
    },
  });
  const site = entity('etmf', 'Site', {
    fields: {
      site_number: f('Text'), study: f('Ref<Study>'), sponsor: f('Ref<Sponsor>'), activated_on: f('Date'),
      sponsor_approved: f('Boolean'), budget: f('Number'),
    },
    relationships: {
      documents: { cardinality: 'many', target: 'Document' },
      expected_documents: { cardinality: 'many', target: 'ExpectedDocument', via: 'site' },
    },
    calculated: {
      start_up_pack_complete: rollup({ rollup: 'percent', of: 'expected_documents', where: "status = 'filed'" }),
      documents_filed: rollup({ rollup: 'count', of: 'documents', where: "status = 'filed'" }),
      pages_total: rollup({ rollup: 'sum', of: 'documents', field: 'pages' }),
      days_activating: formula('days_since(activated_on)'),
      filed_twice: formula('documents_filed * 2'),
    },
    links: { 'edc.Site': { target: 'edc.Site', match: { site_number: 'site_number' }, follow: ['name', 'principal_investigator'] } },
    lifecycle: ['selected', 'activating', 'open'],
    lifecycleChart: siteChart,
  });
  const document = entity('etmf', 'Document', {
    fields: {
      title: f('Text'), site: f('Ref<Site>'), version: f('Text'), pages: f('Number'), sponsor: f('Ref<Sponsor>'),
      reviewer_note: f('Text', { access: ['tmf_specialist'] }), tag: f('Text', { controlled: false }),
    },
    lifecycle: ['draft', 'filed'],
  });
  const expected = entity('etmf', 'ExpectedDocument', {
    fields: { artifact: f('Text'), site: f('Ref<Site>') },
    lifecycle: ['expected', 'filed'],
  });
  const edcSite = entity('edc', 'Site', {
    fields: { site_number: f('Text'), name: f('Text'), principal_investigator: f('PersonName', { access: ['cra'] }) },
  });
  const customer = entity('domain', 'Customer', { fields: { name: f('Text'), version: f('Text') }, lifecycle: ['prospect', 'active'] });
  return {
    'etmf.Sponsor': sponsor, 'etmf.Study': study, 'etmf.Site': site, 'etmf.Document': document,
    'etmf.ExpectedDocument': expected, 'edc.Site': edcSite, Customer: customer,
  };
}

function domain(id: string, extra: Partial<DomainDef> = {}): DomainDef {
  return { id, name: id, dir: `domains/${id}`, entities: [], workflows: [], pages: {}, views: {}, ...extra };
}

export const fixtureDomains = (): Record<string, DomainDef> => ({
  etmf: domain('etmf', { regulated: true, owner: 'study_manager' }),
  edc: domain('edc'),
  domain: domain('domain', { dir: 'domain', name: 'Main' }),
});

const at = '2026-10-20T10:00:00.000Z';
export function stepActor(caseId: string, stepRunId: string, stepId = 'file'): Actor {
  const token: StepToken = {
    runId: `run_${caseId}`, caseId, stepId, stepRunId, workflowId: 'file-document', workflowVersion: 1,
    agentRole: 'etmf.file', issuedAt: at, expiresAt: at,
  };
  return { kind: 'step', token };
}

export const person = (personId: string, roles: string[] = [], grants?: Extract<Actor, { kind: 'person' }>['grants']): Actor =>
  ({ kind: 'person', personId, roles, ...(grants ? { grants } : {}) });
