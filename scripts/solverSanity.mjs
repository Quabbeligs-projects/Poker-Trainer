/**
 * Runs the action solver on spots where the correct answer is uncontroversial,
 * and prints the full verdict plus firedRules for each.
 *
 * This is a judgement harness, not a test: it exists so a human can read the
 * solver's reasoning and disagree with it. Anything that looks wrong here is a
 * modelling problem, not a test problem.
 *
 *   npm run sanity
 */
import rangesJson from '../src/data/ranges.json' with { type: 'json' };
import { RangeCharts } from '../src/engine/ranges.ts';
import { codesFromStrings, createRng, codeToString } from '../src/engine/deck.ts';
import { computeEquity } from '../src/engine/equity.ts';
import { narrowRange, splitByFoldDecision, classifyCombo } from '../src/engine/rangeNarrowing.ts';
import { solveAction, priceAction } from '../src/engine/actionSolver.ts';
import { potOdds } from '../src/engine/potOdds.ts';

const charts = new RangeCharts(rangesJson);
const C = (t) => codesFromStrings(t.split(/\s+/).filter(Boolean));

const SPOTS = [
  {
    name: 'Nut flush draw on the flop, facing a 1/4-pot bet heads-up',
    hero: 'Ah Qh',
    board: 'Kd 8h 3h',
    pot: 125, toCall: 25,           // 100 pot, villain bet 25
    opponents: [{ chart: 'CO', actions: ['bet'], betFractions: [0.25] }],
    expect: 'call or raise — never fold. 9 nut flush outs at a 17% price.',
  },
  {
    name: 'Complete air, facing a 3/4-pot bet, three-way',
    hero: '9s 2d',
    board: 'Kd 8h 3c',
    pot: 175, toCall: 75,           // 100 pot, villain bet 75
    opponents: [
      { chart: 'CO', actions: ['bet'], betFractions: [0.75] },
      { chart: 'BTN', actions: ['call'], betFractions: [0.75] },
    ],
    expect: 'fold. No pair, no draw, two opponents.',
  },
  {
    name: 'Top set on a dry rainbow board, checked to hero on the button',
    hero: 'Ks Kh',
    board: 'Kd 8h 3c',
    pot: 100, toCall: 0,
    opponents: [{ chart: 'BB', actions: ['check'] }],
    expect: 'bet. Top set with nothing to protect against but everything to gain.',
  },
  {
    name: 'Gutshot only, facing a pot-sized bet',
    hero: 'Js Th',
    board: 'Qd 8h 3c',
    pot: 200, toCall: 100,          // 100 pot, villain bet 100
    opponents: [{ chart: 'CO', actions: ['bet'], betFractions: [1.0] }],
    expect: 'fold. Four outs at a 50% price.',
  },
  {
    name: 'Top pair weak kicker, facing a big turn raise',
    hero: 'Kc 4c',
    board: 'Kd 8h 3c 5s',
    pot: 400, toCall: 150,
    opponents: [{ chart: 'BTN', actions: ['call', 'raise'], betFractions: [0.66, 1.0] }],
    expect: 'fold, or at the very most a reluctant call. Never a re-raise.',
  },
];

const ITERATIONS = 200_000;
const bar = (n) => '─'.repeat(n);

for (const spot of SPOTS) {
  const hero = C(spot.hero);
  const board = C(spot.board);

  // Build each opponent's narrowed range from their position and action line.
  const ranges = spot.opponents.map((opponent, i) => {
    const start = opponent.chart === 'BB'
      ? charts.vsOpen('BB', 'late').call
      : charts.rfi(opponent.chart);
    const streets = opponent.actions.map((action, step) => ({
      action,
      // Flop actions see the flop; a turn action sees the turn.
      board: board.slice(0, Math.min(board.length, 3 + step)),
      betFraction: opponent.betFractions?.[step] ?? 2 / 3,
    }));
    const { range, steps } = narrowRange(start.removeCards(hero), streets);
    return { label: `${opponent.chart} ${opponent.actions.join(' then ')}`, range, steps, i };
  });

  const equity = computeEquity({
    hole: hero, board, opponents: ranges.map((r) => r.range),
    rng: createRng(`sanity:${spot.name}`), iterations: ITERATIONS,
  });

  // Split each opponent's range at exactly the price the solver will use.
  const pricing = priceAction(spot.pot, spot.toCall);
  const continuing = ranges.map((r) => splitByFoldDecision(
    r.range, board, pricing.villainMustCall, pricing.potVillainFaces,
  ));
  const equityVsContinuing = continuing.every((s) => !s.continuing.isEmpty)
    ? computeEquity({
        hole: hero, board, opponents: continuing.map((s) => s.continuing),
        rng: createRng(`sanity-cont:${spot.name}`), iterations: ITERATIONS,
      }).equityFraction
    : undefined;

  const solution = solveAction({
    equity: equity.equityFraction,
    ...(equityVsContinuing !== undefined ? { equityVsContinuing } : {}),
    pot: spot.pot,
    toCall: spot.toCall,
    opponentRange: ranges[0].range,
    board,
  });

  const heroClass = classifyCombo(hero[0], hero[1], board).madeClass;
  const odds = potOdds(spot.toCall, spot.pot);

  console.log(`\n${bar(78)}`);
  console.log(spot.name);
  console.log(bar(78));
  console.log(`  hero      ${spot.hero}   (${heroClass})`);
  console.log(`  board     ${board.map(codeToString).join(' ')}`);
  console.log(`  pot ${spot.pot}, to call ${spot.toCall}  ->  pot odds ${odds.potOddsPercent.toFixed(1)}%`);
  for (const r of ranges) {
    console.log(`  villain ${r.i + 1}  ${r.label.padEnd(22)} ${r.range.comboCount} combos, ${r.range.percentOfHands.toFixed(1)}% of hands`);
  }
  console.log(`  equity    ${equity.equity.toFixed(1)}% (+/- ${equity.standardError.toFixed(2)}pp)`
    + (equityVsContinuing !== undefined
      ? `   vs continuing range: ${(equityVsContinuing * 100).toFixed(1)}%` : ''));
  console.log(`  folds to hero's ${pricing.betSize.toFixed(0)}: ${(solution.foldEquity * 100).toFixed(1)}%`);
  console.log('');
  for (const r of solution.ranked) {
    const mark = r.action === solution.best ? '>' : ' ';
    const tag = r.correct ? '  ACCEPTED' : '';
    console.log(`  ${mark} ${r.action.padEnd(6)} EV ${r.ev >= 0 ? '+' : ''}${r.ev.toFixed(1).padStart(7)}${tag}`);
  }
  console.log(`\n  firedRules:`);
  for (const rule of solution.firedRules) console.log(`    - ${rule}`);
  console.log(`\n  expected: ${spot.expect}`);
}
console.log('');
