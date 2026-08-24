/**
 * Verifies the built PWA actually works with the network off.
 *
 * Serves dist/ under the GitHub Pages base path, loads it in Chromium, waits
 * for the service worker to take control, then cuts the network and reloads.
 * Everything must still work from the precache.
 *
 *   npm run verify:pwa
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

// Must match the base the bundle was built with.
const BASE = process.env.VITE_BASE ?? '/Poker-Trainer/';
const PORT = 4178;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (!path.startsWith(BASE)) { res.writeHead(404).end('outside base'); return; }
  path = path.slice(BASE.length) || 'index.html';
  if (path.endsWith('/')) path += 'index.html';
  const file = join('dist', normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));
const url = `http://localhost:${PORT}${BASE}`;
const fail = (msg) => { console.error(`  FAIL  ${msg}`); process.exitCode = 1; };
const pass = (msg) => console.log(`  ok    ${msg}`);

// This sandbox preinstalls Chromium at a fixed path; CI runners use
// Playwright's own download. Prefer the fixed path when it exists.
const { existsSync } = await import('node:fs');
const localChromium = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(
  existsSync(localChromium) ? { executablePath: localChromium } : {},
);
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },   // iPhone-sized
  serviceWorkers: 'allow',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

console.log(`\nVerifying ${url}\n`);

// --- 1. First load, online -------------------------------------------------
await page.goto(url, { waitUntil: 'networkidle' });
const title = await page.title();
title === 'Poker Equity Trainer' ? pass(`title: ${title}`) : fail(`title was ${title}`);

// --- 2. Manifest -----------------------------------------------------------
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return { error: 'no manifest link' };
  const res = await fetch(link.href);
  return res.json();
});
for (const [key, expected] of [
  ['name', 'Poker Equity Trainer'], ['display', 'standalone'],
  ['start_url', BASE], ['scope', BASE], ['theme_color', '#0F1A18'],
]) {
  manifest[key] === expected
    ? pass(`manifest.${key} = ${expected}`)
    : fail(`manifest.${key} was ${JSON.stringify(manifest[key])}, expected ${expected}`);
}
const sizes = (manifest.icons ?? []).map((i) => i.sizes);
sizes.includes('192x192') && sizes.includes('512x512')
  ? pass('manifest icons include 192px and 512px')
  : fail(`manifest icons were ${sizes.join(', ')}`);
(manifest.icons ?? []).some((i) => i.purpose === 'maskable')
  ? pass('manifest has a maskable icon')
  : fail('no maskable icon');

// --- 3. iOS-specific tags --------------------------------------------------
for (const [selector, label] of [
  ['meta[name="apple-mobile-web-app-capable"][content="yes"]', 'apple-mobile-web-app-capable'],
  ['link[rel="apple-touch-icon"]', 'apple-touch-icon'],
  ['meta[name="viewport"][content*="viewport-fit=cover"]', 'viewport-fit=cover'],
  ['meta[name="theme-color"]', 'theme-color'],
]) {
  (await page.locator(selector).count()) > 0 ? pass(label) : fail(`missing ${label}`);
}

// --- 4. Icons actually resolve --------------------------------------------
for (const icon of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  const status = await page.evaluate(
    async (u) => (await fetch(u)).status, `${BASE}${icon}`,
  );
  status === 200 ? pass(`${icon} served`) : fail(`${icon} returned ${status}`);
}

// --- 5. Service worker takes control --------------------------------------
const swReady = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return Boolean(reg.active);
});
swReady ? pass('service worker active') : fail('service worker never activated');

// Give workbox a moment to finish writing the precache.
await page.waitForTimeout(1500);
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  let total = 0;
  for (const name of names) total += (await (await caches.open(name)).keys()).length;
  return { names, total };
});
cached.total >= 5
  ? pass(`precached ${cached.total} entries in ${cached.names.length} cache(s)`)
  : fail(`only ${cached.total} entries precached`);

// --- 6. The engine runs ----------------------------------------------------
await page.getByRole('button', { name: /run benchmarks/i }).click();
await page.waitForSelector('table tbody tr td.good, table tbody tr td.bad', { timeout: 60_000 });
const verdict = await page.locator('.verdict').first().innerText();
verdict.includes('within tolerance')
  ? pass(`engine online: ${verdict}`)
  : fail(`engine verdict: ${verdict}`);

// --- 7. OFFLINE: the real test --------------------------------------------
await context.setOffline(true);
pass('network cut');
await page.reload({ waitUntil: 'domcontentloaded' });
const offlineTitle = await page.title();
offlineTitle === 'Poker Equity Trainer'
  ? pass('page reloaded with no network')
  : fail(`offline reload gave title ${offlineTitle}`);

const offlineChip = await page.locator('.chip').nth(1).innerText();
offlineChip.toLowerCase().includes('offline')
  ? pass(`offline state detected: "${offlineChip}"`)
  : fail(`offline chip read "${offlineChip}"`);

await page.getByRole('button', { name: /run benchmarks/i }).click();
await page.waitForSelector('table tbody tr td.good, table tbody tr td.bad', { timeout: 60_000 });
const offlineVerdict = await page.locator('.verdict').first().innerText();
offlineVerdict.includes('within tolerance')
  ? pass(`engine offline: ${offlineVerdict}`)
  : fail(`offline engine verdict: ${offlineVerdict}`);

const timing = await page.locator('.verdict').nth(1).innerText();
console.log(`\n  desktop timing (not a phone): ${timing}`);

// --- 8. Deep link offline (navigateFallback) ------------------------------
const deep = await page.goto(`${url}some/deep/route`, { waitUntil: 'domcontentloaded' });
deep && deep.status() < 400 && (await page.title()) === 'Poker Equity Trainer'
  ? pass('deep link falls back to the app shell offline')
  : fail('deep link failed offline');

if (errors.length > 0) fail(`page errors: ${errors.join(' | ')}`);
else pass('no page errors');

await browser.close();
server.close();
console.log(process.exitCode ? '\nPWA VERIFICATION FAILED\n' : '\nPWA verification passed\n');
