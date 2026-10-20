# 06 · Pages and UI

This doc reconciles AgentX's **Pages** feature, which we discussed first, with the **domain** and **workflow** model, which we arrived at later. The short version: pages stay, but they become one kind of view over the domain, plus the components that let people take part in workflows.

## 1. Three layers of UI

| Layer | Who builds it | Examples | Changes how |
|---|---|---|---|
| **Shell** (fixed, first-party) | The platform | Inbox, case view, run monitor, step chat, domain editor, plugin manager | Product releases |
| **Components** (workflow UI) | Plugins, or generated at authoring time | Intake form, approval card, document review, checklist, file upload | Versioned with the workflow |
| **Pages** (standalone) | Generated on demand, or page templates from plugins | Receivables dashboard, pipeline tracker, a calculator | Ad hoc, then saved and versioned |

*(Agreed)* The shell is fixed and polished, because every plugin depends on it. Everything inside it can be generated (principle P9).

## 2. What a page is

The basic UI unit stays what AgentX Pages already are:
- a self-contained HTML document,
- rendered in a sandboxed frame with an opaque origin and no network access,
- talking to the host only through a **message bridge**.

AgentX's bridge (`craft-pages/v1`) already provides:
- initial data and live data updates,
- actions executed by the host through approved grants, and
- opening links.

See `apps/electron/resources/docs/pages.md` and `packages/shared/src/pages/action-bridge.ts`.

The two roles below use the same unit with different bindings.

## 3. Role A: standalone pages *(Agreed: kept)*

Standalone pages are for ad hoc needs: "show me receivables by age", "a tracker for this quarter's hiring". They're created in chat, live on their own, and can be shared.

**What changes from AgentX today:**

| Aspect | AgentX today | MemBase |
|---|---|---|
| Data | A private store per page (key-value entries and time series in SQLite, plus `snapshot.json`) | **Domain queries first.** The page declares queries over entities and cases ("open cases by state", "Invoices where Overdue") and gets live results. A private store remains for data that is local to the page (for example a time series a script collects). |
| Refresh | A cron schedule plus a workspace script, per page | A **trigger plus a mechanical workflow** that writes to the domain. Pages over domain queries update automatically. |
| Actions | Grants per page, tied to the HTML's content digest | Kept for standalone pages. Grants are stored as **domain policies**, so they're visible in one place, and impact analysis covers them. |
| Sharing | A public view-only link (optionally password-protected), or publish as a Claude artifact | Kept. Snapshots of shared pages respect field-level access. |

**The payoff:** a dashboard over the domain shows the same data that workflows use. "Receivables dashboard" and the "Overdue follow-up" workflow read the same `Invoice` entities.

## 4. Role B: workflow components *(Agreed)*

Components are the human side of a workflow. They come in three kinds:

| Kind | Purpose | Examples |
|---|---|---|
| **Ask** (input) | A step needs information or a decision from a person | Intake form, approval card, "choose an option" card, file upload |
| **Show** (work product) | A step produced something people should read or review | Risk memo, reconciliation report, draft email, generated contract |
| **Watch** (monitor) | Live view of a run or case | Case summary card, run diagram with the current state highlighted |

### 4.1 Fixed data, flexible look *(Agreed)*
A component's **fields come from the step's declared inputs and outputs**, which are case-type fields. The agent never invents fields at run time. That's what makes forms reliable:
- **The data contract is fixed:** field names, value types, required fields and validators, all from the case type.
- **The presentation is flexible:** layout, grouping, wording and help text. These can be generated, and are usually generated once at authoring time and versioned with the workflow.

### 4.2 A small component vocabulary *(Proposed)*
A standard set covers most needs and keeps generated UIs consistent, safe and testable:
- **Form**, generated from a schema, with sections, conditional fields and file drop
- **Approval card:** approve, reject, send back with comments, or approve with edits
- **Document review:** a rendered document with comments anchored to text and version history
- **Checklist:** items with evidence attached
- **Table / list** of entities or cases, with filters
- **Chart** over domain data or time series
- **Case summary:** key fields, provenance badges, timeline
- **Choice card:** pick one of N options, each with its consequence

Custom HTML stays available as an escape hatch, under the same sandbox and policy rules.

### 4.3 Format: MCP Apps *(Proposed)*
Workflow components follow the **MCP Apps** pattern: a tool or step references a `ui://` resource (HTML), the host renders it in a sandbox, and the component talks back over a JSON-RPC bridge.

Benefits:
- **No invented UI format.** It's the standard that Claude, ChatGPT and others render.
- A plugin's components can also appear inside other hosts when its tools are exposed over MCP.
- AgentX's `craft-pages/v1` bridge is very similar already. An adapter, or a move to the MCP Apps bridge, connects the two.

### 4.4 Permissions come from the step *(Agreed)*
A component can call only what its **step's policy** allows, not separately approved grants per page.

For example, an intake form may call `extract_fields` while the client fills it in, even though the run is paused waiting on the client. It can't call anything else.

### 4.5 Work products are case fields
A memo or report produced by a step is stored as a `Document` field in the case. It is versioned (each re-run or repair creates a new version), tied to the step that produced it, and rendered by a document component. Reviewer comments become **repair context** for the producing step: the comment loop from SlashDocs, built into the workflow.

## 5. External participants

When the performer is outside the organisation, such as a client or vendor:
- They get a **single-use, expiring link**, delivered through email or a messaging channel plugin.
- The link shows **only the component for that step and the case fields it exposes.** Nothing else from the domain is visible.
- Interactive components need **public hosting of interactive forms**. AgentX's public pages are view-only today, so this is new.
- Inputs from outside participants are **untrusted**. They're validated against the schema, rate-limited, and any tools they trigger (such as extraction) run with the narrowest policy.
- They can save a draft and come back.

## 6. Templates and instances

- Plugins and domains hold **templates**: component definitions and page templates.
- A run creates **instances** bound to its case. A standalone page is created from a template, or ad hoc.
- Templates are versioned with their workflow or plugin. An instance pins the template version it was created from.

## 7. The run monitor and the diagram

The run monitor is a shell surface that shows:
- **the workflow diagram**, laid out automatically from the statechart, with the current state(s) highlighted and past transitions traced,
- **a timeline** of step records, and
- **click a state → chat with that step** (see [05 §9](05-workflows-and-steps.md)).

*(Agreed)* **The diagram is a view; the definition is the source of truth.** Editing on a canvas, or sketching a workflow freehand and having an agent turn the sketch into a valid machine, is a later nice-to-have. A canvas library like tldraw is deferred.

## 8. The inbox

The inbox is the single most important shell surface. It holds everything waiting on *you*:
- approvals, input requests and reviews assigned to your role or to you,
- "needs a person" escalations, and
- identity matches and mapping questions from meta workflows.

Each item opens its component in place. The same items can be delivered to Telegram, WhatsApp or email through channel plugins, where the component is simple enough to handle there (approve or reject, choose an option).

## 9. Maturity path for pages *(Agreed)*

```
ad hoc page in chat ──▶ saved page in the workspace ──▶ reviewed and versioned ──▶ page template in a plugin
```

Most pages stay at the first or second stage. Only pages worth sharing across domains become templates.

## 10. Summary: how pages relate to each other part

| Concept | Relationship to pages |
|---|---|
| **Domain** | Pages query it; components read and write case fields; grants are stored as domain policies |
| **Workflow** | Components are bound to steps; work products are case fields shown by document components |
| **Plugin** | Ships components and page templates; its tools can expose `ui://` components |
| **Core** | Hosts the sandbox, carries the bridge, enforces policy, serves external links |
| **Shell** | Holds pages and components: inbox, case view, run monitor |
