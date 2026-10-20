# Email over SMTP (plugin)

`memwise/email-smtp` 1.0.0, first-party. Sends real email through your own mail server, so the
links MemWise sends to clients ("please fill in your details"), reminders and inbox notifications
reach people's mailboxes. One tool, `email.send` (`outbound`, idempotent), on the builtin route
`email.smtp.send`.

## How it fits

MemWise calls email by one fixed name, `email.send`: the step that sends a client their link
(`external.invite`), reminders and notifications all call it, and so do playbooks that send email.
Whichever plugin your domain binds as the provider of the capability `email_send` answers to that
name. This plugin and the sample email plugin (`memwise/sample-email`, which only writes to a local
outbox) both provide it, so **bind one of them, not both**: two plugins can't both bind
`email.send`, and the second one is refused with "already bound". To switch from the sample to real
email, turn the sample's binding off (or remove it), then bind this one. Plugins that need email
(such as `memwise/client-intake`) keep naming `email.send` in their own steps; their binding's
`capabilities: { email_send: email.send }` then points at this plugin.

Every email is an outgoing message, so by default someone approves it before it is sent: the
approval card shows the exact message and who it goes to. Your playbook's policy says who may
approve.

## What you need

1. **A mailbox that may send** for the address your clients will see, for example
   `hello@yourbusiness.com`. Any mail provider that offers SMTP works: your own mail server, Google
   Workspace, Microsoft 365, Zoho, Amazon SES, Postmark, Mailgun, SendGrid.
2. **Its SMTP details** from that provider: the server name, the port, and a user name and
   password. Google and Microsoft accounts with two-step sign-in need an *app password* instead of
   your normal password; transactional services (SES, Postmark…) give you SMTP credentials of their
   own, and want the sending address or domain verified first.
3. **These settings for MemWise**, as environment variables of the app or server (set them before
   you start MemWise; on a server, in its service's environment):

   | Setting | What it is | Example |
   |---|---|---|
   | `SMTP_HOST` | The mail server (required) | `smtp.gmail.com` |
   | `SMTP_PORT` | Its port; default 587, or 465 with `SMTP_SECURE=tls` | `587` |
   | `SMTP_SECURE` | `starttls` (port 587, the default), `tls` (port 465) or `none` (only for a mail relay on this machine) | `starttls` |
   | `SMTP_USER` | The user name to sign in with | `hello@yourbusiness.com` |
   | `SMTP_PASSWORD` | Its password or app password | |
   | `SMTP_FROM` | Who the email is from (required) | `Acme Advisors <hello@yourbusiness.com>` |

   When a secret store is set up for the app, values it holds under these names are used first.
   The password is never sent over a plain connection to another machine: with `SMTP_SECURE=none`
   MemWise only signs in to a server on this computer.
4. **A public address** (Settings → Public address), so the links in the emails open from a client's
   phone. Without one, sending a link stops with "connect a public address in Settings".

Then install and bind the plugin:

```
memwise plugin install <project> examples/plugins/email-smtp
```

or **Plugins → Install → Email (SMTP)** in the app, then **Bind**. Its one tool is already
classified, so binding needs no agent step: check, propose, dry run, review, freeze.

## What it sends

Each message carries a `Message-ID` made from the call's idempotency key and an
`X-MemWise-Idempotency-Key` header. If a send is retried after a crash, MemWise first looks the key
up among the messages it has sent (the `mw_channels.sent` table) and answers with the earlier
result instead of sending again; the stable `Message-ID` lets mail programs show a rare repeat only
once. Text is sent as is; when the caller gives HTML too, the message is `multipart/alternative`.

The tool returns `{ message_id, accepted, from }`. A refusal from the server (a wrong password, a
recipient it won't take) comes back as the step's error, in the server's own words.
