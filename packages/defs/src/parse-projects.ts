/**
 * Stage 3 files (26 §3, D93): `domains/<id>/app.yaml` and `projects/<id>/project.yaml`. The
 * loader (projects.ts) resolves a project's effective definitions from these.
 */
import type { DomainDef } from './domain-types.ts';
import { appFormat, projectFormat } from './formats.ts';
import { dashboardValue } from './parse-domain.ts';
import type { AppDef, AppHomeColumn, AppHomeDef, AppTemplateCard, ProjectConnectionDef, ProjectPersonDef, ProjectSource, ProjectStatus } from './project-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, type ParseResult } from './source.ts';

/** The app of a domain without `app.yaml`: version 1, named after the domain, one blank card. */
export function defaultApp(domain: Pick<DomainDef, 'id' | 'name' | 'description'>): AppDef {
  return compact({ id: domain.id, title: domain.name, version: 1, description: domain.description, templates: [], versions: [] });
}

/** `domains/<id>/app.yaml` for the domain `domain`. `versions` are the snapshots found beside it. */
export function parseAppFile(text: string, file: string, domain: Pick<DomainDef, 'id' | 'name' | 'description'>, versions: number[] = []): ParseResult<AppDef> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  const data = src.data ?? {};
  if (!isRecord(data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected an app: title, version, description, templates');
    return { diagnostics: report.diagnostics };
  }
  report.validate(appFormat, data);
  const written = asString(data.app);
  if (written !== undefined && written !== domain.id) {
    report.warn('app-id-mismatch', `the app id \`${written}\` differs from its folder name \`${domain.id}\`; the folder name is used`, ['app']);
  }
  const templates: AppTemplateCard[] = Object.entries(asRecord(data.templates)).filter(([, v]) => isRecord(v)).map(([id, v]) => {
    const card = v as Record<string, unknown>;
    return compact({
      id,
      title: asString(card.title) ?? id,
      description: asString(card.description),
      without: Array.isArray(card.without) ? asStrings(card.without) : undefined,
      settings: isRecord(card.settings) ? card.settings : undefined,
    });
  });
  const nouns = isRecord(data.nouns) && typeof data.nouns.one === 'string' && typeof data.nouns.many === 'string'
    ? { one: data.nouns.one, many: data.nouns.many } : undefined;
  const home = isRecord(data.home) && typeof data.home.title === 'string' ? homeOf(data.home as Record<string, unknown> & { title: string }) : undefined;
  const value: AppDef = compact({
    id: domain.id,
    title: asString(data.title) ?? domain.name,
    version: typeof data.version === 'number' && Number.isInteger(data.version) && data.version > 0 ? data.version : 1,
    description: asString(data.description) ?? domain.description,
    nouns,
    home,
    templates,
    versions: [...versions].sort((a, b) => a - b),
    file,
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

function homeOf(raw: Record<string, unknown> & { title: string }): AppHomeDef {
  const columns: AppHomeColumn[] = [];
  for (const c of Array.isArray(raw.columns) ? raw.columns : []) {
    if (!isRecord(c) || typeof c.label !== 'string') continue;
    if (typeof c.setting === 'string') { columns.push({ label: c.label, setting: c.setting }); continue; }
    const value = isRecord(c.value) ? dashboardValue(c.value) : undefined;
    if (!value) continue;
    const format = c.format === 'percent' || c.format === 'number' ? c.format : 'percent' in value ? 'percent' : undefined;
    columns.push(compact({ label: c.label, value, format }));
  }
  return compact({ title: raw.title, link: asString(raw.link), columns, next: asString(raw.next) });
}

/** `project.yaml` as written, before its template is resolved. */
export interface ProjectFile {
  id: string;
  app: string;
  /** Other apps it also runs, at their current versions (`also: [gst, itr]`). */
  also?: string[];
  /** Absent: the app's current version. */
  version?: number;
  name: string;
  template?: string;
  copiedFrom?: string;
  study?: string;
  status: ProjectStatus;
  people: ProjectPersonDef[];
  connections: ProjectConnectionDef[];
  without: string[];
  settings?: Record<string, unknown>;
  file: string;
}

/** `projects/<id>/project.yaml`; `id` is the folder name. */
export function parseProjectFile(text: string, file: string, id: string): ParseResult<ProjectFile> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected a project: app, name, version, people, connections');
    return { diagnostics: report.diagnostics };
  }
  const data = src.data;
  report.validate(projectFormat, data);
  const written = asString(data.project);
  if (written !== undefined && written !== id) {
    report.warn('project-id-mismatch', `the project id \`${written}\` differs from its folder name \`${id}\`; the folder name is used`, ['project']);
  }
  const people: ProjectPersonDef[] = (Array.isArray(data.people) ? data.people : []).filter(isRecord)
    .filter((p) => typeof p.email === 'string')
    .map((p) => compact({
      email: (p.email as string).trim().toLowerCase(),
      name: asString(p.name),
      roles: typeof p.roles === 'string' ? [p.roles.trim()] : asStrings(p.roles),
      note: asString(p.note),
    }));
  const connections: ProjectConnectionDef[] = Object.entries(asRecord(data.connections)).filter(([, v]) => isRecord(v)).map(([cid, v]) => {
    const c = v as Record<string, unknown>;
    return compact({
      id: cid,
      title: asString(c.title) ?? cid,
      plugin: asString(c.plugin),
      access: c.access === 'read' || c.access === 'write' ? c.access : undefined,
      settings: isRecord(c.settings) ? c.settings : undefined,
    });
  });
  const status = data.status === 'draft' || data.status === 'archived' ? data.status : 'active';
  const value: ProjectFile = compact({
    id,
    app: asString(data.app)?.trim() ?? '',
    also: Array.isArray(data.also) ? asStrings(data.also).map((a) => a.trim()).filter((a, i, all) => a && all.indexOf(a) === i) : undefined,
    version: typeof data.version === 'number' && Number.isInteger(data.version) && data.version > 0 ? data.version : undefined,
    name: asString(data.name) ?? id,
    template: asString(data.template),
    copiedFrom: asString(data.copied_from),
    study: asString(data.study),
    status,
    people,
    connections,
    without: Array.isArray(data.without) ? asStrings(data.without) : [],
    settings: isRecord(data.settings) ? data.settings : undefined,
    file,
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

/** The source a project records in `mw.projects.from`. */
export function projectSource(file: Pick<ProjectFile, 'template' | 'copiedFrom'>, version: number): ProjectSource {
  if (file.copiedFrom) return { project: file.copiedFrom };
  if (file.template) return { template: file.template, version };
  return { blank: true };
}
