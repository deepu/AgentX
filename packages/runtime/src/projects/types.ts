/**
 * Stage 3 (docs/memwise/26-projects-and-pages.md §3): the kernel's projects service, what the app's
 * project switcher, New project, Project settings, the app home, Waiting across all projects and
 * Review template update read and do. Every call takes the actor; a person sees only the projects
 * their grants reach (D92), and only the app's owner role changes one.
 *
 * STAGE 3 CONTRACT. Change only additively. Type-only (safe for the app's bundles).
 */
import type {
  AppTemplateCard, ProjectConnectionDef, ProjectPersonDef, ProjectSource, ProjectStatus, TemplateChange,
} from '@memwise/defs';
import type { Actor, InboxItem } from '../types.ts';

/** A project in the switcher and lists. */
export interface MwProjectSummary {
  id: string;
  /** The app it is a copy of (its template, its updates, its owner role). */
  app: string;
  /**
   * Every app it runs, `app` first (D105): a firm's one project may also run GST, income tax and
   * notices on the same client records; a study runs its one app.
   */
  apps: string[];
  appTitle: string;
  name: string;
  status: ProjectStatus;
  study?: string;
  /** The app version its template was taken from, and the app's current one. */
  templateVersion: number;
  appVersion: number;
  from?: ProjectSource;
  /** An app's own project (no project.yaml): today's single-domain workspaces. */
  implicit?: boolean;
  /** A newer template version waits for review (absent once taken or skipped). */
  update?: { to: number };
  /** What waits for this person in this project (Waiting for you). */
  waiting: number;
  createdAt?: string;
  updatedAt?: string;
}

/** An app with its projects, for the switcher (app first: eTMF › MW-301, D104). */
export interface MwAppSummary {
  id: string;
  title: string;
  description?: string;
  version: number;
  /** What a project is called here: { one: study, many: studies } (default project, projects). */
  nouns: { one: string; many: string };
  /** The app home, when the app has one ("TMF across studies"). */
  home?: { title: string; link?: string };
  /** New project's template cards. */
  templates: AppTemplateCard[];
  projects: MwProjectSummary[];
  /** The person may make projects here (the app's owner role, or no roles at all). */
  canCreate: boolean;
}

/** A connection of a project, and where its binding comes from (its own, else the app's). */
export interface MwProjectConnection extends ProjectConnectionDef {
  bound: 'project' | 'app' | 'none';
}

/** Project settings. */
export interface MwProjectDetail extends MwProjectSummary {
  people: (ProjectPersonDef & { personId?: string })[];
  connections: MwProjectConnection[];
  settings: Record<string, unknown>;
  /** Template paths it leaves out (`workflows/chase-missing`). */
  without: string[];
  /** The template card it was made from, by title. */
  templateTitle?: string;
  /** The files it changed (its overrides), each with the playbook they belong to. */
  overrides: { path: string; workflow?: string; title: string }[];
  /** The playbooks it runs: its own copies, and which it changed. */
  playbooks: { id: string; title: string; version: number; overridden: boolean }[];
  /** The person may change it (the app's owner role in this project, or no roles at all). */
  canEdit: boolean;
}

/** New project: from a template card, a copy of a project (never its records), or blank. */
export interface MwCreateProjectInput {
  /** The app; may be left out when copying. */
  app?: string;
  name: string;
  /** A template card id. */
  template?: string;
  /** Copy this project's way of working ("Start from MW-301"). */
  copyFrom?: string;
  /** Other apps it also runs (D105; a copy keeps its source's). */
  also?: string[];
  study?: string;
  people?: ProjectPersonDef[];
  without?: string[];
  settings?: Record<string, unknown>;
  /** Default: made from the name. */
  id?: string;
}

/** Fields of Project settings a person changes (project.yaml). */
export interface MwProjectPatch {
  name?: string;
  study?: string | null;
  people?: ProjectPersonDef[];
  connections?: ProjectConnectionDef[];
  settings?: Record<string, unknown>;
}

/** "Review template update" in Waiting for you (one per project behind its app). */
export interface MwTemplateUpdateItem {
  kind: 'template-update';
  /** `template-update:<projectId>:<to>` */
  id: string;
  project: string;
  projectName: string;
  app: string;
  appTitle: string;
  from: number;
  to: number;
  /** "Review template update: eTMF v5" */
  title: string;
  since: string;
}

/** One change of a template update, in the project's terms. */
export interface MwTemplateUpdateChange extends TemplateChange {
  /** The playbook's or file's title. */
  title: string;
  /** Plain words: what taking it does here ("This project already does that, so nothing changes here"). */
  note: string;
}

/** A past case of the project replayed on the new template (the test run on one record). */
export interface MwTemplateTestRun {
  workflowId: string;
  /** The case replayed, when the project has one; else the playbook's example cases ran. */
  caseId?: string;
  title?: string;
  status: 'same' | 'different' | 'error' | 'skip';
  differences: string[];
  /** Example cases run with it. */
  examples: { passed: number; total: number };
}

export interface MwTemplateUpdateReview {
  item: MwTemplateUpdateItem;
  changes: MwTemplateUpdateChange[];
  /** Nothing changes for the project: it already does all of it, or leaves it out. */
  nothingChanges: boolean;
  /** One line for the top of the screen. */
  summary: string;
  /** Present when asked for (`test: true`) and something changes. */
  test?: MwTemplateTestRun;
}

/** The app home ("TMF across studies"): one row per project the person can see. */
export interface MwAppHome {
  app: string;
  title: string;
  link?: string;
  nouns: { one: string; many: string };
  /** The table's columns after the project's name (app.yaml `home.columns`), then "Next". */
  columns: { label: string; format?: 'number' | 'percent' }[];
  rows: {
    project: string;
    name: string;
    study?: string;
    status: ProjectStatus;
    /** One per column; null when the project has nothing to count (a draft). */
    values: (number | string | null)[];
    next?: { label: string; date?: string };
    waiting: number;
  }[];
  /** How many projects, by status. */
  totals: { projects: number; active: number; draft: number; archived: number };
  /** The first percent column, across the running projects ("Documents filed 96%"). */
  headline?: { label: string; value: number | null };
  /** The next milestones of running projects, soonest first. */
  milestones: { project: string; name: string; label: string; date?: string }[];
  /** Who has the most waiting on them, across projects. */
  bottlenecks: { personId?: string; name: string; roles: string[]; waiting: { project: string; projectName: string; count: number }[]; total: number }[];
}

/** Waiting for you across all projects, grouped by project (and app). */
export interface MwWaitingGroup {
  project: string;
  projectName: string;
  app: string;
  appTitle: string;
  items: InboxItem[];
  updates: MwTemplateUpdateItem[];
}

export interface ProjectsService {
  /** Apps with their projects, as the person sees them (the switcher). */
  apps(actor: Actor): Promise<MwAppSummary[]>;
  list(actor: Actor, filter?: { app?: string }): Promise<MwProjectSummary[]>;
  get(projectId: string, actor: Actor): Promise<MwProjectDetail | undefined>;
  /** Makes a draft: its files, then its row. Nothing runs in it until `start`. Records are never copied. */
  create(input: MwCreateProjectInput, actor: Actor): Promise<MwProjectDetail>;
  update(projectId: string, patch: MwProjectPatch, actor: Actor): Promise<MwProjectDetail>;
  /** "Start study": a draft becomes active (an archived project comes back). */
  start(projectId: string, actor: Actor): Promise<MwProjectDetail>;
  archive(projectId: string, actor: Actor): Promise<MwProjectDetail>;
  /** Removes a draft (files and row). Refused for anything but a draft. */
  discard(projectId: string, actor: Actor): Promise<void>;

  /** "Review template update" items the person may act on (the app's owner role in the project). */
  templateUpdates(actor: Actor): Promise<MwTemplateUpdateItem[]>;
  /** What taking the update changes here; `test`: also replay one of the project's past cases on it. */
  reviewUpdate(projectId: string, actor: Actor, opts?: { test?: boolean }): Promise<MwTemplateUpdateReview | undefined>;
  /** Take it: the project moves to the app's version; overrides that now say the same are dropped. */
  takeUpdate(projectId: string, actor: Actor): Promise<{ version: number; removed: string[] }>;
  /** Skip it: no item for this version again (a newer version makes a new one). */
  skipUpdate(projectId: string, actor: Actor): Promise<void>;
  /**
   * Publish the next version of an app's template (template path → new content, null removes it).
   * Every project behind it gets a "Review template update" item.
   */
  publishTemplate(appId: string, files: Record<string, string | null>, actor: Actor): Promise<{ version: number; updates: MwTemplateUpdateItem[] }>;
  /** "Save as template": the project's way of working becomes the app's next version, or a new app. */
  saveAsTemplate(projectId: string, opts: { newApp?: { id: string; title: string } }, actor: Actor): Promise<{ app: string; version: number }>;

  /** The app home across its projects. */
  home(appId: string, actor: Actor): Promise<MwAppHome>;
  /** Waiting for you across every project the person can see. */
  waiting(actor: Actor): Promise<MwWaitingGroup[]>;
  /** "Describe it in chat": starts the app's `create-project` meta playbook, a conversation that makes the draft. */
  describe(input: { app: string; request: string }, actor: Actor): Promise<{ runId: string; caseId: string; stepRunId: string }>;
  /** The walkthrough records of `projects/<id>/seed.yaml`, made once when the project has none (the kernel itself only). */
  seed(projectId: string, actor: Actor): Promise<{ created: number; skipped?: string }>;
}

export interface KernelStage3 {
  readonly projects: ProjectsService;
}
