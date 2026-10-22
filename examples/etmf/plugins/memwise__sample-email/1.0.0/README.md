# Sample email (plugin)

`memwise/sample-email` 1.0.0, first-party. One tool, `email.send` (`outbound`, idempotent), on the builtin
route: the app's sandbox sender, which writes each message to the `mw_sandbox.outbox` table keyed by its
idempotency key, so nothing leaves the machine and a retried send is recorded once.

It **provides** the capability `email_send`. Plugins that need to send email (such as
`memwise/client-intake`) require `email_send` and name it `email.send` in their own workflows; the binding
says which bound tool fills it. Because its one tool is already classified, binding it needs no agent step:
check, propose, dry run, review, freeze.

```
memwise plugin install <project> examples/plugins/sample-email
```
