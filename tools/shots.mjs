// Capture the four shots in shots.json from a locally served game/, using playwright-core with the
// Chromium that lives beside the shot-tools package. Also plays each scene headlessly: any page
// error or console error fails the run, so a broken build cannot quietly produce pretty JPEGs.
//
//   node tools/shots.mjs            (writes screenshots/*.jpg, needs a browser)
//   node tools/shots.mjs --serve    (spawns `node serve.ts --port 8901` itself; default)
import { chromium } from '/home/hatch/workspace/makefun/shot-tools/node_modules/playwright-core/index.mjs';
import { statSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const port = 8901;
const base = `http://127.0.0.1:${port}/index.html`;
const outDir = join(root, 'screenshots');
const execPath = process.env.CHROMIUM_PATH ?? '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';

const shots = JSON.parse(readFileSync(join(root, 'shots.json'), 'utf8'));

const server = spawn(process.execPath, [join(root, 'serve.ts'), '--port', String(port)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (b) => process.stdout.write('[serve] ' + b));
server.stderr.on('data', (b) => process.stderr.write('[serve] ' + b));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(900);

const browser = await chromium.launch({ executablePath: execPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failures = 0;
const report = [];

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + shot.query, { waitUntil: 'load' });
  // Wait for the scene to flag itself ready rather than guessing at a delay.
  try {
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 12000 });
  } catch {
    errors.push('timeout: __shotReady never set');
  }
  await wait(220);
  const file = join(outDir, shot.name);
  await page.screenshot({ path: file, type: 'jpeg', quality: 78 });
  const size = statSync(file).size;
  const flag = errors.length > 0 ? 'ERRORS' : size < 12000 ? 'TOO SMALL' : size > 262144 ? 'TOO BIG' : 'ok';
  if (flag !== 'ok') failures += 1;
  report.push({ file: shot.name, bytes: size, flag, errors: errors.join(' | ') });
  await page.close();
}

// A live play-through in the same run: title -> Enter -> drive for a few seconds.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + '?seed=1', { waitUntil: 'load' });
  await wait(500);
  await page.keyboard.press('Enter');
  await wait(400);
  await page.keyboard.down('ArrowUp');
  await wait(1200);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.press('KeyE');
  await wait(300);
  await page.keyboard.down('ArrowUp');
  await wait(2200);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.down('KeyD');
  await wait(700);
  await page.keyboard.up('KeyD');
  await page.keyboard.press('KeyP');
  await wait(250);
  await page.keyboard.press('KeyP');
  await wait(500);
  const state = await page.evaluate(() => window.__shotReady === true);
  if (!state) report.push({ file: 'live', bytes: 0, flag: 'ok', errors: errors.join(' | ') });
  console.log('live play errors:', errors.length ? errors.join(' | ') : 'none');
  await page.close();
}

await browser.close();
server.kill('SIGTERM');

for (const row of report) {
  console.log(`${row.file}: ${row.bytes} bytes  ${row.flag}${row.errors ? '  ' + row.errors : ''}`);
}
if (failures > 0) {
  console.error(`${failures} shot(s) failed`);
  process.exit(1);
}
console.log('all shots ok, zero page errors');
