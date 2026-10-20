# 16 · Open questions

Not yet decided. The first group is settled by spikes at the start of the build plan rather than by discussion.

## Settled by spike

Items 1–5 were answered in Phase 0; the answers are D35–D39 in the [decision log](15-decisions.md) and the evidence is in [spikes/](../../spikes/README.md).

1. **DBOS under Bun:** yes (D35).
2. **DBOS versioning:** runs stay on the version they started on; definition versions travel as inputs (D36).
3. **Bundled Postgres on desktop:** yes on Linux, macOS and Windows, under Node and Bun (D37).
4. **The step engine on `pi-ai`:** yes (D38).
5. **XState with DBOS:** yes (D39).

Left open by the spikes, for Phase 1:

- Step timeouts: the run driver must race a running step against its timer and cancel it; not built yet.
- Nested and parallel states, history, `invoke` and `spawn` in XState were not exercised.
- Real prompt-cache hits and providers other than Anthropic were not measured (no key in the spike).
- The macOS 26 compiled icon (`apps/electron/resources/Assets.car`) still shows the old mark and must be rebuilt on a Mac.

Left open by Phase 3:

- Replaying past cases on a draft compares where they started and ended; a step-by-step comparison, and re-running agent steps on a live model, are later.
- A publish that changes the domain re-applies row rules, which can briefly conflict with a read made at the same moment (the reader retries).

Left open by Phase 5 (see the status in [17](17-build-plan.md)):

- Deploying the relay: the domain, wildcard DNS and certificate for one subdomain per install, the R2 bucket for shared pages, and who may publish pages to it (today anyone who can reach it).
- Store-and-forward: while the core is offline the relay shows a plain "offline" page and keeps nothing; whether it should hold submissions until the core is back.
- Durable Object rate limits reset when the object hibernates; subdomain mode and hibernation are untested on Cloudflare itself.
- Link tokens are derived (HMAC of the link's key under a kernel key), and the invite message, link included, is kept in the effect ledger; whether to keep only a masked copy.
- OAuth apps must be registered with the relay's callback before the relay becomes the default OAuth return address.
- Reminders to a client who hasn't answered, and the form app in more languages.
- Every kernel holds one Postgres `LISTEN` connection for the notifier.

## Domain and data

6. **Link versus materialise.** How much plugin data the domain caches or copies by default, especially for analytics.
7. ~~**Several domains per workspace**, and cross-domain references.~~ Settled for Phase 6: see [21](21-domains-and-records.md) (D70, D71).
8. **The first value-type catalogue**, and whether country-specific identifier validators (GSTIN, PAN, VAT) are plugins.
9. **Recall search.** Full-text first; when to add `pgvector`.

## Plugins

10. **Trust levels and signing:** who verifies plugins, and what each level unlocks by default.
11. **Capability naming:** a central catalogue (`email_send`) or free-form with agent-assisted matching.
12. **How much of a Claude plugin imports cleanly** (commands, hooks, agents beyond skills and MCP servers).

## Pages and UI

13. **Bridge:** adopt the MCP Apps bridge directly, or keep today's bridge (renamed) with an adapter.
14. ~~**The relay:** where it runs (our hosted service, self-hosted, an edge worker) and how links are authenticated.~~ Settled in Phase 5: a Cloudflare Worker we host, the same hub self-hosted under Bun, and links as single-use, expiring tokens checked by the core (D66, D67).
15. **The first component vocabulary**, and how much custom HTML workflow components may use.
16. **Map editing:** when drag-and-drop editing on the map is worth building.

## Agents and policy

17. **Rationale capture:** a structured tool call at decision points, or summarising the journal afterwards.
18. **Policy language:** YAML rules only, or natural language compiled to rules at authoring time.
19. **Earned autonomy:** the thresholds, and who approves dropping an approval.
20. **Calibration ownership:** which settings improvement workflows may propose to change.
21. **Parallelism inside a step** ("check these 50 documents") versus parallel regions in the workflow.

## Product

22. **Chat continuity:** what per-person notes and summaries a chat keeps, and when chat storage moves to Postgres.
23. **What the hosted version adds** beyond operations: team features, SSO, compliance.
