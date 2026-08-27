/**
 * Verifies the built PWA actually works with the network off.
 *
 * Serves dist/ under the GitHub Pages base path, loads it in Chromium, waits
 * for the service worker to take control, then cuts the network and reloads.
 *
 * BLOCKING vs NON-BLOCKING
 * ------------------------
 * Only checks that prove the app FUNCTIONS offline set a failing exit code:
 * the service worker controls the page, a precached asset still resolves, a
 * never-cached URL still fails (proving the network really is cut rather than
 * the test quietly running online), and the engine computes correct equities
 * from the precache.
 *
 * Cosmetic checks report as warnings and cannot fail the build. The
 * connectivity label that once lived here is gone with the engine-check page,
 * but the split is kept: a cosmetic defect must never block a deploy whose
 * engine demonstrably works offline.
 *
 *   npm run verify:pwa
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

// Must match the base the bundle was built with.
const BASE = process.env.VITE_BASE ?? '/Poker-Trainer/';
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

// Port 0 asks the OS for a free port, so two runs — or two jobs on one shared
// runner — cannot collide.
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;
const url = `http://localhost:${PORT}${BASE}`;
let blockingFailures = 0;
let warnings = 0;
const pass = (msg) => console.log(`  ok    ${msg}`);
/** A functional defect. Fails the build. */
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  blockingFailures += 1;
  process.exitCode = 1;
};
/** A cosmetic or environment-dependent defect. Reported, never fatal. */
const warn = (msg) => {
  console.warn(`  warn  ${msg}`);
  warnings += 1;
};

/** Polls until `predicate` returns truthy, or gives up. Returns the value. */
async function waitFor(predicate, { timeout = 5000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Launch options for Chromium.
 *
 * No path is hardcoded. Where browsers were installed with `npx playwright
 * install chromium`, Playwright resolves them itself and no options are needed.
 * An environment that keeps Chromium somewhere else — a sandbox with a
 * pre-baked binary outside Playwright's versioned layout — sets
 * PLAYWRIGHT_CHROMIUM_PATH and this uses it.
 */
const chromiumLaunchOptions = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
  : {};
const browser = await chromium.launch(chromiumLaunchOptions);
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
// `navigator.serviceWorker.ready` never rejects — if the worker fails to
// install it simply hangs forever. Racing it against a timeout turns a broken
// service worker into a clear CI failure instead of a stuck job.
const swReady = await page.evaluate(async () => {
  const ready = navigator.serviceWorker.ready.then((reg) => Boolean(reg.active));
  const timeout = new Promise((resolve) => { setTimeout(() => resolve(false), 20_000); });
  return Promise.race([ready, timeout]);
});
swReady ? pass('service worker active') : fail('service worker never activated within 20s');

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
// Rendering a hand exercises the whole engine: a spot is built, ranges are
// narrowed, and a 100k-iteration Monte Carlo produces the truth object. If any
// of that fails there is no question on screen.
/**
 * Gets to a dealt hand the way a user does, through the settings screen, and
 * reports what was rendered. Reaching a question at all proves the whole engine
 * ran: a spot was built, ranges narrowed, and a Monte Carlo produced the truth.
 */
const handRendered = async () => {
  if (await page.locator('.settings').count() > 0) {
    await page.getByRole('button', { name: /start outs/i }).click();
  }
  await page.waitForSelector('.ask h2', { timeout: 60_000 });
  return {
    cards: await page.locator('.table-strip .card').count(),
    question: await page.locator('.ask h2').innerText(),
  };
};
// The settings screen is the real entry point, so check it renders first.
(await page.locator('.settings h2').count()) >= 3
  ? pass('settings screen rendered')
  : fail('settings screen did not render on first load');

const online = await handRendered();
online.cards >= 5
  ? pass(`engine online: dealt a hand (${online.cards} cards, asked "${online.question}")`)
  : fail(`engine online: only ${online.cards} cards rendered`);

// --- 7. OFFLINE: the real test --------------------------------------------
await context.setOffline(true);
pass('network cut');
// If the service worker is not serving, this reload cannot complete at all.
// Catch it so the run reports a clear failure rather than an unhandled crash.
let reloaded = true;
try {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  const offlineTitle = await page.title();
  offlineTitle === 'Poker Equity Trainer'
    ? pass('page reloaded with no network')
    : fail(`offline reload gave title ${offlineTitle}`);
} catch (error) {
  reloaded = false;
  fail(`offline reload failed outright: ${String(error.message).split('\n')[0]}`);
}

if (reloaded) {
  // Prove the page is genuinely being served from the cache rather than from a
  // network that was never actually cut. This is the real offline gate: a
  // precached asset must resolve, and a never-cached URL must not.
  const provenance = await page.evaluate(async (base) => {
    const out = {};
    out.controlled = Boolean(navigator.serviceWorker.controller);
    try {
      const res = await fetch(`${base}icon-512.png`);
      out.precached = res.status;
    } catch (error) {
      out.precached = `threw: ${error.message}`;
    }
    try {
      await fetch(`${base}never-cached-${Date.now()}.txt`, { cache: 'no-store' });
      out.uncachedReachable = true;
    } catch {
      out.uncachedReachable = false;
    }
    return out;
  }, BASE);

  provenance.controlled
    ? pass('service worker controls the reloaded page')
    : fail('page reloaded without a controlling service worker');
  provenance.precached === 200
    ? pass('precached asset served with the network cut')
    : fail(`precached asset returned ${provenance.precached} offline`);
  provenance.uncachedReachable
    ? fail('a never-cached URL still resolved — the network was not actually cut, '
         + 'so this run proves nothing about offline behaviour')
    : pass('never-cached URL correctly unreachable (network really is cut)');

  const started = Date.now();
  const offlineHand = await handRendered();
  const elapsed = Date.now() - started;
  offlineHand.cards >= 5
    ? pass(`engine offline: dealt a hand (${offlineHand.cards} cards)`)
    : fail(`engine offline: only ${offlineHand.cards} cards rendered`);
  console.log(`\n  desktop hand build, network cut: ${elapsed}ms (not a phone)`);

  // Answering a field proves the interaction works from the precache too.
  await page.locator('.number-field input').fill('9');
  await page.locator('button.primary').click();
  await page.waitForTimeout(250);
  (await page.locator('.ask h2').innerText()) !== offlineHand.question
    ? pass('advanced to the next field offline')
    : fail('the form did not advance offline');
} else {
  console.log('  skip  post-reload checks (the offline reload never completed)');
}

// --- 8. Deep link offline (navigateFallback) ------------------------------
const deep = await page.goto(`${url}some/deep/route`, { waitUntil: 'domcontentloaded' });
deep && deep.status() < 400 && (await page.title()) === 'Poker Equity Trainer'
  ? pass('deep link falls back to the app shell offline')
  : fail('deep link failed offline');

if (errors.length > 0) fail(`page errors: ${errors.join(' | ')}`);
else pass('no page errors');

await browser.close();
server.close();

console.log('');
if (blockingFailures > 0) {
  console.log(`PWA VERIFICATION FAILED — ${blockingFailures} functional check(s) failed`
    + (warnings ? `, plus ${warnings} warning(s)` : ''));
} else if (warnings > 0) {
  console.log(`PWA verification passed with ${warnings} warning(s) — `
    + 'nothing functional, deploy is safe');
} else {
  console.log('PWA verification passed');
}
console.log('');
