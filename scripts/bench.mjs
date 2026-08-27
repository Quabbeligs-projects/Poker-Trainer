/**
 * Performance benchmarks.
 *
 * Deliberately NOT part of `npm test`. A wall-clock assertion in a correctness
 * suite fails at random under CI load, and a deploy must never be blocked by a
 * busy runner. CI runs this and prints the numbers so a real regression is
 * visible in the log, but nothing here gates the build.
 *
 * The correctness suite keeps only generous ceilings (5s) that catch an actual
 * algorithmic regression rather than a slow machine.
 *
 *   npm run bench
 */
import { createRng, shuffledDeckCodes, codesFromStrings } from '../src/engine/deck.ts';
import { evaluator } from '../src/engine/evaluator.ts';
import { computeEquity, DEFAULT_ITERATIONS } from '../src/engine/equity.ts';
import { countOuts } from '../src/engine/outs.ts';
import { Range, RangeCharts } from '../src/engine/ranges.ts';
import rangesJson from '../src/data/ranges.json' with { type: 'json' };
import { OutsHand } from '../src/game/session.ts';
import { DEFAULT_SETTINGS } from '../src/game/types.ts';

const charts = new RangeCharts(rangesJson);
const C = (t) => codesFromStrings(t.split(/\s+/));
const line = (n = 74) => '─'.repeat(n);
const row = (label, value, note = '') =>
  console.log(`  ${label.padEnd(42)} ${String(value).padStart(10)}  ${note}`);

console.log(`\n${line()}\nPERFORMANCE (informational — nothing here gates the build)\n${line()}`);

/* --- evaluator ----------------------------------------------------------- */
{
  const rng = createRng('bench-eval');
  const hands = [];
  for (let i = 0; i < 200_000; i++) hands.push(shuffledDeckCodes(rng).slice(0, 7));
  const started = Date.now();
  let acc = 0;
  for (const h of hands) acc += evaluator.strengthOf7(h[0], h[1], h[2], h[3], h[4], h[5], h[6]);
  const ms = Date.now() - started;
  row('evaluator, 7-card', `${Math.round(200_000 / ms * 1000).toLocaleString()}/s`,
    `${ms}ms for 200k (acc ${acc > 0 ? 'ok' : 'bad'})`);
}

/* --- Monte Carlo --------------------------------------------------------- */
const equityCase = (label, opts, note = '') => {
  const started = Date.now();
  computeEquity({ rng: createRng(`bench:${label}`), iterations: DEFAULT_ITERATIONS, ...opts });
  row(label, `${Date.now() - started}ms`, note);
};
equityCase('equity 100k, heads-up flop',
  { hole: C('Ah Qh'), board: C('Kd 8h 3h'), opponents: [Range.parse(['22+', 'A2s+', 'KTs+'])] },
  'includes the as-is/improved breakdown');
equityCase('equity 100k, preflop',
  { hole: C('Ah Qh'), opponents: [Range.parse(['22+', 'A2s+', 'AJo+'])] },
  'five board cards to deal');
for (const count of [2, 3, 5, 8]) {
  equityCase(`equity 100k, ${count} opponents`, {
    hole: C('Ah Qh'), board: C('Kd 8h 3h'),
    opponents: Array.from({ length: count }, () => Range.parse(['22+', 'A2s+', 'KTs+'])),
  });
}

/* --- outs ---------------------------------------------------------------- */
{
  const started = Date.now();
  for (let i = 0; i < 50; i++) countOuts(C('Ah Qh'), C('Kd 8h 3h'));
  row('countOuts (blank-benchmark)', `${((Date.now() - started) / 50).toFixed(1)}ms`, 'per call');
}

/* --- a whole hand -------------------------------------------------------- */
{
  const started = Date.now();
  const hand = new OutsHand('bench-hand', { ...DEFAULT_SETTINGS, playerCount: 6 }, charts);
  const ms = Date.now() - started;
  row('build one Outs hand', `${ms}ms`,
    `spot + narrowing + 2 x ${DEFAULT_ITERATIONS.toLocaleString()} iterations`);
  if (hand.current.truth === null) throw new Error('hand failed to build');
}

console.log(`${line()}\n`);
