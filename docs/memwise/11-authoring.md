# 11 · Building by conversation

Everything in MemWise can be created through chat: entity types, mappings, bindings, workflows, components, pages, connectors and tools. The mechanism is the same everywhere: **meta workflows**, which are workflows whose output is a definition.

## 1. Why this works

Today's "add Linear as a source" feels magical, but it's a simple recipe:
1. **A playbook** (`sources.md`, about 900 lines) explains the setup process.
2. **A pointer in the system prompt** tells the agent to read it first.
3. **Validation tools** (`source_test`, `config_validate`) and auth triggers.
4. **Plain files** the agent writes (`config.json`, `permissions.json`, `guide.md`).
5. **Code-enforced rules**, such as a source's tools being blocked until its guide has been read.

The same pattern is used for skills, automations, pages and task generation. MemWise makes it official, and because definitions are files, a meta workflow's output is a set of files in the project folder that the app and CLI can show and diff.

## 2. The recipe for every kind of definition

| Ingredient | Purpose |
|---|---|
| **Playbook** | How to interview the person and design this kind of thing well, written for the agent |
| **Schema** | What a valid definition looks like (JSON Schema over the YAML and front matter) |
| **Checks** | Code that accepts or rejects a draft with errors the agent can fix ([05 §8](05-workflows.md)) |
| **Dry run** | A test call for a connector, a preview for a form, example cases for a workflow, a round trip for a mapping |
| **Publish** | Through change control ([08 §3](08-policy-and-control.md)) |

Each meta workflow ships in a plugin ("Connectors", "Workflows", "Domain modelling"), so authoring can improve independently of the core.

## 3. Meta workflows

| Meta workflow | Output | Typical steps |
|---|---|---|
| **Model the domain** | Entity types, relationships, lifecycles, rules | Interview → draft model → review diagram → publish |
| **Create a connector** | A connector plugin | Research → configure → test → sign in → write guide → bind |
| **Bind a plugin** | A binding | Capability check → classify tools → entity binding → data mapping → policy review → dry run → freeze |
| **Create a workflow** | A workflow folder | Interview → find steps → draft shape → case type → each step → components → example cases → dry run → publish |
| **Design a component or page** | A component or page | Pick from the vocabulary → generate → preview → save |
| **Create a tool** | A tool in a plugin | Specify input, output and effect class → write code in a sandbox → test → declare environment → publish |
| **Improve a workflow** | A proposal | Analyse corrections and failures → propose → run example cases → approve |

## 4. Creating a workflow

The most important meta workflow, because it's how an expert's process becomes software. It runs as a normal run, so it can be paused, resumed and reviewed.

1. **Interview** in the expert's words (an open, conversational step): "Walk me through what happens when a new client signs up." Checkpoints, who approves, what goes wrong, deadlines, data.
2. **Find the steps.** Merge small actions into meaningful checkpoints; split steps that hide an approval (P2).
3. **Draft the shape** (`workflow.yaml`), including send-backs, timeouts and "needs a person", shown on the map.
4. **Define the case type** from domain types. Missing entity fields trigger a small "model the domain" detour.
5. **For each step** (a `steps/*.md` file): performer, instructions and strictness, reads and writes, tools from bound plugins (or create one), checkpoint and outcomes. Fully mechanical steps are flagged to run without a model.
6. **Generate components** for human steps and preview them.
7. **Collect example cases** with expected outcomes: real past cases if available.
8. **Dry run** every example in a sandboxed copy and review with the expert.
9. **Publish** as v1 through change control.

### From an existing guide

SOPs and playbooks convert the same way: prose becomes step instructions, implicit decision points become guarded transitions, "ask the user" moments become input steps, and mechanical parts become strict or mechanical steps.

## 5. Maturity and promotion

```
ad hoc (in chat) ─▶ saved (workspace) ─▶ reviewed and versioned (domain) ─▶ packaged (plugin)
```

| Stage | Validation required |
|---|---|
| Ad hoc | None |
| Saved | Schema |
| Reviewed and versioned | Checks, dry run, example cases, approval |
| Packaged | All of that, plus a manifest, declared requirements and default policies |

Promotion patterns: repeated analysis code becomes a tool; a repeated chat request becomes a workflow; a domain workflow useful elsewhere becomes a plugin.

## 6. Guardrails

- Meta workflows run under their own policies. Creating a connector may need approval before credentials are requested.
- Live definitions change only through proposals.
- Generated code runs only in sandboxes until reviewed and given a trusted binding.
