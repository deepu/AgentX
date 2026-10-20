# 09 · Chat

Chat stays. It's how people ask questions, get things done ad hoc, and build and change workflows. MemWise keeps one **always-on chat** and lets people open a chat **on anything**.

## 1. Every chat has an anchor *(Decided)*

| Anchor | Example | What the chat sees | What it can do |
|---|---|---|---|
| **Home** (the workspace) | "What's waiting on me today?" | The inbox, recent runs, the domain at large | Anything the person may do, through the normal gateway |
| **Workflow** | "Make the check step also verify the PAN" | The workflow's files, its example cases, recent runs | Edit the workflow as a **draft** ([05 §10](05-workflows.md)) |
| **Run or case** | "Why is Acme stuck?" | The case, its step records and trace | Explain; start a correction through the checkpoint |
| **Step** (in a run) | "Why is this flagged high severity?" | That step record and what it linked to | Explain, correct, what-if ([05 §11](05-workflows.md)) |
| **Entity** | "Show me everything about Acme" | The entity, its links and history | Queries; start a workflow on it |
| **Page** | "Add a column for days overdue" | The page and its queries | Edit the page |

The always-on chat is the home anchor. Opening a chat from anywhere else anchors it there. **The anchor sets the chat's context and its permissions**, so a chat on one case can't wander into another unless the person could.

## 2. A chat acts as the person

- A chat runs on the **open engine** and acts **as the person** who is chatting, through the same tool and effect gateway and the same policy as everything else. It can never do more than the person could do by hand.
- Effects follow their class: a chat that wants to send an email shows a preview and asks, just like a step would.
- Chat never changes a live definition or a case silently. Definition edits become drafts; case corrections go through the step's checkpoint.

## 3. Building and changing workflows by chat

- **Creating a workflow by chat is a run of the "create a workflow" meta workflow** ([11](11-authoring.md)). The interview is an open, conversational step of that run, so building is itself recorded, resumable and reviewable.
- **Changing a workflow by chat** edits the same files the editor shows. Changes appear highlighted in the step editor and the map's "proposed change" mode, with check and example-case results. The person keeps or discards them.
- **Repeated requests become workflows.** If "do the monthly close" keeps being asked in chat, the agent proposes capturing it as a workflow.

## 4. Storage *(Decided)*

- **Chat transcripts stay on files for now**, as today's sessions do (`{workspace}/sessions/{id}/session.jsonl`), in the object store on servers. Moving chat storage early is risk with no payoff for workflows.
- **Anchors are rows in Postgres** (chat ID, anchor kind and ID, person, timestamps), so "all chats about Acme" or "chats on this workflow" are queries.
- The new runtime uses Postgres from its first line; chat follows when there's a reason.

## 5. Continuity

A chat needs continuity in a way a workflow step doesn't: what the person said last week, what they prefer. That stays a chat feature (summaries and per-person notes on the anchor), built on today's transcript summaries. It is deliberately not a workflow primitive ([07 §3](07-agent-runtime.md)).

## 6. In the UI

The existing chat screen is kept as it is, because it's one of the most mature parts of the code. What changes is where it's opened from: the inbox, a case, a step on the map, a workflow's editor, an entity, a page. The step editor shows chat beside the editing card. See [10](10-experience.md).
