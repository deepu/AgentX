# Walkthrough scripts

Screenshots of the desktop app for the docs walkthroughs, taken without an API key: the chat runs on
scripted replies (`fake-anthropic.mjs`), so the words in the chat are written in advance, not the
model's. Everything else (the kernel, Postgres, the playbooks, the screens) is real.

1. Build the app: `bun run electron:build`. `launch.mjs` needs Playwright (`npm i -g playwright`, or link it next to the script).
2. Start the scripted model: `node scripts/walkthrough/fake-anthropic.mjs 8787 scripts/walkthrough/etmf-replies.json`.
3. Make a config folder whose `config.json` has a connection to it, and an empty `postgres` folder the
   postgres OS user can write (when running as root):
   ```json
   { "llmConnections": [{ "slug": "walkthrough", "name": "Scripted (walkthrough)", "providerType": "anthropic",
       "baseUrl": "http://127.0.0.1:8787", "authType": "api_key_with_endpoint",
       "models": [{ "id": "claude-sonnet-5-5", "name": "Sonnet 5.5", "shortName": "Sonnet", "description": "Scripted" }],
       "defaultModel": "claude-sonnet-5-5" }],
     "defaultLlmConnection": "walkthrough", "setupDeferred": true }
   ```
4. Copy an example as the project, and run a flow under Xvfb:
   ```sh
   MEMWISE_REPO=$PWD xvfb-run -a -s "-screen 0 1440x900x24" \
     node scripts/walkthrough/launch.mjs <configDir> <projectDir> <outDir> $PWD/scripts/walkthrough/shell-etmf.mjs
   ```

Both eTMF flows need the fake Rave too (EDC's sites come only from Rave): start
`bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790 --user rave --password rave` and launch with
`RAVE_URL=http://127.0.0.1:4790/RaveWebServices RAVE_USER=rave RAVE_PASSWORD=rave`.

`shell-etmf.mjs` seeds the eTMF example through the app's own calls (`seed-etmf.mjs`) and goes Home → asks →
Waiting for you → opens and approves the activation → a page from the tree → a playbook → a record.
`shell-literature.mjs` walks the Literature example rebuilt on pages (doc 26 §6). Start it with
`MEMWISE_SEED=literature-home` (the owner becomes the lead, and the Home looks like mock `LHome`) and
`literature-replies.json`. It goes Home → asks → a draft page with its chat (`LAsk`) → Keep → GLP-1 (`LTopic`) →
Weight loss with a change waiting (`LBoard`) → Review an answer change (`LChange`) → Accept. The scripted model
calls no tools, so a refresh it has to write (GLP-1's summary after the accept) stops at its write step.

When another MemWise window is already open on the machine, pass `--user-data-dir=<dir>` in `launch.mjs`'s
`args`, or the second app quits at once (one instance per user data folder).

`stage3-projects.mjs` (Stage 3, replies in `stage3-replies.json`) needs the eTMF example's seeds, which
run only when the project folder is made from the example at start: set
`MEMWISE_EXAMPLE_PROJECT_DIR=$PWD/examples/etmf` and give a `<projectDir>` that doesn't exist yet. Its
config needs a workspace already listed, or the first run drops the connection. Run it with the fake Rave too: the seeded
sites are numbered as in Rave, and take their names from EDC's sites, which come only from Rave. It goes through the
switcher, a study's Home and Project settings, publishes template v5 and reviews it (MW-301 already
does it; MW-207 tested and taken), Waiting for you across projects, the app home, New project from a
template card, and New project described in chat (the scripted model calls `project_draft`), then
Start study.

`regulated-etmf.mjs` is the Stage 5 walkthrough (change request, audit trail, inspector access, TMF index). Its agent
steps need tool calls, so start the scripted model with the classifier and verifier of `regulated-tools.mjs`, and
give both processes the same index file (the flow writes it; the classifier reads it):
```sh
WALKTHROUGH_INDEX=$dir/index.json node scripts/walkthrough/fake-anthropic.mjs 8800 \
  scripts/walkthrough/regulated-replies.json scripts/walkthrough/regulated-tools.mjs
WALKTHROUGH_INDEX=$dir/index.json MEMWISE_REPO=$PWD xvfb-run -a -s "-screen 0 1440x900x24" \
  node scripts/walkthrough/launch.mjs <configDir> <projectDir> <outDir> $PWD/scripts/walkthrough/regulated-etmf.mjs
```
Playbook steps read the model connection's key when the app starts: the first launch saves a placeholder key for
the scripted connection and stops; launch again on the same config folder, with an empty `postgres` folder and a
fresh copy of the example. The QA signature isn't in it (a regulated project allows no "act as"); the exit test
`stage5-exit.test.ts` covers it, and writes the inspector's page as `EInspector-*.png` when
`MEMWISE_WALKTHROUGH_DIR` is set.

`shell-edc.mjs` (Stage 6) needs the fake Rave running and its address in the environment
(`RAVE_URL=http://127.0.0.1:4790/RaveWebServices RAVE_USER=rave RAVE_PASSWORD=rave`, see the script's header), and
the eTMF example's seeds, as for `stage3-projects.mjs` (`MEMWISE_EXAMPLE_PROJECT_DIR=$PWD/examples/etmf` and a
`<projectDir>` that doesn't exist yet). It waits for the first read of Rave into EDC's two study projects, then
goes through the switcher (XSwitcher), EDC's Study MW-301 (XEdcHome) with its link to eTMF's Study MW-301, the old
queries page (XQueries), site 104 in EDC (XSite) and with "Open in eTMF" the same site in eTMF, the study opened in
eTMF's project (XStudy-etmf), and EDC's Study MW-207 (XEdcHome-207).
