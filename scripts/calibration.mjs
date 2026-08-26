/**
 * Calibration: engine equity vs the rule of 4 and 2.
 *
 * Generates representative Outs-mode spots — hero facing a bet on the flop, and
 * again on the turn — and compares engine truth against what a player computes
 * at the table by counting outs. Reports the signed gap, its spread, and the
 * worst cases broken down by hand type.
 *
 * The question this answers: if the player counts outs perfectly and applies
 * the rule of 4 and 2 correctly, how often would they still fail the +/-5pp
 * grading tolerance, and in which direction?
 *
 *   npm run calibrate
 */
import rangesJson from '../src/data/ranges.json' with { type: 'json' };
import { RangeCharts } from '../src/engine/ranges.ts';
import { codesFromStrings, createRng, shuffledDeckCodes, codeToString } from '../src/engine/deck.ts';
import { computeEquity } from '../src/engine/equity.ts';
import { countOuts, ruleOfFourAndTwo, adjustedRuleOfThumb, exactHitProbability } from '../src/engine/outs.ts';
import { narrowRange, classifyCombo } from '../src/engine/rangeNarrowing.ts';

const charts = new RangeCharts(rangesJson);
const SPOTS = Number(process.env.CALIBRATION_SPOTS ?? 300);
const ITERATIONS = 100_000;
const TOLERANCE = 5;

/** Villain profiles hero might face a bet from, matching Outs-mode construction. */
const VILLAINS = [
  { chart: 'UTG', betFraction: 0.66 },
  { chart: 'MP', betFraction: 0.66 },
  { chart: 'CO', betFraction: 0.5 },
  { chart: 'CO', betFraction: 1.0 },
  { chart: 'BTN', betFraction: 0.33 },
  { chart: 'BTN', betFraction: 0.66 },
  { chart: 'SB', betFraction: 0.75 },
];

const rows = [];
const rng = createRng('calibration-v1');

for (let i = 0; i < SPOTS; i++) {
  const deck = shuffledDeckCodes(rng);
  const hole = deck.slice(0, 2);
  const flop = deck.slice(2, 5);
  const turnCard = deck[5];
  const villain = VILLAINS[rng.nextInt(VILLAINS.length)];

  for (const street of ['flop', 'turn']) {
    const board = street === 'flop' ? flop : [...flop, turnCard];
    const cardsToCome = street === 'flop' ? 2 : 1;

    // Villain's range: their opening range, narrowed by a bet on each street so
    // far, at the sizing they used.
    const actions = street === 'flop'
      ? [{ action: 'bet', board: flop, betFraction: villain.betFraction }]
      : [
          { action: 'bet', board: flop, betFraction: villain.betFraction },
          { action: 'bet', board, betFraction: villain.betFraction },
        ];
    const range = narrowRange(charts.rfi(villain.chart).removeCards(hole), actions).range;
    if (range.isEmpty) continue;

    const result = computeEquity({
      hole, board, opponents: [range],
      rng: createRng(`calib:${i}:${street}`), iterations: ITERATIONS,
    });

    const outs = countOuts(hole, board);
    // The estimator players actually use: x4 minus the excess over 8 outs on
    // the flop. `plain` is kept so the report can separate how much of the gap
    // is the shortcut's arithmetic from how much is range-blindness.
    const naive = adjustedRuleOfThumb(outs.total, cardsToCome);
    const plain = ruleOfFourAndTwo(outs.total, cardsToCome);
    const exactHit = exactHitProbability(outs.total, cardsToCome, outs.unseen);
    const handClass = classifyCombo(hole[0], hole[1], board).madeClass;

    rows.push({
      street,
      handClass,
      hole: hole.map(codeToString).join(''),
      board: board.map(codeToString).join(' '),
      villain: `${villain.chart} bets ${Math.round(villain.betFraction * 100)}%`,
      outs: outs.total,
      naive,
      plain,
      exactHit,
      engine: result.equity,
      gap: result.equity - naive,
      asIs: result.breakdown.asIs,
      improved: result.breakdown.improved,
    });
  }
  if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${SPOTS} spots\n`);
}

/* -------------------------------------------------------------------------- */
const stats = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: values.length, mean, sd, p05: at(0.05), p25: at(0.25),
    median: at(0.5), p75: at(0.75), p95: at(0.95), min: sorted[0],
    max: sorted[sorted.length - 1] };
};
const f = (v, w = 6) => (v >= 0 ? '+' : '') + v.toFixed(1).padStart(w);
const line = (n = 92) => '─'.repeat(n);

console.log(`\n${line()}`);
console.log(`CALIBRATION: engine equity vs rule of 4 and 2   (${rows.length} spots, `
  + `${ITERATIONS.toLocaleString()} iterations each)`);
console.log(line());

for (const street of ['flop', 'turn']) {
  const subset = rows.filter((r) => r.street === street);
  const s = stats(subset.map((r) => r.gap));
  const outside = subset.filter((r) => Math.abs(r.gap) > TOLERANCE).length;
  console.log(`\n${street.toUpperCase()}  (rule of ${street === 'flop' ? 4 : 2})`);
  console.log(`  mean signed gap  ${f(s.mean)}pp     sd ${s.sd.toFixed(1)}pp`);
  console.log(`  spread           p05 ${f(s.p05)}  p25 ${f(s.p25)}  med ${f(s.median)}`
    + `  p75 ${f(s.p75)}  p95 ${f(s.p95)}`);
  console.log(`  range            ${f(s.min)}pp to ${f(s.max)}pp`);
  console.log(`  outside +/-${TOLERANCE}pp    ${outside}/${subset.length} `
    + `(${((outside / subset.length) * 100).toFixed(0)}%) — a player counting outs `
    + `perfectly would still be graded wrong this often`);
}

console.log(`\n${line()}`);
console.log('BY HAND TYPE (flop and turn combined)');
console.log(line());
console.log('  hand type      n    mean gap   sd     outs   naive   engine   as-is  improved');
const classes = [...new Set(rows.map((r) => r.handClass))];
const ordered = classes.sort((a, b) => {
  const mean = (c) => stats(rows.filter((r) => r.handClass === c).map((r) => r.gap)).mean;
  return mean(b) - mean(a);
});
for (const handClass of ordered) {
  const subset = rows.filter((r) => r.handClass === handClass);
  const s = stats(subset.map((r) => r.gap));
  const avg = (key) => subset.reduce((t, r) => t + r[key], 0) / subset.length;
  console.log(`  ${handClass.padEnd(12)} ${String(s.n).padStart(4)}   `
    + `${f(s.mean)}pp  ${s.sd.toFixed(1).padStart(4)}   `
    + `${avg('outs').toFixed(1).padStart(4)}   ${avg('naive').toFixed(1).padStart(5)}   `
    + `${avg('engine').toFixed(1).padStart(5)}   ${avg('asIs').toFixed(1).padStart(5)}  `
    + `${avg('improved').toFixed(1).padStart(6)}`);
}

console.log(`\n${line()}`);
console.log('WORST OVERSHOOTS — engine far above the outs estimate');
console.log(line());
for (const r of [...rows].sort((a, b) => b.gap - a.gap).slice(0, 6)) {
  console.log(`  ${r.hole}  on ${r.board.padEnd(14)} ${r.street.padEnd(4)} `
    + `${r.handClass.padEnd(11)} vs ${r.villain.padEnd(14)}`);
  console.log(`      ${r.outs} outs -> naive ${r.naive.toFixed(0)}%   engine `
    + `${r.engine.toFixed(1)}%   gap ${f(r.gap)}pp   `
    + `(as-is ${r.asIs.toFixed(1)}% + improved ${r.improved.toFixed(1)}%)`);
}
console.log(`\n${line()}`);
console.log('WORST UNDERSHOOTS — engine far below the outs estimate');
console.log(line());
for (const r of [...rows].sort((a, b) => a.gap - b.gap).slice(0, 6)) {
  console.log(`  ${r.hole}  on ${r.board.padEnd(14)} ${r.street.padEnd(4)} `
    + `${r.handClass.padEnd(11)} vs ${r.villain.padEnd(14)}`);
  console.log(`      ${r.outs} outs -> naive ${r.naive.toFixed(0)}%   engine `
    + `${r.engine.toFixed(1)}%   gap ${f(r.gap)}pp   `
    + `(as-is ${r.asIs.toFixed(1)}% + improved ${r.improved.toFixed(1)}%)`);
}

/* --- Would restricting spot selection fix it? ---------------------------- */
// Outs mode is meant to construct spots where hero faces a real decision with a
// draw. A uniform random deal is not that: it produces sets and air, where
// "count your outs" is not even the right question. Measure the gap over
// genuine drawing spots only.
const drawing = rows.filter((r) =>
  (r.handClass === 'strongDraw' || r.handClass === 'weakDraw'
   || (r.handClass === 'weakPair' && r.outs >= 8))
  && r.asIs < 15);

console.log(`\n${line()}`);
console.log('IF OUTS MODE ONLY BUILT GENUINE DRAWING SPOTS');
console.log(line());
{
  const s = stats(drawing.map((r) => r.gap));
  const outside = drawing.filter((r) => Math.abs(r.gap) > TOLERANCE).length;
  console.log(`  ${drawing.length} of ${rows.length} spots qualify`);
  console.log(`  mean signed gap  ${f(s.mean)}pp     sd ${s.sd.toFixed(1)}pp`);
  console.log(`  spread           p05 ${f(s.p05)}  med ${f(s.median)}  p95 ${f(s.p95)}`);
  console.log(`  outside +/-${TOLERANCE}pp    ${outside}/${drawing.length} `
    + `(${((outside / drawing.length) * 100).toFixed(0)}%)`);
  const avgAsIs = drawing.reduce((t, r) => t + r.asIs, 0) / drawing.length;
  console.log(`  mean as-is equity ${avgAsIs.toFixed(1)}% — the part outs counting cannot see`);
}

/* --- What would widening the tolerance actually cost? -------------------- */
console.log(`\n${line()}`);
console.log('COST OF SIMPLY WIDENING THE TOLERANCE (the option to avoid)');
console.log(line());
for (const [label, subset] of [['all spots', rows], ['drawing spots only', drawing]]) {
  const abs = subset.map((r) => Math.abs(r.gap)).sort((a, b) => a - b);
  const need = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  console.log(`  ${label.padEnd(20)} to pass 80% needs +/-${need(0.8).toFixed(0)}pp, `
    + `90% needs +/-${need(0.9).toFixed(0)}pp, 95% needs +/-${need(0.95).toFixed(0)}pp`);
}

// How much of the gap is arithmetic (rule of 4 vs exact hit probability) versus
// modelling (ignoring the opponent's range entirely)?
const adjustedArithmetic = stats(rows.map((r) => r.exactHit - r.naive));
const plainArithmetic = stats(rows.map((r) => r.exactHit - r.plain));
const modelling = stats(rows.map((r) => r.engine - r.exactHit));
console.log(`\n${line()}`);
console.log('WHERE THE GAP COMES FROM');
console.log(line());
console.log(`  plain x4/x2 arithmetic error     mean ${f(plainArithmetic.mean)}pp  sd ${plainArithmetic.sd.toFixed(1)}`);
console.log(`  ADJUSTED shortcut error          mean ${f(adjustedArithmetic.mean)}pp  sd ${adjustedArithmetic.sd.toFixed(1)}`);
console.log(`  ignoring the opponent's range    mean ${f(modelling.mean)}pp  sd ${modelling.sd.toFixed(1)}`);
console.log('');
console.log('  The range-blindness figure is measured against EXACT enumeration,');
console.log('  not against any shortcut, so changing the estimator cannot move it.');
console.log('  It is reported here to confirm that invariance holds numerically.');
console.log('');
