/**
 * Drafts, diffs and versions (Phase 3, docs/memwise/20-phase-3-interfaces.md).
 *
 * PHASE 3 CONTRACT. Every edit to a playbook, by chat, in the app or with the CLI, goes into a
 * draft; the live definition never changes in place (05 §10, D33). A draft is a folder of plain
 * files inside the project folder:
 *
 *   <project>/drafts/<draft-id>/
 *     draft.yaml          DraftMeta (who, what, the base it was made from)
 *     edits.jsonl         DraftEdit per line: each change, for keep or discard
 *     report.json         the last DraftReport (checks, example cases, past cases, impact); not content
 *     domain/...          a full copy of the project's domain/ folder, edited in place
 *     workflows/<id>/...  a full copy of the target playbook's folder (empty for a new one)
 *
 * So a draft folder is itself a valid project (`memwise check drafts/<id>`). The live project
 * (domain/ and workflows/) is what runs; publishing copies the draft's changed files over it.
 * `loadProject` reads only domain/ and workflows/, so drafts/ never affects the live index.
 */
import type { Diagnostic, EffectClass, Treatment } from './types.ts';

export const DRAFTS_DIR = 'drafts';

/** `binding` (Phase 4): a draft of one plugin's `domain/bindings/<slug>.yaml`; it copies `domain/` only. */
export type DraftKind = 'create' | 'change' | 'binding';
export type DraftStatus = 'open' | 'published' | 'discarded';

/** `drafts/<id>/draft.yaml` */
export interface DraftMeta {
  /** `<workflow-id>-<base36 time>`; also the folder name. */
  id: string;
  /** What the change is, in the person's words: "Engagement letter", "Add a sanctions check". */
  title: string;
  /** The playbook this draft creates or changes (one per draft); for a binding draft, the binding's slug. */
  workflowId: string;
  /** Binding drafts (Phase 4): the plugin id and version the binding is for. */
  plugin?: { id: string; version: string };
  kind: DraftKind;
  status: DraftStatus;
  /** Live version and workflow hash when the draft was made (change drafts). */
  baseVersion?: number;
  baseHash?: string;
  /**
   * sha256 of every live file the draft copied (project-relative path → hash), so publishing can
   * tell which files the draft changed and whether the live file changed meanwhile.
   */
  base: Record<string, string>;
  /** Person id, or `cli`. */
  createdBy: string;
  createdAt: string;
  /** The meta-playbook run building or changing it (create-playbook / change-playbook), if any. */
  runId?: string;
  /**
   * The playbook's project-relative folder when it isn't `workflows/<workflowId>`: a playbook of a
   * named domain (`domains/etmf/workflows/file-document`). Such a draft copies `workspace.yaml` and
   * every domain's definitions, so it loads as a project; it may change the playbook's folder and
   * its domain's `policy.yaml` and `entities/` (Stage 5, docs/memwise/26-projects-and-pages.md §8).
   */
  folder?: string;
  /** Set when published. */
  publishedVersion?: number;
  publishedAt?: string;
}

/** One change to a draft, as one line of `edits.jsonl`. Chat edits start `pending`. */
export interface DraftEdit {
  id: string;
  at: string;
  /** Person id, or `cli`. */
  by: string;
  via: 'chat' | 'editor' | 'cli';
  /** The chat session that made it, for chat edits. */
  chatId?: string;
  /** One line, plain words: "Added a required GST check to Check". */
  summary: string;
  /** Project-relative paths; `null` before = the file was added, `null` after = deleted. */
  files: { path: string; before: string | null; after: string | null }[];
  /** `pending` until the person keeps or discards it; editor and CLI edits are `kept` at once. */
  status: 'pending' | 'kept' | 'discarded';
}

// ---------------------------------------------------------------- diffs

export interface DiffLine { kind: 'same' | 'added' | 'removed'; text: string }
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }

export interface FileChange {
  /** Project-relative. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  before?: string;
  after?: string;
  hunks: DiffHunk[];
  /** The live file changed since the draft was made (publishing would overwrite someone's change). */
  conflict?: boolean;
}

/** Parts of a step a change can touch; the editor highlights these. */
export type StepPart =
  | 'title' | 'performer' | 'engine' | 'strictness' | 'assignee' | 'instructions' | 'reads' | 'writes' | 'tools'
  | 'model' | 'budget' | 'checkpoint' | 'outcomes' | 'map' | 'outcomeFrom' | 'policy';

export type Change = 'added' | 'removed' | 'changed';

/** What a change does to a playbook's shape and steps: the map's "proposed change" mode (05 §9). */
export interface StructuralDiff {
  workflowId: string;
  /** Only states that differ; absent = unchanged. */
  states: Record<string, Change>;
  transitions: { from: string; event: string; to: string; change: 'added' | 'removed' }[];
  steps: Record<string, { change: Change; parts: StepPart[] }>;
  caseFields: { added: string[]; removed: string[]; changed: string[] };
  /** Tools used anywhere in the playbook (allowed, required or written from). */
  tools: { added: string[]; removed: string[] };
  requiredTools: { step: string; tool: string; change: 'added' | 'removed' }[];
  roles: { added: string[]; removed: string[] };
  examples: { added: string[]; removed: string[]; changed: string[] };
  version: { from?: number; to?: number };
  /** Title, owner or policy of the playbook itself changed. */
  playbook: ('title' | 'owner' | 'policy' | 'start')[];
}

export interface DraftDiff {
  draftId: string;
  workflowId: string;
  files: FileChange[];
  /** Absent when the draft's playbook doesn't load. */
  structure?: StructuralDiff;
  /** Paths whose live file changed since the draft was made. */
  conflicts: string[];
}

// ---------------------------------------------------------------- reports (change control, 08 §3)

export interface ExampleOutcome {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  differences: string[];
  reason?: string;
}

/** A past case replayed on the draft ("try it on past cases"). */
export interface PastCaseOutcome {
  caseId: string;
  title: string;
  status: 'same' | 'different' | 'skip' | 'error';
  /** Plain words: "went to needs_info instead of verify", "check: required tool sanctions.screen not called". */
  differences: string[];
  /** The path the case took live, and on the draft. */
  livePath: string[];
  draftPath: string[];
}

export interface ImpactTool {
  name: string;
  bound: boolean;
  effect?: EffectClass;
  /** How the effective policy treats it in the step that uses it. */
  treatment?: Treatment;
  plugin?: string;
}

/** What publishing would change, before anyone approves it (08 §3). */
export interface Impact {
  workflowId: string;
  liveVersion?: number;
  newVersion: number;
  /** Cases still running on earlier versions; they stay on their version (D33). */
  openCases: { total: number; byState: Record<string, number> };
  /** States the change removes that cases are in now (they finish on their old version). */
  removedStatesWithCases: { state: string; cases: number }[];
  newTools: ImpactTool[];
  newRequiredTools: { step: string; tool: string }[];
  caseFields: StructuralDiff['caseFields'];
  /**
   * Domain changes (roles, entity types) and the other playbooks that use them: `uses` in words
   * (`customer`, `role manager`), and the same split into the entity types and roles, for screens
   * that say it in their own words. Reports written before the split have `uses` only.
   */
  otherPlaybooks: { id: string; uses: string[]; entities?: string[]; roles?: string[] }[];
  /** The same in plain sentences, for the review card. */
  summary: string[];
}

/** `drafts/<id>/report.json`: the last check of the draft (draft → checked → tested). */
export interface DraftReport {
  draftId: string;
  workflowId: string;
  /** Content hash of the draft when checked (draftContentHash); stale when the draft changes. */
  hash: string;
  at: string;
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  examples: ExampleOutcome[];
  pastCases: PastCaseOutcome[];
  impact?: Impact;
  /** `passed`: no errors and no failing example case. Past cases inform; they don't block. */
  outcome: 'passed' | 'failed';
  /** Plain-words summary for the case and the review card. */
  summary: string;
}

/** One published version of a playbook (the version index, mw.workflow_versions). */
export interface WorkflowVersion {
  workflowId: string;
  version: number;
  hash: string;
  publishedAt: string;
  /** Person id of whoever approved it, when published in the app. */
  publishedBy?: string;
  /** `app`: through review; `cli`: memwise push; `files`: found on disk (first start, or edited outside MemWise). */
  source: 'app' | 'cli' | 'files';
  draftId?: string;
  /** The change-playbook or create-playbook run that published it. */
  runId?: string;
  /** Cases still running on this version. */
  openCases: number;
  /** The version the project folder holds now. */
  live: boolean;
}
