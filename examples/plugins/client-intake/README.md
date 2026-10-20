# Client intake (plugin)

`memwise/client-intake` 1.0.0, first-party. The client intake playbook from `examples/intake`, packaged
as a plugin and written in its own terms (docs/memwise/22-phase-4-interfaces.md §2):

- it needs a **`Client`** entity with `name`, `email`, `tax_id` (a GSTIN) and `pan`;
- its steps are assigned to the roles **`staff`** and **`manager`**;
- it sends email through **`email.send`**, the tool the domain binds for the capability `email_send`
  (for example the one `memwise/sample-email` provides);
- it ships two tools on builtin routes, `gst.validate_gstin` and `intake.extract_fields` (quarantined),
  and a default rate limit on the extractor.

Installing it copies this folder into the project's `plugins/memwise__client-intake/1.0.0/`, where it does
nothing. Binding it (the bind-plugin playbook) maps `Client → Customer` (with `tax_id → gstin`),
`email_send → email.send` and the roles; once the binding is frozen, `client-intake` becomes a live
playbook "from Client intake 1.0.0", and its example cases run through the binding.

```
memwise plugin install <project> examples/plugins/client-intake
```
