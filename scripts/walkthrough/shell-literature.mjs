const wait = (win, ms) => win.waitForTimeout(ms);
export default async ({ win, shot }) => {
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }); } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 90000 });
  await wait(win, 4000);
  await shot('01-lhome');
  const sugg = win.locator('[data-testid="project-home-chat"] button').filter({ hasText: /side effects/i }).first();
  if (await sugg.count()) await sugg.click(); else {
    const box = win.locator('[data-testid="shell-composer"] textarea'); await box.fill('How often do people stop oral GLP-1s because of side effects?'); await box.press('Enter');
  }
  await wait(win, 12000);
  await shot('02-lasked');
  console.log('URL', decodeURIComponent(win.url().split('route=')[1]));
  await win.locator('[data-testid="project-sidebar"]').getByText('Home', { exact: true }).click(); await wait(win, 3000);
  await shot('03-lhome-after');
};
