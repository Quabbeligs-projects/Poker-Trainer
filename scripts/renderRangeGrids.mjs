/**
 * Renders every chart in ranges.json as a 13x13 grid in a single self-contained
 * HTML page, for eyeballing the charts before trusting them as training truth.
 *
 *   npm run grids   ->   range-grids.html
 *
 * Fractional weights (produced by table-size trimming) render as partial
 * vertical fills, so a hand kept at 40% weight is visibly different from one
 * kept whole.
 */
import { writeFileSync } from 'node:fs';
import rangesJson from '../src/data/ranges.json' with { type: 'json' };
import {
  HAND_GRID, RangeCharts, combosOfHandKey, CHART_POSITIONS,
} from '../src/engine/ranges.ts';
import {
  tableSeats, tableAdjustedRfi, tableAdjustedResponse,
  WIDTH_FACTOR_PER_EXTRA_PLAYER,
} from '../src/engine/tableScaling.ts';

const charts = new RangeCharts(rangesJson);

/** Per-hand-key fill fraction: share of that hand's combos present, by weight. */
function gridCells(range) {
  return HAND_GRID.map((row) => row.map((key) => {
    const combos = combosOfHandKey(key);
    let weight = 0;
    for (const combo of combos) weight += range.weightOf(combo);
    return { key, fill: weight / combos.length };
  }));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function renderGrid(range, { title, subtitle, tone = 'call' }) {
  if (range.isEmpty) return '';
  const cells = gridCells(range);
  const body = cells.map((row) => row.map(({ key, fill }) => {
    const pct = Math.round(fill * 100);
    const kind = key.length === 2 ? 'pair' : key.endsWith('s') ? 'suited' : 'offsuit';
    const state = fill <= 0 ? 'off' : fill >= 0.999 ? 'full' : 'partial';
    // The label sits over the filled portion only when the fill covers most of
    // the cell; otherwise it sits on the empty ground and must use ink.
    const label = fill >= 0.6 ? ' on-fill' : '';
    return `<div class="cell ${kind} ${state}${label}" style="--fill:${(fill * 100).toFixed(2)}%"`
      + ` title="${esc(key)} — ${pct}%"><span>${esc(key)}</span></div>`;
  }).join('')).join('');

  return `<figure class="chart tone-${tone}">
  <figcaption>
    <h3>${esc(title)}</h3>
    <p class="stat"><b>${range.percentOfHands.toFixed(1)}%</b><span>of hands</span>
      <b>${range.comboCount}</b><span>combos</span></p>
    ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
  </figcaption>
  <div class="grid">${body}</div>
</figure>`;
}

const sections = [];

/* ---- 1. Opening ranges, 6-max ------------------------------------------- */
sections.push({
  id: 'rfi',
  title: 'Opening ranges',
  kicker: '6-max charts, used verbatim',
  note: 'These are the authored charts in ranges.json. Everything else in the engine derives from them, '
    + 'including the trimming order used when scaling for table size.',
  html: CHART_POSITIONS
    .filter((p) => !charts.rfi(p).isEmpty)
    .map((p) => renderGrid(charts.rfi(p), {
      title: `${p} open`,
      subtitle: 'raise first in',
      tone: 'open',
    })).join(''),
});

/* ---- 2. Table-size scaling ----------------------------------------------- */
const nineHanded = tableSeats(9)
  .filter((s) => !tableAdjustedRfi(charts, 9, s.seatIndex).isEmpty && s.chart !== 'SB')
  .map((s) => renderGrid(tableAdjustedRfi(charts, 9, s.seatIndex), {
    title: `${s.display} open`,
    subtitle: `${s.playersBehind} behind · ${s.chart} chart × ${s.widthFactor.toFixed(3)}`,
    tone: 'open',
  })).join('');

const widthRows = [];
for (let n = 2; n <= 10; n++) {
  const cells = tableSeats(n).map((s) => {
    const w = tableAdjustedRfi(charts, n, s.seatIndex).percentOfHands;
    return w > 0 ? `<td><b>${s.display}</b><i>${w.toFixed(1)}%</i></td>` : '';
  }).join('');
  widthRows.push(`<tr><th>${n}-handed</th>${cells}</tr>`);
}

sections.push({
  id: 'scaling',
  title: 'Table-size scaling',
  kicker: '9-handed, tightened from the 6-max charts',
  note: `Width is a function of players left to act behind hero, not table size: a cutoff has three players `
    + `behind at any table, which is why 6-max and full-ring cutoff ranges match. Beyond five behind there is `
    + `no 6-max chart to map onto, so the UTG chart is tightened by ${WIDTH_FACTOR_PER_EXTRA_PLAYER} per extra `
    + `player. Weakest hands go first, ordered by chart tier then by equity against a random hand. The boundary `
    + `hand is trimmed fractionally — those are the part-filled cells.`,
  html: nineHanded,
  extra: `<div class="scroller"><table class="widths"><tbody>${widthRows.join('')}</tbody></table></div>`,
});

/* ---- 3. Heads-up --------------------------------------------------------- */
const huDefence = charts.headsUpVsOpen();
sections.push({
  id: 'headsup',
  title: 'Heads-up',
  kicker: 'authored separately, never scaled',
  note: 'No width rule applied to a 41.8% button chart produces a correct ~85% heads-up button range. '
    + 'The button posts the small blind, is in position postflop, and plays every hand against one opponent, '
    + 'so heads-up gets its own charts.',
  html: renderGrid(charts.headsUpRfi(), { title: 'BTN open', subtitle: 'heads-up', tone: 'open' })
    + renderGrid(huDefence.call, { title: 'BB call', subtitle: 'vs BTN open', tone: 'call' })
    + renderGrid(huDefence.threeBet, { title: 'BB 3-bet', subtitle: 'vs BTN open', tone: 'raise' }),
});

/* ---- 4. Defending vs an open --------------------------------------------- */
const BUCKET_LABEL = { early: 'vs UTG/MP open', middle: 'vs CO open', late: 'vs BTN open', sb: 'vs SB open' };
let defenceHtml = '';
for (const position of CHART_POSITIONS) {
  for (const bucket of ['early', 'middle', 'late', 'sb']) {
    const response = charts.vsOpen(position, bucket);
    if (response.call.isEmpty && response.threeBet.isEmpty) continue;
    defenceHtml += renderGrid(response.call, {
      title: `${position} call`, subtitle: BUCKET_LABEL[bucket], tone: 'call',
    });
    defenceHtml += renderGrid(response.threeBet, {
      title: `${position} 3-bet`, subtitle: BUCKET_LABEL[bucket], tone: 'raise',
    });
  }
}
sections.push({
  id: 'defence',
  title: 'Defending an open',
  kicker: 'call and 3-bet, by hero position and opener',
  note: 'Openers are bucketed: early is UTG or MP, middle is CO, late is BTN, plus the small blind. '
    + 'The UTG row only occurs at 7+ handed tables, where a seat on the UTG chart can still face an earlier open.',
  html: defenceHtml,
});

/* ---- 5. Multiway and vs 3-bet -------------------------------------------- */
let multiwayHtml = '';
for (const position of CHART_POSITIONS) {
  const r = charts.vsOpenWithCallers(position);
  if (r.call.isEmpty && r.squeeze.isEmpty) continue;
  multiwayHtml += renderGrid(r.call, { title: `${position} overcall`, subtitle: 'open + caller(s)', tone: 'call' });
  multiwayHtml += renderGrid(r.squeeze, { title: `${position} squeeze`, subtitle: 'open + caller(s)', tone: 'raise' });
}
for (const position of CHART_POSITIONS) {
  const r = charts.vsThreeBet(position);
  if (r.call.isEmpty && r.fourBet.isEmpty) continue;
  multiwayHtml += renderGrid(r.call, { title: `${position} call`, subtitle: 'hero opened, faces a 3-bet', tone: 'call' });
  multiwayHtml += renderGrid(r.fourBet, { title: `${position} 4-bet`, subtitle: 'hero opened, faces a 3-bet', tone: 'raise' });
}
sections.push({
  id: 'multiway',
  title: 'Multiway and 4-bet pots',
  kicker: 'overcall, squeeze, and hero facing a 3-bet',
  note: 'Vs-3-bet charts fall back to the default entry for any position without its own.',
  html: multiwayHtml,
});

/* ---- Page ----------------------------------------------------------------- */
const nav = sections.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join('');
const body = sections.map((s) => `<section id="${s.id}">
  <header class="sec-head">
    <p class="eyebrow">${esc(s.kicker)}</p>
    <h2>${esc(s.title)}</h2>
    <p class="note">${s.note}</p>
  </header>
  ${s.extra ?? ''}
  <div class="charts">${s.html}</div>
</section>`).join('');

const html = `<title>Range Proof Sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root {
  --ground: #F6F3EC;
  --surface: #FFFFFF;
  --surface-2: #EFEBE1;
  --line: #DCD6C8;
  --line-soft: #E7E2D6;
  --ink: #1B2422;
  --ink-2: #4A554F;
  --ink-3: #7A857E;
  --open: #C08A2E;
  --call: #3E7A6B;
  --raise: #B4553F;
  --cell-off: #E9E5DA;
  --shadow: 0 1px 2px rgba(27,36,34,.06), 0 8px 24px rgba(27,36,34,.05);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0F1A18;
    --surface: #16211F;
    --surface-2: #1B2726;
    --line: #2A3735;
    --line-soft: #223230;
    --ink: #ECE7DA;
    --ink-2: #A8B3AD;
    --ink-3: #78847E;
    --open: #D9A441;
    --call: #5FAE98;
    --raise: #D2705A;
    --cell-off: #1E2B29;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.28);
  }
}
:root[data-theme="dark"] {
  --ground: #0F1A18;
  --surface: #16211F;
  --surface-2: #1B2726;
  --line: #2A3735;
  --line-soft: #223230;
  --ink: #ECE7DA;
  --ink-2: #A8B3AD;
  --ink-3: #78847E;
  --open: #D9A441;
  --call: #5FAE98;
  --raise: #D2705A;
  --cell-off: #1E2B29;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.28);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px 96px; }
header.top { padding: 56px 0 28px; border-bottom: 1px solid var(--line); }
h1 {
  font-family: Archivo, ui-sans-serif, sans-serif;
  font-weight: 700; font-size: clamp(30px, 5vw, 46px);
  letter-spacing: -.02em; line-height: 1.05; margin: 0 0 12px;
  text-wrap: balance;
}
.lede { color: var(--ink-2); max-width: 62ch; margin: 0 0 20px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--ink-3);
  font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12.5px; }
nav { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--ground) 92%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
  margin-bottom: 40px; }
nav .scroll { max-width: 1180px; margin: 0 auto; padding: 10px 20px;
  display: flex; gap: 6px; overflow-x: auto; }
nav a { flex: none; text-decoration: none; color: var(--ink-2);
  font-size: 13px; font-weight: 500; padding: 6px 12px; border-radius: 999px;
  border: 1px solid transparent; white-space: nowrap; }
nav a:hover, nav a:focus-visible { color: var(--ink); border-color: var(--line); background: var(--surface); }
section { margin: 0 0 64px; scroll-margin-top: 64px; }
.sec-head { margin-bottom: 24px; }
.eyebrow { font-family: "IBM Plex Mono", monospace; font-size: 11.5px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 6px; }
h2 { font-family: Archivo, sans-serif; font-weight: 600; font-size: 24px;
  letter-spacing: -.01em; margin: 0 0 10px; text-wrap: balance; }
.note { color: var(--ink-2); max-width: 74ch; margin: 0; font-size: 14px; }
.charts { display: grid; gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.chart { margin: 0; background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; padding: 14px; box-shadow: var(--shadow); }
figcaption { margin-bottom: 10px; }
.chart h3 { font-family: Archivo, sans-serif; font-size: 15px; font-weight: 600;
  margin: 0 0 4px; letter-spacing: -.005em; }
.stat { margin: 0; font-family: "IBM Plex Mono", monospace; font-size: 12px;
  color: var(--ink-3); font-variant-numeric: tabular-nums; display: flex; gap: 5px; align-items: baseline; }
.stat b { color: var(--ink); font-weight: 500; }
.stat span { margin-right: 6px; }
.sub { margin: 3px 0 0; font-size: 12px; color: var(--ink-3); }
.grid { display: grid; grid-template-columns: repeat(13, 1fr); gap: 1px;
  background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 4px; overflow: hidden; }
.cell { position: relative; aspect-ratio: 1; background: var(--cell-off);
  display: flex; align-items: center; justify-content: center; }
.cell::before { content: ""; position: absolute; inset: 0;
  background: var(--tone); height: var(--fill); top: auto; bottom: 0; }
.cell.off::before { display: none; }
.cell span { position: relative; font-family: "IBM Plex Mono", monospace;
  font-size: clamp(5px, 1.5vw, 8px); font-weight: 500; color: var(--ink-3);
  letter-spacing: -.03em; }
.cell.on-fill span { color: #10201C; }
.tone-open { --tone: var(--open); }
.tone-call { --tone: var(--call); }
.tone-raise { --tone: var(--raise); }
.cell.pair { outline: 1px solid color-mix(in srgb, var(--ink) 22%, transparent); outline-offset: -1px; }
.scroller { overflow-x: auto; margin-bottom: 24px; }
table.widths { border-collapse: collapse; font-size: 12.5px; width: 100%;
  font-variant-numeric: tabular-nums; }
table.widths th { text-align: left; font-family: "IBM Plex Mono", monospace;
  font-weight: 500; color: var(--ink-3); padding: 7px 14px 7px 0; white-space: nowrap;
  border-bottom: 1px solid var(--line-soft); }
table.widths td { padding: 7px 14px 7px 0; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
table.widths td b { font-weight: 600; font-size: 11px; color: var(--ink-3);
  display: block; text-transform: uppercase; letter-spacing: .04em; }
table.widths td i { font-style: normal; font-family: "IBM Plex Mono", monospace; color: var(--ink); }
.legend { display: flex; flex-wrap: wrap; gap: 18px; align-items: center;
  padding: 14px 0 0; font-size: 12.5px; color: var(--ink-2); }
.legend .swatch { display: inline-flex; align-items: center; gap: 7px; }
.legend i { width: 15px; height: 15px; border-radius: 3px; display: inline-block; font-style: normal; }
@media (max-width: 560px) {
  .charts { grid-template-columns: 1fr; }
  .cell span { font-size: 9px; }
  header.top { padding: 32px 0 20px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
<nav><div class="scroll">${nav}</div></nav>
<div class="wrap">
<header class="top">
  <h1>Range Proof Sheet</h1>
  <p class="lede">Every preflop chart the trainer grades against, rendered as 13&times;13 grids.
  These charts are the one part of the engine no test can prove correct, only self-consistent &mdash;
  so they need an eyeball before anything is built on them.</p>
  <p class="meta"><span>src/data/ranges.json</span><span>generated by scripts/renderRangeGrids.mjs</span></p>
  <div class="legend">
    <span class="swatch"><i style="background:var(--open)"></i> opening</span>
    <span class="swatch"><i style="background:var(--call)"></i> calling</span>
    <span class="swatch"><i style="background:var(--raise)"></i> raising / 3-bet</span>
    <span class="swatch"><i style="background:linear-gradient(to top,var(--call) 45%,var(--cell-off) 45%)"></i> partial weight</span>
    <span class="swatch"><i style="background:var(--cell-off);outline:1px solid color-mix(in srgb,var(--ink) 22%,transparent);outline-offset:-1px"></i> pairs (diagonal)</span>
  </div>
</header>
${body}
</div>`;

writeFileSync('range-grids.html', html);
console.log(`Wrote range-grids.html (${(html.length / 1024).toFixed(0)} KB, ${sections.length} sections)`);
