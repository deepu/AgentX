# @memwise/external-form

The page a business's client opens from a MemWise link (docs/memwise/23-phase-5-interfaces.md §4-6):
one step's form at `/f/<token>`, or one inbox item for a person at `/i/<token>`. A small Vite + React
app with no app shell. It imports only types (`@memwise/defs/external`), sets no cookies, keeps
nothing in the browser (drafts are saved on the link, server side), calls nothing but its own
link's API, and runs under the page's CSP (no inline scripts or styles).

```
bun run build        # → dist/
bun run typecheck
bun test src         # the pure parts: values, money, checks, suggestions → pre-fill, Markdown, routes
bun run mock         # dev/mock-server.ts on :8790, every state (see the list at the top of that file)
bun run screenshots  # node dev/screenshots.mjs: 390×844, light and dark, against the mock
```

## What the public handler serves

`dist/` after `bun run build`:

```
dist/index.html               the HTML shell (no data in it)
dist/assets/form/form-<hash>.js
dist/assets/form/style-<hash>.css
```

With `<base>` the install's public base (`https://<installId>.<relay-domain>` in subdomain mode,
`https://<relay>/x/<installId>` in path mode, or a server's own `MEMWISE_PUBLIC_URL`):

| Request | Answer |
|---|---|
| `GET <base>/f/<token>` and `GET <base>/i/<token>` | `dist/index.html`, as is, for every token (even unknown ones: the page asks the API and shows the refusal). Headers: `content-type: text/html; charset=utf-8`, `cache-control: no-store`, `content-security-policy: default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. |
| `GET <base>/assets/form/<file>` | `dist/assets/form/<file>` (i.e. `GET <base>/assets/<path>` → `dist/assets/<path>`), with its content type; the names carry a hash, so `cache-control: public, max-age=31536000, immutable` is fine. Refuse paths with `..`. |
| `<base>/f/<token>/api/…`, `<base>/i/<token>/api/…` | The JSON API in 23 §4 and §6. |

The shell refers to its files as `../assets/form/…`, which from `<base>/f/<token>` (or `/i/<token>`)
resolves to `<base>/assets/form/…` in both address modes; the script and stylesheet refer to anything
else relative to themselves. A trailing slash (`/f/<token>/`) would break that, so redirect it or
answer 404.

The page finds its token and its API from the path (`src/route.ts`): everything before `/f/` or
`/i/` is the base, and calls go to `<base>/f/<token>/api/form`, `/api/draft` (PUT `{ values }`),
`/api/files?name=<name>` (POST, the raw bytes with the file's own `content-type`), `/api/extract`
(POST `{ documents }`), `/api/submit` (POST `ExternalSubmitInput`); `<base>/i/<token>/api/item` and
`/api/decide` (POST `InboxLinkDecision`). Every answer is JSON (`content-type: application/json`);
an answer that isn't JSON (the relay's offline page, a proxy's error) is shown as "This form isn't
available right now". A `LinkRefusal` (`{ status, message }`) is a plain page of its own, with the
server's `message` as its text (a fallback per status when it is empty), so word those for the
participant.

## How it behaves

- **Fields** come from `ExternalFormField` and the page never guesses types: identifiers are
  upper-cased as typed when `upperCase`, checked against `pattern` (anchored when it isn't), and
  show `placeholder` as "Like ABCDE1234F"; money shows the currency and groups the digits (lakhs for
  INR); booleans are a Yes / No choice (so "not answered" exists); enums of up to five options are
  radio buttons, longer ones a select; files use the native picker, plus "Take a photo" (`capture`)
  on touch screens. The core checks everything again; its `invalid` errors appear on the fields.
- **Reading the documents.** When the form offers `extract`, its documents field comes first, and
  each batch of uploads into it is read straight away (only the new files): the person dropped
  files in to be spared typing, and a separate tap is easy to miss on a phone. "Read my documents"
  stays available for files not read yet (after a reload) and after a failure. Confident
  suggestions (`prefill`, `found`) fill a field only when it is empty or still holds an earlier
  suggestion, never over what the person typed or what was on the case; they show "from
  pan-card.pdf" (tap to see the quote). Everything else is offered under its field: "Found in
  pan-card.pdf: AAACA1234A · Use this". On submit, `sources` names the suggestion for every value
  that is still exactly what it said (the core checks again).
- **Drafts** save 1.2 s after the last change, when the page is hidden, and when the connection
  returns; the bar shows "Saved at 10:42".
- **Inbox links**: decisions show their outcomes (`comment: 'required'` asks for words), approvals
  show the preview (to, subject, body) with Approve / Don't send; every choice has a confirming
  step before the POST. `openInApp` items say to open MemWise instead.
