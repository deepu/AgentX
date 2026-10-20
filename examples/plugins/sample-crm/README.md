# Sample CRM (a Claude plugin)

A **Claude plugin**, not a MemWise one: there is no `memwise-plugin.yaml`. MemWise imports it the way it
imports any Claude plugin (docs/memwise/22-phase-4-interfaces.md §2): `.claude-plugin/plugin.json` gives the
name and version (id `claude/sample-crm`, trust `community`), `.mcp.json` the MCP server `crm`, and
`skills/crm-etiquette/SKILL.md` a skill. The `commands/` folder is a Claude Code slash command: MemWise
ignores commands, hooks and agents and says so in the install report.

`server.mjs` is a dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0, protocol version
2025-06-18) holding a few company contacts:

| Tool | Annotations | In MemWise |
|---|---|---|
| `list_contacts` | `readOnlyHint` | `crm.list_contacts`, proposed as `read` |
| `get_contact` `{ id }` | `readOnlyHint` | `crm.get_contact`, proposed as `read` (used to read fields through a link) |
| `create_contact` `{ company_name, email?, gst_number?, phone?, idempotency_key? }` | none | `crm.create_contact`, unclassified until the binding classifies it |

The built-in contacts: `c-101` Acme Traders Pvt Ltd (its GST number is stored in lower case on purpose),
`c-102` Menon Exports (no GST number), `c-103` Zenith Logistics. Binding the plugin maps `contact` records
onto the domain's `Customer` and links them by GSTIN, then by name.

- `SAMPLE_CRM_SEED=<file.json>`: start from this array of contacts instead.
- `SAMPLE_CRM_DATA=<file.json>`: keep the contacts there (read at start when present, written on every create).

Try it by hand:

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"me","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_contacts","arguments":{}}}' | node server.mjs
```
