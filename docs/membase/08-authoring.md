# 08 · Building by conversation

Everything in MemBase can be created through chat: entity types, mappings, plugin bindings, workflows, components, pages, connectors and tools. The mechanism is the same everywhere: **meta workflows**, which are workflows whose output is a definition.

## 1. Why this works: evidence from AgentX

AgentX's "add Linear as a source" feels magical, but it's a simple recipe:
1. **A playbook.** `sources.md` (about 900 lines) explains the setup process: check for a service-specific guide, interview the user, research the API, write the config, set read-only permissions, write a usage guide, test.
2. **A pointer in the system prompt.** It tells the agent to read the playbook before working on sources.
3. **Validation tools.** `source_test` and `config_validate` check the config. The auth triggers (`source_oauth_trigger` and others) handle sign-in.
4. **Plain files** that the agent writes: `config.json`, `permissions.json`, `guide.md`.
5. **Code-enforced rules.** For example, a source's tools are blocked until its `guide.md` has been read.

AgentX uses the same pattern for skills, automations, pages, labels and task generation. MemBase makes the pattern official.

## 2. The recipe for every kind of definition *(Agreed)*

| Ingredient | Purpose |
|---|---|
| **Playbook** | How to interview the person and design this kind of thing well, written for the agent |
| **Schema** | What a valid definition looks like |
| **Validator** (code) | Accepts or rejects a draft, with errors the agent can fix. Workflows also get structural checks (see [05 §10](05-workflows-and-steps.md)). |
| **Dry run** | Try it before it goes live: a test call for a connector, a preview for a form, a run on sample cases for a workflow, a round trip on sample records for a mapping |
| **Publish** | Review, then freeze with a version. Older versions stay available. |

Each meta workflow is a plugin of its own (for example "Connectors", "Workflows", "Domain modelling"), so the authoring experience can improve independently of the core.

## 3. Meta workflows

| Meta workflow | Output | Typical steps |
|---|---|---|
| **Model the domain** | Entity types, relationships, lifecycles, rules | Interview → draft model → review diagram → freeze |
| **Create a connector** | A connector plugin | Today's source setup: research → configure → test → sign in → write guide |
| **Bind a plugin** | A plugin binding | Capability check → entity binding → data mapping → policy review → dry run → freeze |
| **Create a workflow** | A workflow definition | Interview the expert about their process → draft statechart → define steps → generate components → example cases → dry run → freeze |
| **Design a component or page** | A component template or page | Pick from the vocabulary → generate presentation → preview → save |
| **Create a tool** | A tool in a plugin | Specify inputs and outputs → write code in a sandbox → test on examples → declare environment → publish |
| **Improve a workflow** | A proposal | Analyse corrections and failures → propose changes → check against example cases → approve |

## 4. Creating a workflow, step by step

This is the most important meta workflow, because it's how a domain expert's process becomes software.

1. **Interview** in the expert's own words: "Walk me through what happens when a new client signs up." The agent asks about checkpoints, who approves what, what can go wrong, deadlines, and what data is involved.
2. **Find the steps.** The agent proposes the domain checkpoints. It merges small actions into meaningful steps and splits steps that hide an approval (principle P2).
3. **Draft the statechart**, including the paths that aren't the happy path: send-backs, timeouts, "needs a person". It's shown as a diagram.
4. **Define the case type** from domain entities and value types. Missing entity fields trigger a small "model the domain" detour.
5. **For each step:**
   - choose who performs it,
   - write the instructions with the expert, and set how strict they are,
   - pick tools from the bound plugins (or create a tool), and
   - define the checkpoint.

   Steps that are fully mechanical are flagged and compiled to run without an agent (principle P1).
6. **Generate components** for human steps from the step's declared fields, then preview them.
7. **Collect example cases**: real past cases if available, otherwise made-up ones. Define the expected outcomes.
8. **Dry run** every example through the workflow in a sandboxed domain copy, then review the results with the expert.
9. **Validate** the structure, then **freeze it as v1**.

## 5. Creating a workflow from an existing guide

Many organisations already have SOPs, playbooks or guides like `sources.md`. Converting one is a variant of §4:
- The guide's prose becomes **step instructions**.
- Its implicit decision points ("if the API is limited, use the browser") become **transitions with guards**.
- Its "ask the user" moments become **human input steps**.
- Its mechanical parts (validate, test) become **strict or mechanical steps**.

An assessment of `sources.md` against today's AgentX task model found that only about half its steps fit, because human steps and branching aren't supported yet. The statechart model fits all of them.

## 6. The maturity path *(Agreed)*

```
ad hoc (in chat) ──▶ saved (workspace) ──▶ reviewed and versioned (domain) ──▶ packaged (plugin)
```

| Stage | Validation required |
|---|---|
| Ad hoc | None. A throwaway. |
| Saved | Schema validation |
| Reviewed and versioned | Validator, dry run, example cases, a person's approval |
| Packaged | Everything above, plus a manifest, declared requirements and default policies |

Most things stay ad hoc or saved. That's fine. The path exists so the useful ones can mature without being rebuilt.

## 7. Promotion patterns

- **Ad hoc analysis → tool:** the same agent-written analysis code keeps appearing in step records, so the agent proposes making it a tool.
- **Repeated chat request → workflow:** "do the monthly close" has been asked in chat several times, so the agent proposes capturing it as a workflow.
- **Domain-local workflow → plugin:** a workflow is useful beyond one domain, so it's packaged with its requirements stated in the plugin's own terms, ready to bind elsewhere.

## 8. Guardrails for authoring

- Meta workflows run under their own policies. Creating a connector may need a person's approval before credentials are requested.
- Anything frozen changes only through proposals (principle P8). Authoring a new version never edits the frozen one in place.
- Generated code (tools, mappings) runs only in sandboxes, until it's reviewed and assigned a trusted binding.
