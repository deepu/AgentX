# 11 · Open questions

These are decisions not yet made, each with the current leaning where there is one.

## Engine and format

1. **Which workflow engine?**
   - **XState v5:** TypeScript, saves and restores run state, has a visual editor, but may be more than we need.
   - **A small custom engine:** simple core, but we'd build durability ourselves.
   - **A durable execution engine underneath:** Temporal, or Cloudflare Workflows if hosted there.

   *Leaning:* settle the definition format first, then prototype on XState with persisted snapshots.
2. **Definition format:** YAML or JSON statechart in our own schema, or the XState or SCXML format directly? *Leaning:* our own small schema (steps, transitions, guards, case type) that compiles to the engine's format, so domain-level concepts like performer, strictness and checkpoint stay first-class.
3. **Parallelism inside a step** (for example "check these 50 documents") versus parallel regions in the workflow. Where is the line?

## Domain and data

4. **Link versus copy defaults.** How much plugin data should the domain cache or materialise, especially for analytics?
5. **Storage of definitions.** In the store only, or also as files in git for review and diffs? *Leaning:* the store is the source of truth, with export to files for review.
6. **Multi-domain organisations.** Can one workspace see more than one domain? How do cross-domain references work?
7. **Value type catalogue.** The exact first set, and how country-specific identifiers (GSTIN, PAN, VAT) get validators. Are they plugins themselves?

## Plugins

8. **Plugin manifest format** and its compatibility with Claude and ChatGPT plugin formats (skills, MCP servers, apps). How much can be shared?
9. **Trust levels and signing:** who verifies plugins, and what each trust level unlocks by default.
10. **Capability naming:** a central catalogue (`email_send`, `document_signing`), or free-form names with agent-assisted matching?

## Pages and UI

11. **Bridge:** adopt the MCP Apps bridge directly, or keep `craft-pages/v1` with an adapter?
12. **Public hosting of interactive forms** for external participants: where it runs (relay, edge worker, self-hosted), and how links are authenticated.
13. **Component vocabulary:** the first set, and how much custom HTML is allowed in workflow components versus standalone pages.
14. **Canvas authoring** (sketch a workflow, edit the diagram): deferred. Revisit after the core works.

## Agents and policy

15. **Rationale capture:** how to get agents to record decision-time reasons cheaply and reliably (a structured tool call at decision points, versus summarising the transcript afterwards).
16. **Strictness enforcement for agent steps:** is checking that values came from tool results enough, or do strict steps need to run on a restricted agent loop?
17. **Policy language:** declarative rules (YAML), code, or natural language compiled to rules at authoring time (principle P1)?
18. **Calibration ownership:** which settings may improvement workflows propose to change, and who approves them?

## Product and scope

19. **Relationship to AgentX upstream.** Build MemBase as a layer on top of AgentX that keeps the upstream sync intact, or fork deeply? *Leaning:* a layer (domain store, workflow runtime and policy engine as new packages), touching upstream code only at integration points.
20. **First reference domain** to build end to end. Candidates: client intake (Scenario 1) or the connector meta workflow (Scenario 2).
