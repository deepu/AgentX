// Stage 6 (doc 26 §9): the EDC app in the project shell, read from a fake Medidata Rave.
// Start the fake first and give the app its address (the plugin reads RAVE_* when the connection
// holds none):
//
//   bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790 --user rave --password rave
//   RAVE_URL=http://127.0.0.1:4790 RAVE_USER=rave RAVE_PASSWORD=rave MEMWISE_REPO=$PWD xvfb-run -a ... \
//     node scripts/walkthrough/launch.mjs <configDir> <projectDir> <outDir> $PWD/scripts/walkthrough/shell-edc.mjs
//
// It seeds eTMF's side of the study (MW-301, site 104 and its start-up pack) through the app's own
// calls, waits for the first read of Rave, then: the EDC Home (XEdcHome) → the old queries page
// (XQueries) → site 104 in EDC with each fact's owner (XSite) → "Open in eTMF" → the same site in eTMF.
const wait = (win, ms) => win.waitForTimeout(ms);

async function seed(win) {
  return await win.evaluate(async () => {
    const api = window.electronAPI;
    const ws = new URLSearchParams(location.search).get('workspaceId');
    const create = async (entity, values, status) => {
      const r = await api.memwiseCreateRecord(ws, { entity, values, ...(status ? { status } : {}), reason: 'study set-up' });
      if (!r.applied) throw new Error(`create ${entity}: ${r.message}`);
      return r.id;
    };
    const existing = await api.memwiseQueryRecords(ws, { entity: 'etmf.Sponsor' }).catch(() => null);
    if (existing && existing.total > 0) return 'already seeded';
    const sponsor = await create('etmf.Sponsor', { name: 'Meridian Pharma' });
    const study = await create('etmf.Study', { code: 'MW-301', title: 'Meriglutide once weekly (phase 3)', sponsor });
    const site = await create('etmf.Site', { site_number: '104', study });
    const pack = [['Protocol signature page', true], ['FDA Form 1572', true], ['Lab normal ranges', false], ['Investigator CV', true]];
    for (const [artifact, filed] of pack) await create('etmf.ExpectedDocument', { site, study, artifact, phase: 'start_up' }, filed ? 'filed' : undefined);
    return 'seeded';
  });
}

async function until(win, what, fn, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await win.evaluate(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(win, 2000);
  }
}

export default async ({ win, shot }) => {
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }); } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 90000 });
  // Rave's sites, read by the binding (a first read on start, then every 15 minutes).
  const sites = await until(win, 'the first read of Rave', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId');
    const r = await window.electronAPI.memwiseQueryRecords(ws, { entity: 'edc.Site', limit: 1 });
    return r.total >= 12 ? r.total : null;
  });
  console.log('EDC sites', sites, 'SEED', await seed(win));
  await wait(win, 5000);

  await win.locator('[data-testid="project-switcher"]').click(); await wait(win, 500);
  await win.locator('[data-testid="switch-project-edc"]').click();
  await win.waitForSelector('[data-edc-home="MW-301"]', { timeout: 30000 });
  await wait(win, 2500);
  await shot('XEdcHome');
  await win.locator('[data-testid="shell-page"]').evaluate(e => e.scrollTo(0, e.scrollHeight)); await wait(win, 800);
  await shot('XEdcHome-2');

  await win.locator('[data-open-queries]').click(); await wait(win, 4000);
  await shot('XQueries');
  console.log('URL queries', decodeURIComponent(win.url().split('route=')[1] ?? ''));

  await win.locator('[data-testid="project-switcher"]').click(); await wait(win, 500);
  await win.locator('[data-testid="switch-project-edc"]').click(); await wait(win, 3000);
  await win.locator('[data-site="104"]').click(); await wait(win, 3500);
  await shot('XSite');
  await win.locator('[data-owned-facts]').scrollIntoViewIfNeeded().catch(() => {}); await wait(win, 800);
  await shot('XSite-facts');
  console.log('URL site', decodeURIComponent(win.url().split('route=')[1] ?? ''));

  await win.locator('[data-open-in]').first().click(); await wait(win, 3500);
  await shot('XSite-etmf');
  await win.locator('[data-owned-facts]').scrollIntoViewIfNeeded().catch(() => {}); await wait(win, 800);
  await shot('XSite-etmf-facts');
  console.log('URL etmf site', decodeURIComponent(win.url().split('route=')[1] ?? ''));
};
