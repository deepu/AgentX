# 10 · Experience: the app, pages and components

## 1. Built on the Craft Agents UI *(Decided)*

MemWise builds on the existing app rather than starting again. The desktop shell, chat, tool-call display, permission prompts, sources and skills screens, theming and the web UI (`apps/webui`) are mature, and redoing them would take months for no gain.

What changes:

| Today | MemWise |
|---|---|
| Navigation is organised around chat sessions | Navigation is organised around **workflows, cases and the inbox**, with chats anchored to them |
| Screens read files through the local server | Screens read Postgres through the server's API; components stay the same where possible |
| Craft Agents branding | MemWise branding throughout (the Craft names and logos are trademarked) |

New screens are built from the existing components (`packages/ui`) so they look native.

## 2. Three layers of UI

| Layer | Built by | Examples |
|---|---|---|
| **Shell** (fixed, first-party) | The platform | Inbox, case view, run monitor and map, playbook, step editor, chat, domain editor, plugin manager |
| **Components** (workflow UI) | Plugins, or generated at authoring time | Intake form, approval card, document review, checklist |
| **Pages** (standalone) | Generated in chat, or page templates from plugins | Receivables dashboard, a tracker, a calculator |

The shell is fixed and polished because everything depends on it. Everything inside it can be generated.

## 3. Shell surfaces

- **Inbox:** the most important surface. Everything waiting on you: approvals, inputs, reviews, "needs a person", identity matches and mapping questions. Each item opens its component in place. Simple items (approve, choose) can also be handled in WhatsApp, Telegram or email through channel plugins.
- **Case view:** the case's fields with provenance badges, its timeline of step records, its documents, and chat.
- **Run monitor and map:** the map in live mode ([05 §9](05-workflows.md)), with the timeline; click a step to open its record or chat with it.
- **Playbook:** the default view of a workflow for domain experts.
- **Step editor:** instructions, reads and writes, tools, effective policy, checkpoint and outcomes, with chat beside it.
- **Chat:** the existing chat screen, opened from any anchor ([09](09-chat.md)).

## 4. What a page is

The basic UI unit stays what Pages already are: a self-contained HTML document, rendered in a sandboxed frame with an opaque origin and no network access, talking to the host only through a message bridge (`craft-pages/v1` today, renamed with everything else). The bridge provides initial data, live updates, actions executed by the host, and link opening.

### Standalone pages

| Aspect | Today | MemWise |
|---|---|---|
| Data | A private SQLite store per page plus `snapshot.json` | **Domain queries first** ("open cases by state", "Invoices where Overdue"). A private store remains for page-local data. |
| Refresh | Cron plus a workspace script per page | A trigger plus a mechanical workflow that writes to the domain; pages over domain queries update live |
| Actions | Grants per page tied to the HTML digest | Grants become **policies**, visible in one place and covered by impact analysis |
| Sharing | View-only public link, or publish as an artifact | Kept; shared snapshots respect field-level access |

### Workflow components

| Kind | Purpose | Examples |
|---|---|---|
| **Ask** | A step needs input or a decision | Intake form, approval card, choice card, file upload |
| **Show** | A step produced something to read or review | Risk memo, reconciliation report, draft email |
| **Watch** | Live view of a run or case | Case summary, map with the current step |

- **Fixed data, flexible look.** A component's fields come from the step's declared reads and writes. The agent never invents fields at run time. Layout and wording can be generated, usually once at authoring time, and are versioned with the workflow.
- **A small vocabulary** covers most needs: form, approval card, document review, checklist, table, chart, case summary, choice card. Custom HTML is the escape hatch, under the same sandbox and policy.
- **MCP Apps format.** A step or tool references a `ui://` resource; the host renders it in a sandbox and talks over a JSON-RPC bridge. No invented UI format, and components can appear in other hosts when tools are exported over MCP.
- **Permissions come from the step.** A component can call only what its step's policy allows. An intake form may call `extract_fields` while the client fills it in, and nothing else.
- **Work products are case fields** (`Document`), versioned per re-run, rendered by a document component. Reviewer comments become repair context for the step that produced them.

## 5. External participants

When the performer is a client or vendor:
- They get a **single-use, expiring link** by email or a channel plugin.
- The link shows **only that step's component** and the case fields it exposes.
- Interactive public forms need our own **relay** (today's public sharing uses a Cloudflare worker that isn't in the open-source code). See [12](12-state-and-packaging.md).
- Their inputs are untrusted: validated against the schema, rate-limited, and any tools they trigger run with the narrowest policy and quarantined reading.
- They can save a draft and come back.

## 6. Maturity path for pages

```
ad hoc page in chat ─▶ saved in the workspace ─▶ reviewed and versioned ─▶ page template in a plugin
```

Most pages stay at the first or second stage.
