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
config needs a workspace already listed, or the first run drops the connection. It goes through the
switcher, a study's Home and Project settings, publishes template v5 and reviews it (MW-301 already
does it; MW-207 tested and taken), Waiting for you across projects, the app home, New project from a
template card, and New project described in chat (the scripted model calls `project_draft`), then
Start study.
