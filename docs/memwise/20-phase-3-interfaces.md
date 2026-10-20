# 20 · Phase 3 interfaces

The boundaries Phase 3 ([17](17-build-plan.md), "Build and change by chat") is built against, in the same spirit as [18](18-kernel-interfaces.md) and [19](19-phase-2-interfaces.md): agreed first, built in parallel, joined at the end. Earlier contracts still hold and change only additively.

| Contract | File |
|---|---|
| Drafts, diffs, reports, versions | `packages/defs/src/draft-types.ts` |
| Definition additions (`engine`, `outcomeFrom`) | `packages/defs/src/types.ts` |
| Kernel additions (`Authoring`, versions, conversation steps) | `packages/runtime/src/types.ts` |
| App API shapes and channels | `packages/shared/src/protocol/memwise.ts`, `channels.ts` |
| Tables | `packages/db/migrations/0003_change_control.sql` |
| Meta playbooks | `examples/intake/workflows/create-playbook/`, `change-playbook/` |

**Vocabulary.** People read "playbook", "draft", "change", "version". Code and files keep `workflow`.

## 1. The rule: every edit is a draft (05 §10, D33)

- **The project folder's `domain/` and `workflows/` are live.** That is what the kernel indexes and what new cases start on, exactly as in Phase 2. Nothing edits them except publishing.
- **A draft is a folder of plain files** at `<project>/drafts/<draft-id>/` (layout in `draft-types.ts`): a copy of `domain/` and of the target playbook's folder, plus `draft.yaml`, `edits.jsonl` and `report.json`. A draft folder is itself a project, so `memwise check drafts/<id>` works, and chat, the app and the CLI all edit the same files.
- **One playbook per draft.** A change draft copies the live playbook and sets `version:` to the live version + 1 at once, so the diff shows the bump and the checked hash covers it. A create draft starts with an empty folder and `version: 1`.
- **Edits are recorded.** Every write is one `DraftEdit` (before and after of each file). Chat edits start `pending` and show highlighted until the person keeps or discards them; discarding restores the files unless they changed again since (then it is refused, naming them). Editor and CLI edits are `kept` at once.
- **Publishing** copies the files the draft changed (compared with `base`) over the live ones, refusing when a live file changed since the draft was made (`conflict`) or the draft changed since it was checked (`stale`). The watcher re-indexes; running cases stay on the hash they started with (D36), so "running cases keep their version" holds with no extra machinery.

### `@memwise/defs` functions (file layer, no database)

| Function | Does |
|---|---|
| `createDraft(root, { workflowId, title, kind, createdBy, runId? })` → `DraftMeta` | Copies `domain/` and the playbook, records `base`, bumps `version:` |
| `listDrafts(root)`, `readDraft(root, id)`, `updateDraftMeta(root, id, patch)` | `draft.yaml`, `edits.jsonl`, `report.json` |
| `writeDraftFiles(root, id, files, { by, via, chatId?, summary })` → `DraftEdit` | Only `domain/**` and `workflows/<workflowId>/**`, no `..`, UTF-8 text |
| `setDraftEditStatus(root, id, editId, status)`, `discardDraftEdit(root, id, editId)` | Keep, or restore the edit's `before` |
| `draftContentHash(root, id)` | sha256 over the draft's `domain/` and `workflows/` files (not the metadata) |
| `loadDraft(root, id)` → `{ project, diagnostics, workflow? }` | `loadProject` on the draft folder |
| `diffDraft(root, id)` → `DraftDiff` | File diffs (`lineDiff`) and `structuralDiff` against live |
| `structuralDiff(before?, after, roles?)` → `StructuralDiff` | States, transitions, step parts, case fields, tools, required tools, roles, examples |
| `lineDiff(a, b, context = 3)` → `DiffHunk[]` | Small LCS line diff; no new dependency |
| `applyDraft(root, id)` → `{ workflowId, version, files }` | Publish the files; throws `DraftConflictError` |
| `writeDraftReport(root, id, report)` | `report.json` |
| `exampleToYaml(example)` | An `ExampleCase` as the YAML `parseExampleFile` reads |
| `initProject(dir, { template: 'empty' \| 'intake' })` | `memwise init` |
| `convertTaskYaml(text)` → `{ workflowId, files }` | Old Conductor `task.yaml` → a playbook folder (§7) |

## 2. Versions (08 §3)

- **`mw.workflow_versions`** (`workflow_id, version, hash, published_at, published_by, source, draft_id, run_id`), primary key `(workflow_id, hash)`. `index()` records every live hash it has not seen as `source: 'files'` (first start after upgrading, or a file edited outside MemWise); publishing in the app records `source: 'app'` with who approved it and the change run; `memwise push` records `cli` when it can reach the database, else the next index records `files`.
- A live hash whose `version:` equals an earlier version's number is a warning diagnostic, `version-not-bumped`: "changed outside review without a new version".
- `kernel.versions(workflowId)` lists them newest first, with cases still running on each.
- `latestWorkflowDef` stays "latest indexed": drafts are never indexed into the live database (their example cases run in throwaway databases, §5).

## 3. Change control is a playbook (11 §3)

Building and changing playbooks are runs of two **meta playbooks** that ship in the project folder (and are added to an existing project at start when missing). So a change has an inbox item, a case, a timeline, step records, reminders and "why?" like any other case.

```yaml
# workflows/create-playbook/workflow.yaml          (change-playbook: same shape, start: edit)
workflow: create-playbook
title: Create a playbook
owner: manager
start: interview
steps:
  interview: { on: { drafted: check }, wait: { remind: 3d, timeout: 30d → end } }   # conversation (chat)
  check:     { on: { passed: review, failed: interview } }                            # system: checks + examples + impact
  review:    { on: { approved: publish, changes_requested: interview }, wait: { remind: 2d, timeout: 14d → interview } }
  publish:   { on: { published: end, stale: check } }                                 # system: publish vN
```

Case type `playbook_change` (both meta playbooks): `playbook`, `title`, `request`, `draft`, `summary`, `checked_hash`, `report`, `errors`, `examples_failed`, `version`.

| Step | Performer | Does |
|---|---|---|
| `interview` / `edit` | agent, `engine: open`, assignee `staff` | The chat (§4). Writes `playbook`, `title`, `draft`, `summary`; outcome `drafted`. Its instructions are the authoring guide the chat follows (11 §4). |
| `check` | system | `playbooks.check_draft(draft)`: checks, example cases, past cases replayed, impact; writes `checked_hash`, `report`, `errors`, `examples_failed`; outcome from the result (`outcomeFrom`): `passed` or `failed` |
| `review` | person, assignee `manager` | Approve or ask for changes (comment goes back to the chat as repair context). The inbox card opens the draft review screen. |
| `publish` | system | `playbooks.publish_draft(draft, checked_hash)`: `published` (writes `version`) or `stale` (the draft changed after the check: check again) |

- **The editor path:** editing in the app makes a draft directly; "Send for review" starts `change-playbook` at `check` with the draft (`Authoring.submitDraft`).
- **Approvers** are the review step's role (`manager` in the intake domain). Who may approve which change is policy, so it lives in the files (08 §3).

### Definition additions

- `engine: open` on an agent step with `strictness: open`: a **conversation step**. The run opens a `waiting` step run (like a person step); the inbox shows it as a `conversation` item for its assignee role; only its chat answers it (`submitStep` with `via: { chatId, rationale }`), and the writes get provenance `judgement` with `chatId` and `by`. New checks: `open-engine-needs-open-step` (only agent steps with `strictness: open`), conversation steps get the person-step rules (`missing-assignee`, a wait timeout).
- `outcomeFrom: { tool, field }` on a system step: the outcome is that field of that required tool's last result and must be one of the step's outcomes; anything else ends the step `needs_person`. Checks: `outcome-from-not-required`, `outcome-from-system-only`.

### Kernel tools for the meta playbooks

Bound by the kernel when it has a project folder (`playbooks.*`, plugin `memwise`):

| Tool | Effect | Arguments → result |
|---|---|---|
| `playbooks.check_draft` | `read` | `{ draft }` → `{ outcome, hash, errors, warnings, examples_failed, summary }` and `report.json` |
| `playbooks.publish_draft` | `write` | `{ draft, hash }` → `{ outcome: 'published' \| 'stale', version, workflow }`; the approver (the run's review decision) is recorded as `published_by` |

Their definitions (names, effect classes, schemas) are also what the chat tools' names refer to when a conversation step lists them under `tools.allowed`: `playbooks.vocabulary`, `playbooks.read`, `playbooks.write`, `playbooks.diff`, `playbooks.check` (all `read` or `draft`). `playbooks.publish_draft` is never offered to a chat.

## 4. Building and changing by chat (09 §3)

- **Opening.** "New playbook" (and "Change with chat" on a playbook) calls `memwise:playbooks:build`: `Authoring.startBuild` starts the meta playbook, the run enters its conversation step, and the server opens a chat **anchored to that step run** and returns its session id. The inbox's `conversation` item reopens the same chat (`mw.chat_anchors.forAnchor`, one chat per conversation step and person).
- **Context is not a message.** An anchored chat gets its context as a **per-session system prompt block** (`<memwise_context>`): for a conversation step, the step's instructions (the authoring guide), the case's values, the playbook it changes and the draft; for a case or step (Phase 2 explain chats), the same digest as before. The chat opens with a short hidden kick-off turn, and session previews skip hidden messages, which fixes Phase 2's visible first message.
- **Tools.** Anchored chats get the `playbook_*` session tools (session-tools-core, callbacks `ctx.memwise` wired per session by SessionManager, hidden in sessions that aren't anchored to a conversation step):

| Session tool | Calls | Notes |
|---|---|---|
| `playbook_vocabulary` | `Authoring.vocabulary` | Tools bound in the domain (with effect classes), entity types, roles, model roles, value types |
| `playbook_read` | `Authoring.read` | Live files, or the draft's |
| `playbook_write` | `Authoring.write` (`via: 'chat'`) | Creates the draft on first write; returns the checks after the edit |
| `playbook_diff` | `Authoring.diff` | What changed so far, in plain words and as files |
| `playbook_check` | `Authoring.check` | Checks, example cases, past cases, impact |
| `playbook_finish` | `kernel.submitStep({ via })` | Ends the conversation step: outcome and writes; refused while checks have errors |

  They act as the person in the chat, with the conversation step's assignee role; draft writes are effect class `draft` (allowed by default, D29), so they don't prompt.
- **Keep or discard.** Chat edits show highlighted in the step editor and the review screen until kept or discarded (`memwise:drafts:keep` / `discardEdit`).

## 5. Example cases, past cases and corrections (05 §12)

- **Example cases run out of process.** DBOS is process-wide, so the app can't host a second kernel; the `TestRunner` spawns `memwise test <dir> --workflow <id> --json [--examples-file f] [--database-url <admin url>]`, which creates a throwaway database per example on the app's own Postgres cluster. Under Bun the CLI runs from source; the packaged app runs a bundled `memwise-cli.js` with Electron as Node.
- **Past cases** (`kernel.caseToExample`): a recorded case becomes an example case that **replays** it: its input values, the recorded tool results (by tool, in order), the recorded model turns (by model role, in order), the people's answers by step and the approvals. Run on the draft, a replay shows where the new version would route differently or break ("check: required tool `sanctions.screen` was not called"). It replays recorded model turns; re-running agent steps on a live model is later.
- **Corrections become example cases.** "Save as example" on a case writes `examples/<name>.yaml` into a change draft of its playbook (`memwise:examples:fromCase`). With a correction (a step and the outcome it should have had), the example starts at that step and expects that outcome.

## 6. App API

| Channel | Request → response |
|---|---|
| `memwise:playbooks:versions` | `(workflowId)` → `MwVersion[]` |
| `memwise:playbooks:build` | `(MwBuildPlaybookInput)` → `MwBuildPlaybookResult` |
| `memwise:drafts:list` / `get` / `create` | `({ workflowId? })` → `MwDraftSummary[]` / `(draftId)` → `MwDraft` / `(MwCreateDraftInput)` → `MwDraftSummary` |
| `memwise:drafts:write` | `(MwWriteDraftInput)` → `MwWriteDraftResult` |
| `memwise:drafts:keep` / `discardEdit` / `discard` | `(MwDraftEditInput)` / `(MwDraftEditInput)` / `(draftId)` → `MwSubmitResult` |
| `memwise:drafts:check` / `submit` | `(MwCheckDraftInput)` → `MwDraftReport` / `(draftId)` → `MwSubmitDraftResult` |
| `memwise:examples:fromCase` | `(MwExampleFromCaseInput)` → `MwExampleFromCaseResult` |
| `memwise:changed` | gains `{ kind: 'drafts', id }` |

The inbox gains `conversation` items. Like `memwise:chat:open`, `memwise:playbooks:build` opens chat sessions, so a person's own sign-in (server mode) may not call it.

## 7. Project folder and CLI

| Command | Does |
|---|---|
| `memwise init <dir> [--template intake]` | A new project: `domain/roles.yaml`, `domain/policy.yaml`, `workflows/`, the meta playbooks |
| `memwise draft <project> <workflow> [--title t]` | Make a change draft (prints its folder) |
| `memwise diff <project> <draft>` | File and structural diff against live |
| `memwise push <project> <draft>` | Check, run the draft's example cases, then publish it (`source: cli`). For a project you control with your own review (git); the app publishes through the review step |
| `memwise convert <task.yaml> <project>` | An old Conductor task as a create draft: each `session` node becomes a guided agent step (its prompt as the instructions, its result a case field), `depends_on` becomes `done` transitions (a DAG that is not a chain runs in dependency order), `approval: true` nodes become person approval steps with a reminder and a hand-off to `needs_person` |
| `memwise test <project> --json --workflow <id> --examples-file <f>` | Machine output for the `TestRunner` |

## 8. Screens

- **Playbook view:** a version line ("Version 2 · published by Ravi"), "Change with chat", "Edit", and drafts of this playbook.
- **Step editor:** one card per step (instructions, performer and assignee, reads and writes, tools with effect class, outcomes, checkpoint, effective policy), edited as a draft, with the anchored chat beside it (the panel stack). Changes from chat are highlighted, with Keep and Discard.
- **Draft review** (also what the review step's inbox card opens): the changes in plain words, file diffs, the map in **proposed change** mode (added green, changed amber, removed red), checks, example cases, past cases, impact, and the change run's state. Buttons: Check, Send for review, Discard.
- **New playbook:** starts create-playbook and opens its chat.
- **Case view:** "Save as example" (with "What should this step have done?").

## 9. The second playbook

**Engagement letter** (`workflows/engagement-letter`), built entirely through chat in the exit test and the walkthrough: staff ask for a letter for an onboarded customer, an agent drafts it from the customer and the scope, a partner approves or sends it back, and a system step records the `Engagement`. The transcript is scripted for tests (no model key in CI): the chat runs on a local stand-in for the model API that replays the turns.

## 10. Exit test

`packages/server-core/src/memwise/__tests__/phase3-exit.test.ts`, against a real Postgres with scripted models:

1. Staff start "New playbook"; the chat's tool calls build `engagement-letter` in a draft (case type, steps, example cases), checks pass, `playbook_finish` ends the interview; check passes; the manager approves in the inbox; publish makes it live as v1; a case runs on it.
2. On intake, "Change with chat" adds a new required tool to the check step; the review shows the structural diff (step `check`: tools), impact lists the open intake cases; approved and published as v2; a case started before stays on v1 and finishes on v1, a new case starts on v2.
3. A chat edit is discarded and the file is back; a correction on a case becomes an example case in a draft; `memwise diff` and `memwise push` work on a plain folder.
