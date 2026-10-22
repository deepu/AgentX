// Launch the MemWise Electron app under Xvfb and take screenshots.
// usage: node shot.mjs <configDir> <projectDir> <outDir> [script.mjs]
import { _electron as electron } from 'playwright';
import { mkdirSync } from 'fs';
const [configDir, projectDir, outDir, scriptPath] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
// A walkthrough talks to the scripted model only: whatever reaches a real model (a base URL, a key,
// a token in the shell that started it) never reaches the app.
const BLOCKED = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !BLOCKED.includes(k)));
const app = await electron.launch({
  executablePath: process.env.MEMWISE_REPO + '/node_modules/electron/dist/electron',
  args: [process.env.MEMWISE_REPO + '/apps/electron', '--no-sandbox'],
  cwd: process.env.MEMWISE_REPO + '',
  env: { ...env, MEMWISE_CONFIG_DIR: configDir, MEMWISE_PROJECT_DIR: projectDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  timeout: 120000,
});
app.process().stdout.on('data', d => process.stdout.write('[main] ' + d));
app.process().stderr.on('data', d => process.stderr.write('[main!] ' + d));
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
const shot = async (name) => { await win.screenshot({ path: `${outDir}/${name}.png` }); console.log('shot', name); };
globalThis.win = win; globalThis.app = app; globalThis.shot = shot;
try {
  if (scriptPath) { const m = await import(scriptPath); await m.default({ win, app, shot }); }
  else { await win.waitForTimeout(15000); await shot('start'); }
} catch (e) { console.error('SCRIPT ERROR', e); await shot('error').catch(()=>{}); }
await app.close();
