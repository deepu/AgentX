/**
 * Phase 6 files (24 §2, §6): `workspace.yaml`, `domain.yaml`, and a domain's free pages
 * (`pages/*.yaml`, dashboards) and shared views (`views/*.yaml`).
 */
import { basename } from 'node:path';
import type { DashboardBlock, DashboardChartDef, DashboardValue, DomainDef, DomainHomeDef, FreePageDef, ViewDef, WorkspaceDef } from './domain-types.ts';
import { dashboardBlockFormats, domainFormat, pageFormat, viewFormat, workspaceFormat } from './formats.ts';
import { toPolicyDoc } from './parse-policy.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, type ParseResult, type PathKey } from './source.ts';
import type { RoleDef } from './types.ts';
import { parseDuration } from './value-types.ts';

const idOf = (file: string) => basename(file).replace(/\.ya?ml$/, '');

/** Reads a YAML file that must be a map; `what` names the keys for the message when it isn't. */
function readMap(text: string, file: string, what: string): { data?: Record<string, unknown>; report: Reporter; locate: ReturnType<typeof readYaml>['locate'] } {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (src.data === null || src.data === undefined) return { data: src.diagnostics.length ? undefined : {}, report, locate: src.locate };
  if (!isRecord(src.data)) {
    report.error('invalid-format', `expected ${what}`);
    return { report, locate: src.locate };
  }
  return { data: src.data, report, locate: src.locate };
}

/** `roles:` entries: `{ title, description }` or a bare title. */
function rolesOf(raw: unknown): Record<string, RoleDef> {
  const roles: Record<string, RoleDef> = {};
  for (const [id, spec] of Object.entries(asRecord(raw))) {
    if (typeof spec === 'string') roles[id] = { id, title: spec };
    else if (isRecord(spec)) roles[id] = compact({ id, title: asString(spec.title) ?? id, description: asString(spec.description) });
  }
  return roles;
}

/** `workspace.yaml`. `folderName` names the workspace when the file doesn't. */
export function parseWorkspaceFile(text: string, file: string, folderName = 'Workspace'): ParseResult<{ workspace: WorkspaceDef; roles: Record<string, RoleDef> }> {
  const { data, report, locate } = readMap(text, file, 'a workspace: workspace, roles, policy');
  if (!data) return { diagnostics: report.diagnostics };
  report.validate(workspaceFormat, data);
  const workspace: WorkspaceDef = compact({
    name: asString(data.workspace) ?? folderName,
    policy: isRecord(data.policy) ? toPolicyDoc(data.policy, file) : undefined,
    stormLimit: typeof data.storm_limit === 'number' && data.storm_limit > 0 ? Math.floor(data.storm_limit) : undefined,
    file,
  });
  rememberLocator(workspace, locate);
  const roles = rolesOf(data.roles);
  rememberLocator(roles, (path) => locate(['roles', ...path]));
  return { value: { workspace, roles }, diagnostics: report.diagnostics };
}

/**
 * `domain.yaml` for the domain `id` in folder `dir`. Entities, workflows, pages, views and the
 * policy are filled in by the loader.
 */
export function parseDomainFile(text: string, file: string, id: string, dir: string): ParseResult<DomainDef> {
  const { data, report, locate } = readMap(text, file, 'a domain: domain, name, owner, regulated, retention, accepts_from, intake, home, pages');
  if (!data) return { diagnostics: report.diagnostics };
  report.validate(domainFormat, data);
  const written = asString(data.domain);
  if (written !== undefined && written !== id) {
    report.warn('domain-id-mismatch', `the domain id \`${written}\` differs from its folder name \`${id}\`; the folder name is used`, ['domain']);
  }
  const retention = data.retention;
  const value: DomainDef = compact({
    id,
    name: asString(data.name) ?? defaultDomainName(id),
    description: asString(data.description),
    owner: asString(data.owner),
    regulated: typeof data.regulated === 'boolean' ? data.regulated : undefined,
    retentionMs: typeof retention === 'string' || typeof retention === 'number' ? parseDuration(retention) : undefined,
    acceptsFrom: Array.isArray(data.accepts_from) ? asStrings(data.accepts_from) : undefined,
    intake: isRecord(data.intake) && typeof data.intake.address === 'string' ? { address: data.intake.address.trim() } : undefined,
    home: homeOf(data.home),
    pageRules: isRecord(data.pages) ? compact({ refresh: asString(data.pages.refresh), reviewer: asString(data.pages.reviewer), every: asString(data.pages.every) }) : undefined,
    dir,
    entities: [],
    workflows: [],
    pages: {},
    views: {},
    file,
  });
  rememberLocator(value, locate);
  return { value, diagnostics: report.diagnostics };
}

function homeOf(raw: unknown): DomainHomeDef | undefined {
  if (!isRecord(raw)) return undefined;
  // A draft record needs both; without an entity, a question makes a draft page (26 §4).
  if (typeof raw.entity === 'string' && typeof raw.question !== 'string') return undefined;
  return compact({
    ask: asString(raw.ask),
    placeholder: asString(raw.placeholder),
    entity: asString(raw.entity),
    question: asString(raw.question),
    name: asString(raw.name),
    page: asString(raw.page),
    suggested: Array.isArray(raw.suggested) ? asStrings(raw.suggested) : [],
  });
}

/** A domain's display name when `domain.yaml` gives none: "Main" for the default domain, else the id. */
export const defaultDomainName = (id: string): string => (id === 'domain' ? 'Main' : id);

/** `sort:` entries: `field`, `-field`, or `{ field, desc }`. */
function sortOf(raw: unknown): ViewDef['sort'] {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((s) => {
    if (typeof s === 'string') {
      const t = s.trim();
      return t.startsWith('-') ? [{ field: t.slice(1).trim(), desc: true }] : [{ field: t }];
    }
    if (isRecord(s) && typeof s.field === 'string') return [compact({ field: s.field, desc: s.desc === true ? true : undefined })];
    return [];
  });
}

/** A view as written in a file or inline in a dashboard block (without id and title). */
function viewBody(v: Record<string, unknown>): Omit<ViewDef, 'id' | 'title'> {
  return compact({
    entity: asString(v.entity) ?? '',
    filter: asString(v.filter),
    sort: sortOf(v.sort),
    group: asString(v.group),
    columns: Array.isArray(v.columns) ? asStrings(v.columns) : undefined,
    layout: v.layout === 'board' ? 'board' as const : 'table' as const,
  });
}

/** `views/<id>.yaml`. */
export function parseViewFile(text: string, file: string): ParseResult<ViewDef> {
  const { data, report, locate } = readMap(text, file, 'a view: entity, filter, sort, group, columns, layout');
  if (!data) return { diagnostics: report.diagnostics };
  report.validate(viewFormat, data);
  const id = asString(data.view) ?? idOf(file);
  const value: ViewDef = compact({ id, title: asString(data.title) ?? id, ...viewBody(data), file });
  rememberLocator(value, locate);
  return { value, diagnostics: report.diagnostics };
}

const VALUE_KINDS = ['count', 'percent', 'sum', 'avg'] as const;

export function dashboardValue(raw: Record<string, unknown>): DashboardValue | undefined {
  const kind = VALUE_KINDS.find((k) => typeof raw[k] === 'string');
  if (!kind) return undefined;
  const entity = (raw[kind] as string).trim();
  const where = asString(raw.where);
  switch (kind) {
    case 'count': return compact({ count: entity, where });
    case 'percent': return where === undefined ? undefined : compact({ percent: entity, where, of: asString(raw.of) });
    case 'sum': return typeof raw.field === 'string' ? compact({ sum: entity, field: raw.field, where }) : undefined;
    case 'avg': return typeof raw.field === 'string' ? compact({ avg: entity, field: raw.field, where }) : undefined;
  }
}

const BLOCK_KINDS = Object.keys(dashboardBlockFormats) as (keyof typeof dashboardBlockFormats)[];

function parseDashboardBlock(raw: unknown, report: Reporter, path: PathKey[]): DashboardBlock | undefined {
  const keys = isRecord(raw) ? Object.keys(raw) : [];
  const kind = keys.length === 1 ? BLOCK_KINDS.find((k) => k === keys[0]) : undefined;
  if (!kind) {
    report.error('unknown-page-block', `\`${keys.join(', ') || String(raw)}\` is not a dashboard block: expected one of ${BLOCK_KINDS.join(', ')}`, path);
    return undefined;
  }
  const v = (raw as Record<string, unknown>)[kind];
  const ok = dashboardBlockFormats[kind].safeParse(v);
  if (!ok.success) {
    for (const issue of ok.error.issues) {
      const sub = issue.path.filter((k): k is PathKey => typeof k !== 'symbol');
      if (issue.code === 'unrecognized_keys') for (const key of issue.keys) report.warn('unknown-key', `unknown key \`${key}\``, [...path, kind, ...sub, key]);
      else report.error('invalid-format', `\`${[kind, ...sub].join('.')}\`: ${issue.message}`, [...path, kind, ...sub]);
    }
    if (ok.error.issues.some((i) => i.code !== 'unrecognized_keys')) return undefined;
  }
  const b = asRecord(v);
  const view = (x: unknown) => (typeof x === 'string' ? x : viewBody(asRecord(x)));
  switch (kind) {
    case 'kpi': {
      const value = dashboardValue(asRecord(b.value));
      if (!value) return undefined;
      const format: 'number' | 'percent' | undefined = b.format === 'percent' || b.format === 'number' ? b.format : 'percent' in value ? 'percent' : undefined;
      return compact({ kind, label: asString(b.label) ?? '', value, target: typeof b.target === 'number' ? b.target : undefined, format });
    }
    case 'table':
    case 'list':
      return compact({ kind, title: asString(b.title), view: view(b.view) });
    case 'heatmap': {
      const rows = asRecord(b.rows);
      return compact({
        kind, title: asString(b.title),
        rows: compact({ entity: asString(rows.entity) ?? '', where: asString(rows.where), label: asString(rows.label) }),
        columns: (Array.isArray(b.columns) ? b.columns : []).filter(isRecord).map((c) => ({ label: asString(c.label) ?? '', value: asString(c.value) ?? '' })),
      });
    }
    case 'text':
      return { kind, markdown: typeof v === 'string' ? v : '' };
    case 'chart': {
      // Literature (25 §5): counts per `by`, or an interval per record.
      const chart = b.kind as DashboardChartDef['chart'];
      if (chart === 'interval' ? !(b.value && b.low && b.high) : !b.by) {
        report.error('invalid-format', chart === 'interval'
          ? '`chart`: an interval chart names its `value`, `low` and `high` fields (and a `label` template)'
          : `\`chart\`: a ${chart} chart counts records per value of a field: name it with \`by\``, [...path, kind]);
        return undefined;
      }
      const block: DashboardChartDef = { kind, chart, entity: asString(b.entity) ?? '' };
      for (const k of ['where', 'by', 'title', 'label', 'value', 'low', 'high', 'unit'] as const) if (typeof b[k] === 'string') block[k] = b[k] as string;
      return block;
    }
  }
}

/** `pages/<id>.yaml`: a dashboard. */
export function parsePageFile(text: string, file: string): ParseResult<FreePageDef> {
  const { data, report, locate } = readMap(text, file, 'a page: title, under, params, blocks');
  if (!data) return { diagnostics: report.diagnostics };
  report.validate(pageFormat, data);
  const id = asString(data.page) ?? idOf(file);
  const under = typeof data.under === 'string' ? { entity: data.under.trim() } : isRecord(data.under) && typeof data.under.entity === 'string' ? { entity: data.under.entity } : undefined;
  const params = Object.fromEntries(Object.entries(asRecord(data.params)).filter(([, t]) => typeof t === 'string').map(([k, t]) => [k, (t as string).trim()]));
  const blocks = (Array.isArray(data.blocks) ? data.blocks : [])
    .map((b, i) => parseDashboardBlock(b, report, ['blocks', i]))
    .filter((b): b is DashboardBlock => !!b);
  const value: FreePageDef = compact({ id, title: asString(data.title) ?? id, description: asString(data.description), under, params, blocks, file });
  rememberLocator(value, locate);
  return { value, diagnostics: report.diagnostics };
}
