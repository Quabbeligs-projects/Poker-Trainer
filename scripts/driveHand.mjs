/**
 * Plays one Outs hand in a real browser with the CORRECT answers, at iPhone
 * viewport size, and checks the hand advances from flop to turn.
 *
 * Worth keeping as a smoke test: it caught a bug where the feedback screen
 * rendered the NEXT street's truth. `hand.submit()` returns the ADVANCED state,
 * so on a correct flop the board, outs, equity split, fired rules and range
 * grid all described a street hero had not seen yet, beside answers from the
 * one they just played. Unit tests passed throughout — only playing the happy
 * path end to end exposed it.
 *
 *   npm run smoke
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import rangesJson from '../src/data/ranges.json' with { type: 'json' };
import { RangeCharts } from '../src/engine/ranges.ts';
import { OutsHand } from '../src/game/session.ts';
import { DEFAULT_SETTINGS, EQUITY_BANDS, bandOf } from '../src/game/types.ts';

const SEED = process.env.SEED ?? 'DRIVE-TURN-1';
const charts = new RangeCharts(rangesJson);
const settings = { ...DEFAULT_SETTINGS, playerCount: 6 };

// Compute the same hand in Node so we know the right answers to type.
const ref = new OutsHand(SEED, settings, charts);
const t = ref.current.truth;
const expect = {
  outs: String(t.hitProbability.outs),
  hit: String(Math.round(t.hitProbability.exact)),
  equity: String(Math.round(t.equity.percent)),
  potOdds: String(Math.round(t.potOdds.percent)),
  action: t.action.best,
  band: EQUITY_BANDS.find((b) => b.id === bandOf(t.equity.percent)).label,
};
console.log(`seed ${SEED}: outs ${expect.outs}, hit ${expect.hit}%, ${expect.band} (${expect.equity}%), potOdds ${expect.potOdds}%, best ${expect.action}`);

const BASE = process.env.VITE_BASE ?? '/Poker-Trainer/';
const TYPES={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{let p=decodeURIComponent((req.url??'/').split('?')[0]);if(!p.startsWith(BASE)){res.writeHead(404).end();return;}p=p.slice(BASE.length)||'index.html';const f=join('dist',normalize(p).replace(/^(\.\.[/\\])+/,''));try{const b=await readFile(f);res.writeHead(200,{'Content-Type':TYPES[extname(f)]??'application/octet-stream'}).end(b);}catch{res.writeHead(404).end();}});
// Port 0 asks the OS for a free port, so two runs — or two jobs on one shared
// runner — cannot collide.
await new Promise(r=>server.listen(0,r));
const PORT = server.address().port;
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
const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
const page=await ctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
await page.goto(`http://localhost:${PORT}${BASE}?seed=${SEED}`,{waitUntil:'networkidle'});
await page.waitForSelector('.ask h2',{timeout:30000});

const answerStreet = async (exp) => {
  for (const v of [exp.outs, exp.hit]) {
    await page.waitForSelector('.number-field input',{timeout:15000});
    await page.locator('.number-field input').fill(v);
    await page.locator('button.primary').click();
    await page.waitForTimeout(100);
  }
  // Equity is a band, not a number.
  await page.waitForSelector('.band-button',{timeout:15000});
  await page.locator('.band-button').filter({hasText:new RegExp(`^${exp.band}`,'i')}).first().click();
  await page.waitForTimeout(100);
  await page.waitForSelector('.number-field input',{timeout:15000});
  await page.locator('.number-field input').fill(exp.potOdds);
  await page.locator('button.primary').click();
  await page.waitForTimeout(100);
  await page.waitForSelector('.action-button',{timeout:15000});
  await page.locator('.action-button').filter({hasText:new RegExp(`^${exp.action}$`,'i')}).first().click();
  await page.waitForSelector('.verdict',{timeout:25000});
};

await answerStreet(expect);
console.log('FLOP verdict:', (await page.locator('.verdict-text').innerText()).split('\n')[0]);
console.log('  next button:', await page.locator('button.primary').innerText());
if (process.env.SHOT_DIR) {
  await page.screenshot({path:`${process.env.SHOT_DIR}/04-flop-correct.png`, fullPage:true});
}
// The feedback must describe the street just ANSWERED, not the next one.
const verdictStreet = (await page.locator('.verdict-text small').innerText()).toLowerCase();
if (!verdictStreet.includes('flop')) {
  console.error(`  FAIL feedback shows "${verdictStreet}" after the flop`);
  process.exitCode = 1;
}
const feedbackBoard = await page.locator('.hand-strip .card-row').nth(1).locator('.card').count();
if (feedbackBoard !== 3) {
  console.error(`  FAIL feedback board has ${feedbackBoard} cards after the flop, expected 3`);
  process.exitCode = 1;
}
console.log('  feedback describes the answered street: ok');

// Advance to the turn.
await page.locator('button.primary').click();
await page.waitForSelector('.ask h2',{timeout:25000});
const street = await page.locator('.street').innerText();
const boardCards = await page.locator('.card-row').first().locator('.card').count();
console.log(`TURN reached: street="${street}", board cards=${boardCards}`);
const q = await page.locator('.ask h2').innerText();
console.log('  first question:', q);
if (process.env.SHOT_DIR) {
  await page.screenshot({path:`${process.env.SHOT_DIR}/05-turn.png`, fullPage:true});
}
if (boardCards !== 4) { console.error('  FAIL turn board is not 4 cards'); process.exitCode = 1; }
console.log('  page errors:', errors.length ? errors.join(' | ') : 'none');
if (errors.length > 0) process.exitCode = 1;
await browser.close(); server.close();
console.log(process.exitCode ? '\nSMOKE TEST FAILED\n' : '\nSmoke test passed\n');
