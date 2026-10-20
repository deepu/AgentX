/**
 * Phone-sized pictures of every state of the page, light and dark, against the mock server.
 *
 *   bun run build && bun dev/mock-server.ts --port 8790 &
 *   node dev/screenshots.mjs [--base http://localhost:8790] [--out <dir>]
 *
 * Uses the installed Playwright (`playwright` resolvable, or PLAYWRIGHT_MODULE pointing at its
 * index.mjs) and the browser in PLAYWRIGHT_BROWSERS_PATH. Fails on any console error, which
 * includes Content-Security-Policy violations.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('--base', 'http://localhost:8790')
const OUT = arg('--out', join(process.cwd(), 'screenshots'))

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    return import(process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.mjs')
  }
}

const { chromium } = await loadPlaywright()
const executablePath = process.env.CHROMIUM_PATH ?? (process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : undefined)
const browser = await chromium.launch(executablePath ? { executablePath } : {})
await mkdir(OUT, { recursive: true })

const problems = []
const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${name}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`) })

async function shoot(scheme, name, path, act, { fullPage = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  })
  const page = await context.newPage()
  page.on('console', m => { if (m.type() === 'error' && !(name.includes('offline') && m.text().includes('503'))) problems.push(`${name} (${scheme}): ${m.text()}`) })
  page.on('pageerror', e => problems.push(`${name} (${scheme}): ${e.message}`))
  await page.goto(`${BASE}${path}`)
  await page.waitForSelector('.page')
  await page.waitForFunction(() => !document.querySelector('.loading'))
  if (act) await act(page)
  await page.waitForTimeout(150)
  const file = join(OUT, `${name}-${scheme}.png`)
  if (fullPage) {
    // Grow the window to the page instead of stitching, so the sticky send bar sits at the end.
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.setViewportSize({ width: 390, height: Math.max(844, height) })
    await page.waitForTimeout(100)
  }
  await page.screenshot({ path: file })
  console.log('wrote', file)
  await context.close()
}

const pick = (page, files) => page.setInputFiles('[data-field="documents"] input[type=file]:not([capture])', files)

for (const scheme of ['light', 'dark']) {
  const run = Date.now().toString(36)
  const t = suffix => `${suffix}${run}-${scheme}`

  await shoot(scheme, '01-form-empty', `/f/mwl_empty-${t('a')}`)

  await shoot(scheme, '02-form-read-documents', `/f/mwl_empty-${t('b')}`, async page => {
    await pick(page, [pdf('pan-card.pdf'), pdf('gst-certificate.pdf')])
    await page.getByText('We filled in 2 answers from your documents').waitFor()
    await page.locator('[data-field="pan"] [data-badge="extracted"]').click()
  })

  await shoot(scheme, '03-form-checks', `/f/mwl_empty-${t('c')}`, async page => {
    await page.fill('#f-pan', 'aaacr123')
    await page.locator('[data-submit]').click()
    await page.getByText('Please check').first().waitFor()
    await page.evaluate(() => window.scrollTo(0, 0))
  })

  await shoot(scheme, '04-form-server-check', `/f/mwl_invalid-${t('d')}`, async page => {
    await pick(page, [pdf('pan-card.pdf'), pdf('gst-certificate.pdf')])
    await page.getByText('We filled in 2 answers from your documents').waitFor()
    await page.locator('[data-offer="legal_name"] button').click()
    await page.locator('[data-field="business_type"] label', { hasText: 'Private limited' }).click()
    await page.locator('[data-submit]').click()
    await page.getByText('This GSTIN belongs to a different PAN').waitFor()
  })

  await shoot(scheme, '05-form-saved-draft', `/f/mwl_draft-${t('e')}`, async page => {
    const before = await page.locator('[data-save]').textContent()
    await page.fill('#f-legal_name', 'Rao Traders Private Limited')
    await page.waitForFunction(b => {
      const el = document.querySelector('[data-save]')
      return el?.getAttribute('data-save') === 'saved' && el.textContent !== b
    }, before)
    await page.locator('#f-legal_name').blur()
    await page.evaluate(() => document.querySelector('[data-field="client_phone"]').scrollIntoView({ block: 'start' }))
  }, { fullPage: false })

  await shoot(scheme, '06-form-sent-back', `/f/mwl_comments-${t('f')}`)

  await shoot(scheme, '07-form-done', `/f/mwl_comments-${t('g')}`, async page => {
    await page.locator('[data-submit]').click()
    await page.waitForSelector('[data-done]')
  }, { fullPage: false })

  for (const [n, s] of [['08', 'expired'], ['09', 'used'], ['10', 'closed'], ['11', 'revoked'], ['12', 'unknown'], ['13', 'ratelimited']]) {
    await shoot(scheme, `${n}-link-${s}`, `/f/mwl_${s}-${t('h')}`, page => page.waitForSelector('[data-refusal]'), { fullPage: false })
  }
  await shoot(scheme, '14-core-offline', `/f/mwl_offline-${t('i')}`, page => page.waitForSelector('[data-trouble]'), { fullPage: false })

  await shoot(scheme, '15-inbox-decision', `/x/k7q2m4x6p3r5s2t6/i/mwl_decision-${t('j')}`)
  await shoot(scheme, '16-inbox-send-back-confirm', `/i/mwl_decision-${t('k')}`, async page => {
    await page.locator('[data-choice="sent_back"]').click()
    await page.locator('[data-action="confirm"]').click()
    await page.getByText('Please say what needs to change').waitFor()
  })
  await shoot(scheme, '17-inbox-email-approval', `/i/mwl_approval-${t('l')}`)
  await shoot(scheme, '18-inbox-done', `/i/mwl_approval-${t('m')}`, async page => {
    await page.locator('[data-choice="approved"]').click()
    await page.locator('[data-action="confirm"]').click()
    await page.waitForSelector('[data-done]')
  }, { fullPage: false })
  await shoot(scheme, '19-inbox-open-in-app', `/i/mwl_openinapp-${t('n')}`, undefined, { fullPage: false })
}

await browser.close()
if (problems.length) {
  console.error('Console errors:\n' + problems.join('\n'))
  process.exit(1)
}
