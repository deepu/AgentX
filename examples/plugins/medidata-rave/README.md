# Medidata Rave (plugin)

`memwise/medidata-rave` 1.0.0, first-party. Reads a study's sites, site staff, subjects, data
queries and form status from Medidata Rave Web Services (RWS), so the EDC app can show Sites,
Subjects and Queries, build pages from questions ("Old queries by site") and run the playbook
"Chase old queries". Data entry stays in Rave: **every tool only reads** (effect `read`), and nothing
in this plugin can write to Rave.

| Tool | Builtin route | What it reads |
|---|---|---|
| `rave.list_studies` | `rave.rws.list_studies` | The studies the account sees, with enrolment target and plan |
| `rave.list_sites` | `rave.rws.list_sites` | A study's sites, with PI, current coordinator (and since when), target and pages verified |
| `rave.get_site` | `rave.rws.get_site` | One site by reference (`MW-301(Prod)/104`) |
| `rave.site_staff` | `rave.rws.site_staff` | A site's investigators and coordinators |
| `rave.list_subjects` | `rave.rws.list_subjects` | Subjects, when they were randomised, last visit |
| `rave.get_subject` | `rave.rws.get_subject` | One subject (`MW-301(Prod)/104-007`) |
| `rave.list_queries` | `rave.rws.list_queries` | Queries with status and days open; `older_than_days` filters |
| `rave.get_query` | `rave.rws.get_query` | One query (`MW-301(Prod)/Q50001`) |
| `rave.form_status` | `rave.rws.form_status` | Pages entered, verified and overdue per site |

## What you need

1. **A Rave account with Web Services access** for the study (read-only is enough). Your Rave
   administrator creates it; it signs in with HTTP Basic, as RWS does.
2. **These settings for MemWise**, set once for the workspace (the connection). Every tool declares
   `RAVE_URL`, `RAVE_USER` and `RAVE_PASSWORD` as secrets: the tool gateway injects them on each
   call (the app serves them from its settings, only to the builtins that declare them) and redacts
   them from results and errors. Nobody types them into a playbook, and a person running a page or a
   playbook never sees them. `RAVE_URL` must be `https:`, except to this machine (the fake).
   `RAVE_STUDY` is a plain setting, not a secret: the study OID is in every reference a tool returns.

   | Setting | What it is | Example |
   |---|---|---|
   | `RAVE_URL` | The RWS base | `https://acme.mdsol.com/RaveWebServices` |
   | `RAVE_USER` | The Web Services account | `memwise.reader` |
   | `RAVE_PASSWORD` | Its password | |
   | `RAVE_STUDY` | Optional: the study tools default to (and the only one `list_studies` lists) | `MW-301(Prod)` |

Then install and bind it:

```
memwise plugin install <project> examples/plugins/medidata-rave
```

## Records and sync

The manifest's `records:` offers `site`, `subject` and `query`, each keyed by its Rave reference
(`Ref`). The eTMF example's binding (`examples/etmf/domain/bindings/memwise__medidata-rave.yaml`)
maps them onto `edc.Site`, `edc.Subject` and `edc.Query`, links a subject or query to its site with
the `{ link: site }` transform, and sets `sync: { every: 15m }`.

With `sync:`, MemWise reads the sources again on that schedule and keeps a **read-only copy** of the
fields the entity says Rave owns (`ownership:`). Every such field shows Rave as its source, nothing in
MemWise can edit it, and the record page says when it was last read. The copy exists so a change in
Rave becomes a change event in MemWise: a new study coordinator at a site starts eTMF's
"New coordinator" playbook, which asks the site for the coordinator's CV and GCP training (D110).

One owner per fact: with `sync:`, a person or step can't give Rave's fields even when creating a
record (only the key Rave matches by, `rave_ref`), and a record Rave never linked shows those fields
as "Not yet in Medidata Rave", with no "as of". A failed read is recorded and tried again within five
minutes. Calls per read: `list_sites` reads a study's sites, users and form status (three calls, not
one per site); `list_studies` reads form status per study, for at most 25 studies (set `RAVE_STUDY`
on a larger account); `list_queries` with `older_than_days` asks Rave for open queries only. The
`query` record source reads every status, so a query closed in Rave is closed here too.

## Testing without Rave

`packages/runtime/tests/fixtures/fake-rave-http.ts` is a fake RWS with study MW-301 (12 sites,
186 subjects, 142 open queries, 23 of them older than 14 days) and a small MW-207. Run it on its own:

```
bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790
RAVE_URL=http://127.0.0.1:4790/RaveWebServices RAVE_USER=rave.reader RAVE_PASSWORD=not-a-real-password
```

`POST /__fake/coordinator` with `{ "site": "104", "name": "…", "email": "…" }` changes a site's
coordinator while it runs.

**Needs Sandeep: a Rave/Veeva sandbox.** The client speaks RWS paths with the fake's JSON bodies;
a real Rave answers ODM XML and clinical views. `packages/server-core/src/memwise/rave/client.ts` is
the one file to check against a sandbox.
