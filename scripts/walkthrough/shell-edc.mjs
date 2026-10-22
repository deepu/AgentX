// Stage 6 (doc 26 §9): the EDC app in the project shell, read from a fake Medidata Rave, with
// projects (Part B): EDC's study projects (examples/etmf/projects/edc-mw301, edc-mw207) each name
// their study, Rave is read per project, and each is linked to eTMF's project of the same study.
//
// Start the fake first and give the app its address (the plugin reads RAVE_* when the connection
// holds none). It needs the eTMF example's seeds (Stage 3), which run only when the project folder
// is made from the example at start:
//
//   bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790 --user rave --password rave
//   RAVE_URL=http://127.0.0.1:4790/RaveWebServices RAVE_USER=rave RAVE_PASSWORD=rave \
//   MEMWISE_EXAMPLE_PROJECT_DIR=$PWD/examples/etmf MEMWISE_REPO=$PWD xvfb-run -a ... \
//     node scripts/walkthrough/launch.mjs <configDir> <projectDir that doesn't exist> <outDir> $PWD/scripts/walkthrough/shell-edc.mjs
//
// It waits for the first read of Rave, then: the switcher with EDC and its study projects
// (XSwitcher) → EDC's Study MW-301 (XEdcHome, and "Also in other apps": eTMF's Study MW-301, linked
// through the project) → the old queries page (XQueries) → site 104 in EDC with each fact's owner
// (XSite) → "Open in eTMF" → the same site in eTMF (XSite-etmf) → back, and the study in eTMF
// (XStudy-etmf) → EDC's Study MW-207 (XEdcHome-207).
const wait = (win, ms) => win.waitForTimeout(ms);

async function until(win, what, fn, ms = 180000) {
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
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 120000 });
  const api = (method, ...args) => win.evaluate(async ([method, args]) => {
    const ws = new URLSearchParams(location.search).get('workspaceId');
    return await window.electronAPI[method](ws, ...args);
  }, [method, args]);
  // Rave's two studies, each read into its EDC project (a first read on start, then every 15 minutes).
  const read = await until(win, 'the first read of Rave', async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId');
    const per = {};
    for (const project of ['edc-mw301', 'edc-mw207']) {
      const r = await window.electronAPI.memwiseQueryRecords(ws, { entity: 'edc.Site', limit: 1, project });
      per[project] = r.total;
    }
    return per['edc-mw301'] >= 12 && per['edc-mw207'] >= 6 ? per : null;
  });
  console.log('EDC sites by project', JSON.stringify(read));
  const apps = await api('memwiseListApps');
  console.log('apps', JSON.stringify(apps.map(a => [a.id, a.projects.map(p => `${p.id}:${p.study ?? ''}`)])));
  await wait(win, 5000);
  const switcher = () => win.locator('[data-testid="project-switcher"]').click().then(() => wait(win, 700));
  const toProject = async (id) => { await switcher(); await win.locator(`[data-testid="switch-project-${id}"]`).click(); };

  // 1. The switcher: EDC and its study projects beside eTMF's.
  await switcher();
  await shot('XSwitcher');
  await win.locator('[data-testid="switch-project-edc-mw301"]').click();
  await win.waitForSelector('[data-edc-home="MW-301"]', { timeout: 30000 });
  await wait(win, 2500);
  await shot('XEdcHome');
  await win.waitForSelector('[data-other-project="mw301"]', { timeout: 30000 });
  await win.locator('[data-other-project="mw301"]').scrollIntoViewIfNeeded(); await wait(win, 800);
  await shot('XEdcHome-2');

  // 2. The old queries page.
  await win.locator('[data-open-queries]').click(); await wait(win, 4000);
  await shot('XQueries');
  console.log('URL queries', decodeURIComponent(win.url().split('route=')[1] ?? ''));

  // 3. Site 104 in EDC, then the same site in eTMF.
  await toProject('edc-mw301'); await wait(win, 3000);
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

  // 4. The study in eTMF, opened from EDC's "Also in other apps": in eTMF's project of the same study.
  await toProject('edc-mw301');
  await win.waitForSelector('[data-other-project="mw301"]', { timeout: 30000 }); await wait(win, 1500);
  await win.locator('[data-other-project="mw301"]').click(); await wait(win, 4000);
  await shot('XStudy-etmf');
  console.log('URL etmf study', decodeURIComponent(win.url().split('route=')[1] ?? ''));

  // 5. EDC's other study project reads only its own study.
  await toProject('edc-mw207');
  await win.waitForSelector('[data-edc-home="MW-207"]', { timeout: 30000 }); await wait(win, 2500);
  await shot('XEdcHome-207');
};
