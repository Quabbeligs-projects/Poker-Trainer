/**
 * Equity benchmarks.
 *
 * Two independent layers of validation:
 *
 *   1. `exactEquityVsHand` enumerates every remaining board exhaustively. It is
 *      checked against published equity figures. This is the oracle.
 *   2. The Monte Carlo estimator is checked against that oracle, so sampling
 *      bias shows up as a systematic gap rather than being hidden behind a
 *      loose "close to published" tolerance.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ITERATIONS,
  computeEquity,
  exactEquityVsHand,
} from '../src/engine/equity';
import { Range } from '../src/engine/ranges';
import { codesFromStrings, createRng } from '../src/engine/deck';

const C = (text: string) => codesFromStrings(text.split(/\s+/).filter(Boolean));

/** A range containing exactly one specific two-card hand. */
const exactly = (hand: string) => Range.parse([hand.split(/\s+/).join('')], hand);

interface Scenario {
  readonly name: string;
  readonly hero: string;
  readonly villain: string;
  readonly board: string;
  /** Published equity range for hero, in percent. */
  readonly published: readonly [number, number];
  readonly note: string;
}

/**
 * Every `published` band below is the figure quoted in standard equity tables,
 * widened only enough to cover variation between suit configurations of the
 * same hand class.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'AA vs KK (preflop)',
    hero: 'As Ah', villain: 'Kc Kd', board: '',
    published: [80.0, 83.0],
    note: 'the canonical ~81-82% cooler',
  },
  {
    name: 'AA vs KK (suit-blocking config)',
    hero: 'As Ah', villain: 'Ks Kd', board: '',
    published: [80.0, 83.5],
    note: 'shared spade nudges AA up slightly',
  },
  {
    name: 'AKs vs QQ (preflop)',
    hero: 'Ah Kh', villain: 'Qs Qd', board: '',
    published: [45.0, 47.5],
    note: 'published 46.2%',
  },
  {
    name: 'AKo vs QQ (preflop)',
    hero: 'Ah Ks', villain: 'Qc Qd', board: '',
    published: [42.0, 44.0],
    note: 'published ~43%',
  },
  {
    name: 'AKo vs JJ (preflop)',
    hero: 'Ah Ks', villain: 'Jc Jd', board: '',
    published: [42.0, 44.5],
    note: 'the classic coin flip',
  },
  {
    name: '22 vs AKo (preflop)',
    hero: '2c 2d', villain: 'Ah Ks', board: '',
    published: [52.0, 54.0],
    note: 'small pair is a small favourite, published ~52.9%',
  },
  {
    name: 'JTs vs AA (preflop)',
    hero: 'Jh Th', villain: 'As Ad', board: '',
    published: [20.5, 23.0],
    note: 'best hand against aces, published ~21-22%',
  },
  {
    name: 'bare flush draw vs top pair (flop)',
    hero: '7h 2h', villain: 'Ks 9c', board: 'Kd 8h 3h',
    published: [34.0, 38.0],
    note: '9 outs twice, the ~35% benchmark',
  },
  {
    name: 'nut flush draw + overcard vs top pair (flop)',
    hero: 'Ah Qh', villain: 'Ks 9c', board: 'Kd 8h 3h',
    published: [43.0, 48.0],
    note: '9 flush outs plus 3 clean ace outs',
  },
  {
    name: 'open-ended straight draw vs top pair (flop)',
    hero: '9c 8d', villain: 'Kh Qc', board: 'Kd 7c 6h',
    published: [31.0, 36.0],
    note: '8 outs twice, the ~32% benchmark',
  },
  {
    name: 'set vs nut flush draw (flop)',
    hero: '7c 7d', villain: 'Ah Qh', board: '7h 5h 2c',
    published: [72.0, 77.0],
    note: 'set is roughly a 3:1 favourite',
  },
];

describe('exhaustive enumeration matches published equity tables', () => {
  const results: Array<{ scenario: Scenario; exact: number }> = [];

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s',
    (_name, scenario) => {
      const exact = exactEquityVsHand(
        C(scenario.hero),
        C(scenario.villain),
        C(scenario.board),
      );
      results.push({ scenario, exact });
      const [min, max] = scenario.published;
      expect(exact, `${scenario.name} enumerated at ${exact.toFixed(2)}%`)
        .toBeGreaterThanOrEqual(min);
      expect(exact, `${scenario.name} enumerated at ${exact.toFixed(2)}%`)
        .toBeLessThanOrEqual(max);
    },
  );
});

describe('EQUITY BENCHMARKS: Monte Carlo vs exhaustive enumeration', () => {
  it('agrees with exhaustive enumeration on every benchmark scenario', () => {
    const rows: string[] = [];
    const errors: number[] = [];
    let worst = 0;
    let worstName = '';

    for (const scenario of SCENARIOS) {
      const hero = C(scenario.hero);
      const villain = C(scenario.villain);
      const board = C(scenario.board);

      const exact = exactEquityVsHand(hero, villain, board);
      const mc = computeEquity({
        hole: hero,
        board,
        opponents: [exactly(scenario.villain)],
        rng: createRng(`benchmark:${scenario.name}`),
        iterations: DEFAULT_ITERATIONS,
      });

      const error = mc.equity - exact;
      errors.push(error);
      if (Math.abs(error) > Math.abs(worst)) {
        worst = error;
        worstName = scenario.name;
      }

      rows.push(
        '      '
        + scenario.name.padEnd(46)
        + `exact ${exact.toFixed(2).padStart(6)}%`
        + `   MC ${mc.equity.toFixed(2).padStart(6)}%`
        + `   err ${(error >= 0 ? '+' : '') + error.toFixed(2)}pp`
        + `   SE ${mc.standardError.toFixed(3)}pp`
        + `   ${mc.iterations.toLocaleString()} iters`
        + `   ${mc.elapsedMs}ms`,
      );

      // The Monte Carlo estimate must be far tighter than the +/-5pp grading
      // tolerance, or the training signal is noise.
      expect(
        Math.abs(error),
        `${scenario.name}: MC ${mc.equity.toFixed(2)}% vs exact ${exact.toFixed(2)}%`,
      ).toBeLessThan(0.5);
      // And it must be within 4 standard errors, which catches bias that a
      // fixed tolerance would let through.
      expect(Math.abs(error)).toBeLessThan(Math.max(4 * mc.standardError, 0.2));
    }

    const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log(
      `\n    EQUITY BENCHMARKS (${DEFAULT_ITERATIONS.toLocaleString()} iterations)\n`
      + `${rows.join('\n')}\n`
      + `      ${'mean signed error'.padEnd(46)}${(meanError >= 0 ? '+' : '') + meanError.toFixed(3)}pp`
      + `   worst ${(worst >= 0 ? '+' : '') + worst.toFixed(3)}pp (${worstName})\n`,
    );

    // No systematic bias across the suite.
    expect(Math.abs(meanError)).toBeLessThan(0.15);
  });
});

describe('Monte Carlo correctness', () => {
  it('is exactly reproducible from a seed', () => {
    const run = () => computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.parse(['22+', 'ATs+'])],
      rng: createRng('repeat-me'),
      iterations: 20_000,
    });
    const first = run();
    const second = run();
    expect(second.equity).toBe(first.equity);
    expect(second.wins).toBe(first.wins);
    expect(second.ties).toBe(first.ties);
    expect(second.losses).toBe(first.losses);
    expect(second.iterations).toBe(first.iterations);
  });

  it('gives different results for different seeds, but close ones', () => {
    const at = (seed: string) => computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.parse(['22+', 'ATs+'])],
      rng: createRng(seed),
      iterations: 100_000,
    }).equity;
    const a = at('seed-a');
    const b = at('seed-b');
    expect(a).not.toBe(b);
    expect(Math.abs(a - b)).toBeLessThan(1);
  });

  it('counts wins, ties and losses so they sum to the iteration count', () => {
    const result = computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.full()],
      rng: createRng('counts'),
      iterations: 50_000,
    });
    expect(result.wins + result.ties + result.losses).toBe(result.iterations);
    expect(result.equityFraction).toBeCloseTo(result.equity / 100, 12);
  });

  it('splits a dead-tie board exactly in half', () => {
    // Both players play the board: an unbeatable royal flush on the table.
    const result = computeEquity({
      hole: C('2c 3d'),
      board: C('As Ks Qs Js Ts'),
      opponents: [exactly('2h 3h')],
      rng: createRng('dead-tie'),
      iterations: 5_000,
    });
    expect(result.equity).toBe(50);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(0);
    expect(result.ties).toBe(result.iterations);
  });

  it('scores a three-way tie as one third', () => {
    const result = computeEquity({
      hole: C('2c 3d'),
      board: C('As Ks Qs Js Ts'),
      opponents: [exactly('2h 3h'), exactly('4c 5d')],
      rng: createRng('three-way-tie'),
      iterations: 5_000,
    });
    expect(result.equity).toBeCloseTo(100 / 3, 10);
    expect(result.ties).toBe(result.iterations);
  });

  it('resolves a decided river with no uncertainty at all', () => {
    const won = computeEquity({
      hole: C('As Ac'),
      board: C('Ad Kh 7c 2s 3d'),
      opponents: [exactly('Kc Kd')],
      rng: createRng('river-won'),
      iterations: 2_000,
    });
    expect(won.equity).toBe(100);
    expect(won.standardError).toBe(0);

    const lost = computeEquity({
      hole: C('Kc Kd'),
      board: C('Ad Kh 7c 2s 3d'),
      opponents: [exactly('As Ac')],
      rng: createRng('river-lost'),
      iterations: 2_000,
    });
    expect(lost.equity).toBe(0);
  });

  it('is symmetric: hero vs villain equities sum to 100', () => {
    const board = C('Kd 8h 3h');
    const hero = computeEquity({
      hole: C('7h 2h'), board, opponents: [exactly('Ks 9c')],
      rng: createRng('sym-a'), iterations: 200_000,
    }).equity;
    const villain = computeEquity({
      hole: C('Ks 9c'), board, opponents: [exactly('7h 2h')],
      rng: createRng('sym-b'), iterations: 200_000,
    }).equity;
    expect(hero + villain).toBeCloseTo(100, 0);
  });

  it('loses equity as opponents are added', () => {
    const hole = C('As Ad');
    const board = C('7h 5c 2d');
    const equities = [1, 2, 3, 4].map((count) => computeEquity({
      hole,
      board,
      opponents: Array.from({ length: count }, () => Range.full()),
      rng: createRng(`multiway-${count}`),
      iterations: 50_000,
    }).equity);
    for (let i = 1; i < equities.length; i++) {
      expect(equities[i]!).toBeLessThan(equities[i - 1]!);
    }
    expect(equities[0]!).toBeGreaterThan(85);
  });

  it('samples opponents from their range, never outside it', () => {
    // Hero holds a hand that only beats the bottom of a premium-only range.
    // If sampling leaked outside the range, equity would rise noticeably.
    const tight = Range.parse(['AA']);
    const result = computeEquity({
      hole: C('Kc Kd'),
      board: C('Kh 7s 2d'),
      opponents: [tight],
      rng: createRng('range-respect'),
      iterations: 50_000,
    });
    // Hero flopped a set of kings against exactly AA: a huge favourite.
    const exact = exactEquityVsHand(C('Kc Kd'), C('As Ah'), C('Kh 7s 2d'));
    expect(Math.abs(result.equity - exact)).toBeLessThan(1);
  });

  it('respects card removal: blocked combos are never dealt', () => {
    // Hero holds two aces, so the opponent cannot also hold aces.
    // An 'AA'-only range is fully blocked and must fail loudly.
    expect(() => computeEquity({
      hole: C('As Ah'),
      board: C('Ad Ac 7s'),
      opponents: [Range.parse(['AA'])],
      rng: createRng('blocked'),
      iterations: 1_000,
    })).toThrow(/no combos/i);
  });

  it('weights ranges correctly when sampling', () => {
    // A range that is 'AA' at full weight and '72o' at a tiny weight should
    // behave almost exactly like an AA-only range.
    const heavy = Range.parse(['AA', { hand: '72o', weight: 0.01 }]);
    const pure = Range.parse(['AA']);
    const opts = { hole: C('Kc Kd'), board: C('Kh 7s 2d'), iterations: 100_000 };
    const a = computeEquity({ ...opts, opponents: [heavy], rng: createRng('w1') }).equity;
    const b = computeEquity({ ...opts, opponents: [pure], rng: createRng('w2') }).equity;
    expect(Math.abs(a - b)).toBeLessThan(1.5);
  });
});

describe('standard error and auto-raise', () => {
  it('reports a standard error that shrinks with the square root of iterations', () => {
    const at = (iterations: number) => computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.full()],
      rng: createRng('se'),
      iterations,
      targetStandardError: 0, // disable auto-raise so we measure the raw run
      maxIterations: iterations,
    }).standardError;
    const small = at(10_000);
    const large = at(160_000);
    // 16x the iterations should be about 4x tighter.
    expect(large).toBeLessThan(small);
    expect(small / large).toBeGreaterThan(3);
    expect(small / large).toBeLessThan(5);
  });

  it('keeps the default run comfortably inside the 0.5pp target', () => {
    const result = computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.full()],
      rng: createRng('default-se'),
      iterations: DEFAULT_ITERATIONS,
    });
    expect(result.standardError).toBeLessThan(0.5);
    expect(result.iterations).toBe(DEFAULT_ITERATIONS);
    expect(result.hitIterationCeiling).toBe(false);
  });

  it('raises iterations automatically when the first pass is too noisy', () => {
    const result = computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.full()],
      rng: createRng('auto-raise'),
      iterations: 500, // far too few: SE would be ~2pp
      targetStandardError: 0.5,
    });
    expect(result.iterations).toBeGreaterThan(500);
    expect(result.standardError).toBeLessThanOrEqual(0.5);
  });

  it('never exceeds the iteration ceiling', () => {
    const result = computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.full()],
      rng: createRng('ceiling'),
      iterations: 1_000,
      targetStandardError: 0.001, // unattainable
      maxIterations: 30_000,
    });
    expect(result.iterations).toBeLessThanOrEqual(30_000);
    expect(result.hitIterationCeiling).toBe(true);
  });
});

describe('performance ceiling', () => {
  // A GENEROUS ceiling, not a benchmark. Wall-clock assertions in a correctness
  // suite fail at random under CI load, and a deploy must never be blocked by a
  // busy runner. 5s catches an actual algorithmic regression — the real numbers
  // are printed by `npm run bench`, which CI runs without gating on.
  const CEILING_MS = 5_000;

  it('completes 100,000 heads-up iterations without an algorithmic regression', () => {
    const started = Date.now();
    const result = computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: [Range.parse(['22+', 'A2s+', 'KTs+', 'QJs', 'AJo+', 'KQo'])],
      rng: createRng('perf-heads-up'),
      iterations: DEFAULT_ITERATIONS,
    });
    expect(result.iterations).toBe(DEFAULT_ITERATIONS);
    expect(Date.now() - started).toBeLessThan(CEILING_MS);
  });

  it('stays within the ceiling multiway', () => {
    const started = Date.now();
    computeEquity({
      hole: C('Ah Kh'),
      board: C('Qh 7d 2c'),
      opponents: Array.from({ length: 8 }, () => Range.parse(['22+', 'A2s+', 'KTs+'])),
      rng: createRng('perf-multi-8'),
      iterations: DEFAULT_ITERATIONS,
    });
    expect(Date.now() - started).toBeLessThan(CEILING_MS * 2);
  });
});

describe('input validation', () => {
  const base = {
    hole: C('Ah Kh'),
    opponents: [Range.full()],
    rng: createRng('validate'),
    iterations: 1_000,
  };

  it('requires exactly two hole cards', () => {
    expect(() => computeEquity({ ...base, hole: C('Ah') })).toThrow(/exactly 2/);
    expect(() => computeEquity({ ...base, hole: C('Ah Kh Qh') })).toThrow(/exactly 2/);
  });

  it('requires a legal board length', () => {
    expect(() => computeEquity({ ...base, board: C('Ah') })).toThrow(/0, 3, 4 or 5/);
    expect(() => computeEquity({ ...base, board: C('2c 3d') })).toThrow(/0, 3, 4 or 5/);
  });

  it('rejects duplicate cards between hero and the board', () => {
    expect(() => computeEquity({ ...base, board: C('Ah 7d 2c') })).toThrow(/[Dd]uplicate/);
  });

  it('requires at least one opponent and says what to do instead', () => {
    expect(() => computeEquity({ ...base, opponents: [] }))
      .toThrow(/Range\.full\(\)/);
  });

  it('rejects nonsense iteration counts', () => {
    expect(() => computeEquity({ ...base, iterations: 0 })).toThrow();
    expect(() => computeEquity({ ...base, iterations: -5 })).toThrow();
    expect(() => computeEquity({ ...base, iterations: 1.5 })).toThrow();
  });
});
