import { seedEtmf } from './seed-etmf.mjs';
const wait = (win, ms) => win.waitForTimeout(ms);
export default async ({ win, shot }) => {
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }); } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 90000 });
  console.log('SEED', JSON.stringify(await seedEtmf(win)));
  await wait(win, 5000);
  const side = win.locator('[data-testid="project-sidebar"]');
  await win.locator('[data-testid="project-switcher"]').click(); await wait(win, 500);
  await win.locator('[data-testid="switch-project-etmf"]').click(); await wait(win, 3500);
  await shot('01-home');
  // Ask from Home
  await win.getByText('What needs me today?', { exact: true }).click();
  await win.waitForSelector('[data-testid="shell-chat"]', { timeout: 30000 });
  await wait(win, 9000);
  await shot('02-home-asked');
  console.log('URL home asked', decodeURIComponent(win.url().split('route=')[1]));
  // Waiting for you, with its chat
  await side.getByText('Waiting for you', { exact: true }).click(); await wait(win, 2500);
  const box = win.locator('[data-testid="shell-composer"] textarea');
  await box.fill('What should I do first?'); await box.press('Enter');
  await win.waitForSelector('[data-testid="shell-chat"]', { timeout: 30000 }); await wait(win, 9000);
  await shot('03-waiting');
  // Open the item and approve it (signed)
  await win.locator('[data-testid="waiting-open"]').first().click(); await wait(win, 3000);
  await shot('04-item');
  await win.getByRole('button', { name: 'Approve' }).first().click(); await wait(win, 1500);
  await shot('05-sign');
  const pw = win.locator('input[type="password"]');
  const n = await pw.count(); console.log('password fields', n);
  for (let i = 0; i < n; i++) await pw.nth(i).fill('walkthrough-pass-1');
  const signBtn = win.getByRole('button', { name: /sign|set password|approve/i }).last();
  await signBtn.click().catch(e => console.log('sign click', e.message)); await wait(win, 4000);
  await shot('06-after-sign');
  // Page from the tree, a playbook, a record
  const tree = side.locator('[data-active], div[role="button"]');
  for (const label of ['Aster Bio', 'MW-301']) {
    const row = side.getByText(label, { exact: false }).first();
    if (await row.count()) { await row.locator('xpath=..').locator('button[aria-label="Expand"]').click().catch(() => {}); await wait(win, 1200); }
  }
  await shot('07-tree');
  const health = side.getByText('TMF health').first();
  if (await health.count()) { await health.click(); await wait(win, 3500); await shot('08-page'); } else console.log('no TMF health in tree');
  await side.getByText('Activate a site', { exact: true }).click(); await wait(win, 3000); await shot('09-playbook');
  await side.getByText('Sites', { exact: true }).click(); await wait(win, 3000);
  await win.locator('[data-testid="shell-page-column"]').getByText('104 · ', { exact: false }).first().click(); await wait(win, 3500);
  await shot('10-record');
  const seen = await win.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /^(All Sessions|New Session|Flagged|Archived|Labels)$/.test(e.textContent.trim()) && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').map(e => e.textContent.trim()));
  console.log('CHAT LIST VISIBLE?', JSON.stringify(seen));
};
