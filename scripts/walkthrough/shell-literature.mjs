// The Literature example rebuilt on pages (doc 26 §6, Stage 2), in the project shell. Start the app
// with MEMWISE_SEED=literature-home so the Home looks like mock LHome (seed-literature.ts), then:
// Home → ask → a draft page and its chat (LAsk) → Keep → a parent page (LTopic) → a kept page with
// a change waiting (LBoard) → Review an answer change (LChange) → Accept → the page's history.
const wait = (win, ms) => win.waitForTimeout(ms);

async function sidebar(win, text) {
  await win.locator('[data-testid="project-sidebar"]').getByText(text, { exact: true }).first().click();
  await wait(win, 2500);
}

async function ask(win, text) {
  const box = win.locator('[data-testid="shell-composer"] textarea').first();
  await box.fill(text);
  await box.press('Enter');
}

export default async ({ win, shot }) => {
  try { await win.getByText('Setup later').first().click({ timeout: 10000 }); } catch {}
  await win.waitForSelector('[data-testid="project-screen"]', { timeout: 90000 });
  // The seed runs once the kernel is ready; its pages show in the sidebar.
  await win.locator('[data-testid="shell-written-pages"]').getByText('GLP-1', { exact: true }).waitFor({ timeout: 90000 });
  await sidebar(win, 'Home');
  await wait(win, 3000);
  await shot('01-lhome');

  // Asking on Home makes a draft page with the chat beside it.
  const sugg = win.locator('[data-testid="project-home-chat"] button').filter({ hasText: /weight come back/i }).first();
  if (await sugg.count()) await sugg.click(); else await ask(win, 'Does weight come back after switching from injections to a pill?');
  await win.waitForSelector('[data-page]', { timeout: 30000 }).catch(() => {});
  await wait(win, 8000);
  await shot('02-asked-draft-page');
  console.log('URL', decodeURIComponent(win.url().split('route=')[1] ?? ''));

  // LAsk: the side-effects question, answered in the chat beside its draft page under GLP-1.
  await sidebar(win, 'GLP-1');
  await sidebar(win, 'Side effects');
  await ask(win, 'How often do people stop oral GLP-1s because of side effects?');
  await wait(win, 9000);
  await shot('03-lask');

  // Keep it: weekly, under GLP-1.
  const keep = win.locator('[data-action="keep-page"]').first();
  if (await keep.count()) {
    const parent = win.locator('[data-keep-parent]').first();
    const glp = await parent.locator('option').filter({ hasText: 'GLP-1' }).first().getAttribute('value').catch(() => null);
    if (glp) await parent.selectOption(glp);
    await keep.click();
    await wait(win, 3000);
  }
  await shot('04-kept-weekly');

  // LTopic: the parent page sums its kept sub-pages.
  await sidebar(win, 'GLP-1');
  await wait(win, 2000);
  await shot('05-ltopic');

  // LBoard: a kept page with an answer change waiting.
  await sidebar(win, 'Weight loss');
  await wait(win, 2000);
  await shot('06-lboard');

  // LChange: Review an answer change, its chat beside it.
  const review = win.locator('[data-action="review-change"]').first();
  if (await review.count()) await review.click();
  else await sidebar(win, 'Waiting for you');
  await win.waitForSelector('[data-page-change]', { timeout: 20000 });
  await wait(win, 2000);
  await ask(win, 'What changed?');
  await wait(win, 9000);
  await shot('07-lchange');

  // Accept: the page updates for everyone, and its history says so.
  await win.locator('[data-action="accept-change"]').first().click();
  await wait(win, 6000);
  await shot('08-after-accepting');
  await sidebar(win, 'Weight loss');
  await wait(win, 3000);
  await shot('09-weight-loss-updated');

  // Heart failure sums three sub-pages; Waiting for you holds the reply to sign.
  await sidebar(win, 'Heart failure');
  await wait(win, 2500);
  await shot('10-heart-failure');
  await sidebar(win, 'Waiting for you');
  await wait(win, 2500);
  await shot('11-waiting');
  const runs = await win.evaluate(async () => {
    const ws = new URLSearchParams(location.search).get('workspaceId');
    return (await window.electronAPI.memwiseListCases(ws)).map(c => `${c.workflowId} ${c.status} ${c.state} ${c.title}`);
  });
  console.log('RUNS', JSON.stringify(runs));
  await sidebar(win, 'Home');
  await wait(win, 3000);
  await shot('12-lhome-after');
};
