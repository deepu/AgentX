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
`shell-literature.mjs` asks on the Literature example's Home.
`shell-edc.mjs` (Stage 6) needs the fake Rave running and its address in the environment
(`RAVE_URL=http://127.0.0.1:4790/RaveWebServices RAVE_USER=rave RAVE_PASSWORD=rave`, see the script's header). It
seeds eTMF's side of study MW-301, waits for the first read of Rave, and goes from the EDC Home (XEdcHome) to the old
queries page (XQueries), to site 104 in EDC (XSite), and with "Open in eTMF" to the same site in eTMF.
