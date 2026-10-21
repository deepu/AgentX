/**
 * Apps and projects (docs/memwise/26-projects-and-pages.md §3, D87, D92, D93).
 *
 * An app is a domain used as a template (`domains/<id>/` plus `app.yaml`); a project is one copy
 * of it (`projects/<id>/project.yaml`) with its own records, pages, runs, chats, people and
 * connections, and `overrides/` holding whole files that replace the template's.
 *
 * The name clash: elsewhere "project" also means the loaded definitions folder (`ProjectDefs`,
 * `loadProject`). The things here are always "MemWise projects": `MwProjectDef`, `projectId`.
 *
 * STAGE 3 CONTRACT. Change only additively. Imports nothing at run time (safe for the app's bundles).
 */
import type { DashboardValue, FreePageDef, ViewDef } from './domain-types.ts';
import type { PolicyDoc, WorkflowDef } from './types.ts';

/** `projects/` at the workspace root: one folder per project. */
export const PROJECTS_DIR = 'projects';
/** `projects/<id>/overrides/`: whole files that replace the template's, at the same relative path. */
export const OVERRIDES_DIR = 'overrides';
/** `domains/<app>/versions/<n>/`: the template as it was at version n, kept when a newer one is published. */
export const APP_VERSIONS_DIR = 'versions';
/** A project id: the folder name. Lower case, digits, `_` and `-`; ids never reach table names. */
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * Template paths a project may override or leave out (relative to the app's folder): its
 * playbooks' files, the app's policy, pages and views. Record types (`entities/`) are the app's
 * (D95: fixed by the template), because every project of the app shares their tables.
 */
export const OVERRIDABLE = /^(workflows\/[^/]+\/.+|policy\.ya?ml|pages\/[^/]+\.ya?ml|views\/[^/]+\.ya?ml)$/;

/**
 * Playbooks of an app that act on the app itself, not inside one project: `create-project` (a
 * new project described in chat). Projects get no copy of them; their runs belong to the app's
 * own project (id = the app id), which everyone with a role in the app sees.
 */
export const APP_PLAYBOOKS: readonly string[] = ['create-project'];

/** The kernel's `projects.*` tools (the create-project conversation's), bound in every workspace. */
export const PROJECT_KERNEL_TOOLS: Readonly<Record<string, 'read' | 'draft'>> = { 'projects.options': 'read', 'projects.create_draft': 'draft' };

export type ProjectStatus = 'draft' | 'active' | 'archived';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['draft', 'active', 'archived'];

/** An entity's scope: `project` (the default) has a `project` column; `app` records are shared by every project of the app. */
export type EntityScope = 'app' | 'project';

/** A card in New project ("Phase 3 study · Many sites, visits"). */
export interface AppTemplateCard {
  id: string;
  title: string;
  description?: string;
  /** Template paths a project made from this card leaves out (`pages/safety-literature`, `workflows/monitoring`). */
  without?: string[];
  /** Initial project settings. */
  settings?: Record<string, unknown>;
}

/** `domains/<id>/app.yaml`. A domain without one is an app at version 1 with one card, "Blank". */
/** A column of the app home's table, one row per project (26 §3, "TMF across studies"). */
export type AppHomeColumn =
  | { label: string; value: DashboardValue; format?: 'number' | 'percent' }
  | { label: string; setting: string };

/** `home:` of app.yaml: the page across an app's projects. */
export interface AppHomeDef {
  title: string;
  link?: string;
  columns: AppHomeColumn[];
  /** The project setting that holds the next milestone, `{ label, date }`. */
  next?: string;
}

export interface AppDef {
  /** The domain id. */
  id: string;
  title: string;
  /** The template's version (D93): each publish is a new number; projects pin the one they took. */
  version: number;
  description?: string;
  /** What a project is called in this app: `{ one: study, many: studies }`. */
  nouns?: { one: string; many: string };
  /** The app home ("TMF across studies"), a page across the app's projects. */
  home?: AppHomeDef;
  templates: AppTemplateCard[];
  /** Older versions kept under `versions/<n>/`, ascending. */
  versions: number[];
  /** `app.yaml` relative to the workspace root; absent for an app without one. */
  file?: string;
}

/** A person in a project, with their roles there (they become the person's grants for the project). */
export interface ProjectPersonDef {
  email: string;
  name?: string;
  roles: string[];
  /** Shown beside the role: "owner", "writes visit reports". */
  note?: string;
}

/** A connection the project uses ("Study email", "PubMed", "Veeva Vault · read only"). */
export interface ProjectConnectionDef {
  id: string;
  title: string;
  /** The installed plugin it goes through (a binding of it applies: the project's own, else the app's). */
  plugin?: string;
  /** `read` for read-only connections. */
  access?: 'read' | 'write';
  /** Per-project settings of the connection (a mailbox, a folder): never credentials. */
  settings?: Record<string, unknown>;
}

/** Where a project came from (`mw.projects.from`). */
export type ProjectSource =
  | { template: string; version: number }
  | { project: string }
  | { blank: true };

/** `projects/<id>/project.yaml`, with its effective definitions resolved (template + overrides). */
export interface MwProjectDef {
  id: string;
  /** The app (domain id). */
  app: string;
  name: string;
  /** The app version its template was taken from. */
  version: number;
  from?: ProjectSource;
  /** The template card it was made from. */
  template?: string;
  /** The study key linking projects across apps (26 §9). */
  study?: string;
  /** The status the file starts it in (the database keeps the live one). Default active. */
  status: ProjectStatus;
  people: ProjectPersonDef[];
  connections: ProjectConnectionDef[];
  settings?: Record<string, unknown>;
  /** Template paths left out. */
  without: string[];
  /** Template paths this project overrides (relative to the app folder), sorted. */
  overrides: string[];
  /** No project.yaml: the one project of an app that has none (id = the domain id). */
  implicit?: boolean;
  /** Folder relative to the workspace root (`projects/mw301`); absent when implicit. */
  dir?: string;
  file?: string;
  /** Covers project.yaml, every override and the template version it resolves against. */
  hash: string;

  // ---- the effective definitions (template at `version` + overrides − without)
  /** By workflow id. Shared objects with `ProjectDefs.workflows` where nothing differs. */
  workflows: Record<string, WorkflowDef>;
  /** The app's policy layer as this project has it. */
  policy?: PolicyDoc;
  pages: Record<string, FreePageDef>;
  views: Record<string, ViewDef>;
}

/** One file that differs between two template versions, as a project sees it (26 §3 "Review template update"). */
export interface TemplateChange {
  /** Template path, relative to the app folder. */
  path: string;
  kind: 'added' | 'changed' | 'removed';
  /** The playbook it belongs to, when it is a playbook file. */
  workflow?: string;
  /** What the project already has there: `overridden-same` "This project already does that, so nothing changes here". */
  project: 'takes' | 'overridden-same' | 'overridden-differs' | 'left-out';
}

/** What taking a newer template version would change in a project. */
export interface TemplateUpdate {
  projectId: string;
  app: string;
  from: number;
  to: number;
  changes: TemplateChange[];
  /** Playbooks whose effective definition changes if the update is taken. */
  workflowsChanged: string[];
  /** Whether the app policy changes for the project. */
  policyChanged: boolean;
}
