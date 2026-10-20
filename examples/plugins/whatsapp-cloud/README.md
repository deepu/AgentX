# WhatsApp through the Cloud API (plugin)

`memwise/whatsapp-cloud` 1.0.0, first-party. Sends WhatsApp messages from your business number
through Meta's WhatsApp Business Cloud API, so a client can get the link to their form on WhatsApp
instead of by email, and people can get their inbox items there. One tool, `whatsapp.send`
(`outbound`, idempotent), on the builtin route `whatsapp.cloud.send`.

## How it fits

MemWise calls WhatsApp by one fixed name, `whatsapp.send`; the step that sends a client their link
(`external.invite`) uses it when the case says to contact them by WhatsApp. Binding this plugin
makes it the provider of the capability `whatsapp_send`. Every message is an outgoing message, so
by default someone approves it first, and the approval card shows the exact text.

`whatsapp.send` takes `{ to, body }` for a text message or `{ to, template: { name, language, params } }`
for a template, and returns `{ message_id, to }`, where `message_id` is WhatsApp's (`wamid.…`).

## What you need

1. **A Meta Business account** (business.facebook.com) for your business.
2. **A WhatsApp Business Platform app** at developers.facebook.com: create an app of type
   *Business*, add the *WhatsApp* product, and add your business phone number to it (a number not
   already used in the WhatsApp or WhatsApp Business app on a phone). Meta gives a free test number
   to try things with.
3. **Two values from that app:**
   - the **phone number ID** (WhatsApp → API Setup; a long number, not the phone number itself);
   - a **permanent access token**: in Business Settings → Users → System users, add a system user,
     give it your app and the WhatsApp account with *full control*, and generate a token with the
     `whatsapp_business_messaging` and `whatsapp_business_management` permissions. (The token on
     the API Setup page expires within a day; it is only for trying things out.)
4. **An approved message template for links.** WhatsApp lets a business start a conversation only
   with a template Meta has approved; plain text is allowed only within 24 hours after the person
   last wrote to you. In WhatsApp Manager → Message templates, create a template:
   - name `memwise_form_link`, category *Utility*, your language (for example English, `en`);
   - a body with three placeholders, in this order: the client's name, your business name, the
     link. For example: *Hello {{1}}, {{2}} has asked you to fill in a short form: {{3}}. The link
     works once and expires in a few days.*

   Approval usually takes minutes to a day. Then tell MemWise to use it (below). Until you do,
   links go out as plain text, which only reaches people who wrote to you in the last 24 hours.
5. **These settings for MemWise**, as environment variables of the app or server (set them before
   you start MemWise; on a server, in its service's environment). When a secret store is set up for
   the app, values it holds under these names are used first.

   | Setting | What it is |
   |---|---|
   | `WHATSAPP_TOKEN` | The permanent access token (required) |
   | `WHATSAPP_PHONE_NUMBER_ID` | The phone number ID (required) |
   | `WHATSAPP_INVITE_TEMPLATE` | The approved template's name, `memwise_form_link` |
   | `WHATSAPP_API_BASE` | Only for tests: another address for the API (default `https://graph.facebook.com/v21.0`) |

6. **A public address** (Settings → Public address), so the links open from a phone.

Then install and bind the plugin:

```
memwise plugin install <project> examples/plugins/whatsapp-cloud
```

or **Plugins → Install → WhatsApp (Cloud API)** in the app, then **Bind**.

## Delivery updates (optional)

Messages send without this. To see "delivered" and "read" on the case, WhatsApp needs an address to
send updates to, which only works with a public address:

1. In MemWise, make a webhook for WhatsApp with the scheme `meta` and a verify token of your
   choosing (a long random word); MemWise shows its address, `https://<your public address>/h/<hook id>`.
   (In this version the webhook is made through the kernel API, `kernel.channels.createWebhook({
   purpose: 'whatsapp-status', plugin: 'memwise/whatsapp-cloud', scheme: 'meta', verifyToken })`;
   a screen for it is still to come.)
2. In your app at developers.facebook.com, WhatsApp → Configuration → Webhook: paste that address
   as the *Callback URL* and the same verify token, then **Verify and save**. Meta calls the address
   once with `hub.challenge`, and MemWise answers it.
3. Under *Webhook fields*, subscribe to `messages` (it carries the delivery statuses).

MemWise checks every update's `x-hub-signature-256` against your app's *App secret* (App
settings → Basic) before it records it, so only Meta can post there. Updates are recorded and
change the message's status on the case; replying to incoming messages comes later.

## Sending twice

A message is sent once per call: MemWise keeps the idempotency key of every message it has sent
(the `mw_channels.sent` table) and answers a retried call with the earlier message id instead of
sending again. The WhatsApp API itself has no such protection, so this table is what keeps a retry
after a crash from reaching the client twice.
