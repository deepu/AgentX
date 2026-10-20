# @memwise/defs

Definition formats (`workflow.yaml`, `steps/*.md`, `case.yaml`, entity types, `policy.yaml`, example cases), their JSON Schemas, the static checks, and the indexer that loads a project folder's definitions into Postgres.

**Boundary.** Depends on no other `@memwise/*` package. The indexer writes through the `DefinitionStore` interface that `@memwise/db` implements, so formats and checks stay pure and usable from the CLI and the editor.

| Module | What it does |
|---|---|
| `types.ts`, `contracts.ts` | The Phase 1 contracts (see [18](../../docs/memwise/18-kernel-interfaces.md)) |
| `value-types.ts` | `parseValueType`, `formatValueType`, `parseDuration` (`1h30m`), `parseCount` (`40k`), `parseRate` (`30/min`) |
| `formats.ts` | The file formats in zod; `jsonSchemas` is generated from them |
| `parse-*.ts` | One parser per file kind; content errors become diagnostics with file and line |
| `load.ts` | `loadProject(root)`, `loadWorkflow(dir, root)`, including the workflow hash |
| `check.ts` | `checkWorkflow`, `checkProject`: the checks in [05 §8](../../docs/memwise/05-workflows.md) |
| `values.ts` | `validateValue`, `valueTypeToJsonSchema` |
| `index-project.ts` | `indexProject(project, store)` |
| `drafts.ts` | Drafts as files (Phase 3, [20 §1](../../docs/memwise/20-phase-3-interfaces.md)): `createDraft`, `writeDraftFiles`, keep/discard, `draftContentHash`, `loadDraft`, `diffDraft`, `applyDraft` |
| `diff.ts` | `lineDiff` (LCS line diff in hunks), `structuralDiff` and `describeStructuralDiff` |
| `example-yaml.ts`, `init.ts`, `convert.ts` | `exampleToYaml`, `initProject` (`memwise init`), `convertTaskYaml` (`memwise convert`) |

`bun run schemas` regenerates `schemas/*.schema.json`; a test fails when they are out of date.

**Hashes.** A step, case type or entity type hashes its own file (sha256). A workflow hashes every file in its folder, sorted by relative path (dotfiles skipped), plus any case or policy file it points to outside the folder.

**Check codes.** `unknown-start`, `unknown-target`, `unreachable-state`, `no-exit`, `wait-without-timeout` (warning), `missing-model-role`, `no-outcomes`, `outcome-without-transition`, `unknown-outcome` (warning), `unknown-case-field`, `write-type-mismatch`, `tool-not-allowed`, `unknown-tool`, `required-not-allowed`, `unknown-type`, `unknown-entity`, `system-step-phase-2` (warning), `example-unknown-state`, `example-unknown-outcome`, `example-unknown-field`, `example-invalid-value`, `example-unknown-tool`, `open-engine-needs-open-step`, `outcome-from-system-only`, `outcome-from-not-required`. A conversation step (agent, `engine: open`) waits like a person step, so it gets `missing-assignee` and `wait-without-timeout`, needs no model role, and examples answer it with `submit:`. Parse codes: `yaml-syntax`, `invalid-format`, `invalid-type`, `invalid-type-name`, `unknown-key` (warning), `reserved-state`, `missing-front-matter`, `missing-workflow-file`, `missing-case-file`, `missing-policy-file`, `step-without-state` (warning), `workflow-id-mismatch` (warning), `duplicate-entity`, `duplicate-workflow`, `missing-project`.

The check environment's `tools` must list every tool steps may use, including the step engine's recall tools (`recall.step_record`, `recall.similar_cases`); `step.finish` and `checkpoint.verdict` are known without it.
