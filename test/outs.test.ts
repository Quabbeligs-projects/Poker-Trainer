import { describe, expect, it } from 'vitest';

import { codesFromStrings, createRng } from '../src/engine/deck';
import { countOuts, exactHitProbability, ruleOfFourAndTwo } from '../src/engine/outs';
import { computeEquity } from '../src/engine/equity';
import { Range } from '../src/engine/ranges';

const C = (text: string) => codesFromStrings(text.split(/\s+/).filter(Boolean));

describe('counting outs', () => {
  it('counts a flush draw as nine', () => {
    // 7h 2h on Kd 8h 3h: nine hearts, and pairing the 7 or 2 does not beat a
    // blank hand's king-high board pair, so it is nine and only nine.
    const result = countOuts(C('7h 2h'), C('Kd 8h 3h'));
    expect(result.currentCategory).toBe('High Card');
    const flushOuts = result.byCategory.find((b) => b.category === 'Flush');
    expect(flushOuts?.count).toBe(9);
  });

  it('counts an open-ended straight draw as eight', () => {
    const result = countOuts(C('9c 8d'), C('Kh 7c 6s'));
    const straight = result.byCategory.find((b) => b.category === 'Straight');
    expect(straight?.count).toBe(8);
  });

  it('counts a gutshot as four', () => {
    // JT on Q83 needs a nine only.
    const result = countOuts(C('Js Th'), C('Qd 8h 3c'));
    const straight = result.byCategory.find((b) => b.category === 'Straight');
    expect(straight?.count).toBe(4);
  });

  it('counts two overcards as six', () => {
    const result = countOuts(C('Ah Qc'), C('9d 5s 2h'));
    const pairs = result.byCategory.find((b) => b.category === 'One Pair');
    expect(pairs?.count).toBe(6);
  });

  it('does NOT count cards that pair the board', () => {
    // The whole point of the blank benchmark. A paired board gives the same
    // pair to everyone, so it is not hero's out. Without this, a nut flush
    // draw counts 23 outs and the rule of 4 claims 92%.
    const result = countOuts(C('Ah Qh'), C('Kd 8h 3h'));
    expect(result.total).toBe(15); // 9 hearts + 3 aces + 3 queens
    const boardPairingCards = ['Kc', 'Ks', '8c', '8s', '3c', '3s'];
    for (const card of boardPairingCards) {
      const code = C(card)[0];
      expect(
        result.outs.some((out) => out.code === code),
        `${card} pairs the board and must not count as an out`,
      ).toBe(false);
    }
  });

  it('gives a made straight no outs to a higher category it cannot reach', () => {
    // A hand that is already a straight on a rainbow board can still make a
    // full house or better, so outs are not necessarily zero; they must simply
    // all be genuine improvements.
    const result = countOuts(C('9c 8d'), C('Th 7c 6s'));
    expect(result.currentCategory).toBe('Straight');
    for (const out of result.outs) {
      expect(['Flush', 'Full House', 'Four of a Kind', 'Straight Flush'])
        .toContain(out.to);
    }
  });

  it('never returns an out that is already visible', () => {
    const hole = C('Ah Qh');
    const board = C('Kd 8h 3h');
    const visible = new Set([...hole, ...board]);
    for (const out of countOuts(hole, board).outs) {
      expect(visible.has(out.code)).toBe(false);
    }
  });

  it('reports the right number of unseen cards', () => {
    expect(countOuts(C('Ah Qh'), C('Kd 8h 3h')).unseen).toBe(47);
    expect(countOuts(C('Ah Qh'), C('Kd 8h 3h 2c')).unseen).toBe(46);
  });

  it('rejects boards where outs are undefined', () => {
    expect(() => countOuts(C('Ah Qh'), [])).toThrow(/flop or turn/);
    expect(() => countOuts(C('Ah Qh'), C('Kd 8h 3h 2c 5d'))).toThrow(/flop or turn/);
    expect(() => countOuts(C('Ah'), C('Kd 8h 3h'))).toThrow(/exactly 2/);
  });
});

describe('the rule of 4 and 2', () => {
  it('is outs x 4 with two to come and x 2 with one', () => {
    expect(ruleOfFourAndTwo(9, 2)).toBe(36);
    expect(ruleOfFourAndTwo(9, 1)).toBe(18);
    expect(ruleOfFourAndTwo(8, 2)).toBe(32);
  });

  it('never exceeds 100%', () => {
    expect(ruleOfFourAndTwo(30, 2)).toBe(100);
  });

  it('understates with few outs and overstates with many', () => {
    // The shortcut is not uniformly optimistic. With few outs the linear
    // approximation sits below the true probability; the two cross at around
    // five outs, and beyond that the shortcut runs increasingly high because it
    // double-counts runouts that hit on both cards.
    const errorAt = (outs: number) =>
      ruleOfFourAndTwo(outs, 2) - exactHitProbability(outs, 2, 47);
    expect(errorAt(3)).toBeLessThan(0);
    expect(errorAt(4)).toBeLessThan(0);
    expect(errorAt(9)).toBeGreaterThan(0);
    expect(errorAt(15)).toBeGreaterThan(0);
    // Monotonically increasing error as outs grow.
    for (const outs of [3, 4, 6, 8, 9, 12, 15]) {
      expect(errorAt(outs + 1)).toBeGreaterThan(errorAt(outs));
    }
    // Even at its worst the arithmetic error stays modest — far smaller than
    // the error from ignoring the opponent's range, which is the point.
    for (const outs of [3, 4, 6, 8, 9, 12, 15]) {
      expect(Math.abs(errorAt(outs))).toBeLessThan(8);
    }
  });

  it('is close with one card to come, always slightly low', () => {
    for (const outs of [4, 8, 9, 12]) {
      const error = ruleOfFourAndTwo(outs, 1) - exactHitProbability(outs, 1, 46);
      expect(error).toBeLessThan(0);       // x2 slightly understates out of 46
      expect(Math.abs(error)).toBeLessThan(3);
    }
  });

  it('rejects impossible street counts', () => {
    expect(() => ruleOfFourAndTwo(9, 0)).toThrow();
    expect(() => ruleOfFourAndTwo(9, 3)).toThrow();
  });
});

describe('equity decomposition', () => {
  const run = (hole: string, board: string, opponent: Range) => computeEquity({
    hole: C(hole), board: C(board), opponents: [opponent],
    rng: createRng(`breakdown:${hole}:${board}`), iterations: 60_000,
  });

  it('splits equity into as-is and improved, summing exactly to the total', () => {
    const result = run('Ah Qh', 'Kd 8h 3h', Range.parse(['22+', 'A2s+', 'KTs+']));
    expect(result.breakdown).not.toBeNull();
    const { asIs, improved } = result.breakdown!;
    expect(asIs + improved).toBeCloseTo(result.equity, 6);
    expect(asIs).toBeGreaterThanOrEqual(0);
    expect(improved).toBeGreaterThanOrEqual(0);
  });

  it('attributes a drawing hand mostly to improvement', () => {
    const result = run('7h 2h', 'Kd 8h 3h', Range.parse(['KQs', 'KJs', 'KTs', 'AKo']));
    const { asIs, improved } = result.breakdown!;
    // 72 offsuit-ish garbage against top pair wins almost only by making the flush.
    expect(improved).toBeGreaterThan(asIs * 3);
  });

  it('attributes a made hand mostly to being already ahead', () => {
    const result = run('Ks Kh', 'Kd 8h 3h', Range.parse(['A2s+', 'KTs+', 'QJs']));
    const { asIs, improved } = result.breakdown!;
    expect(asIs).toBeGreaterThan(improved);
    expect(result.breakdown!.currentCategory).toBe('Three of a Kind');
  });

  it('reports the finishing categories with frequencies that sum to one', () => {
    const result = run('Ah Qh', 'Kd 8h 3h', Range.full());
    const total = result.breakdown!.byFinalCategory
      .reduce((sum, entry) => sum + entry.frequency, 0);
    expect(total).toBeCloseTo(1, 6);
    const equitySum = result.breakdown!.byFinalCategory
      .reduce((sum, entry) => sum + entry.equity, 0);
    expect(equitySum).toBeCloseTo(result.equity, 6);
  });

  it('reports an improvement rate consistent with the categories', () => {
    const result = run('Ah Qh', 'Kd 8h 3h', Range.full());
    const { improvementRate, currentCategory, byFinalCategory } = result.breakdown!;
    expect(improvementRate).toBeGreaterThan(0);
    expect(improvementRate).toBeLessThanOrEqual(1);
    expect(currentCategory).toBe('High Card');
    expect(byFinalCategory.length).toBeGreaterThan(1);
  });

  it('is absent preflop and on the river, where it is meaningless', () => {
    expect(computeEquity({
      hole: C('Ah Qh'), opponents: [Range.full()],
      rng: createRng('nb1'), iterations: 2_000,
    }).breakdown).toBeNull();
    expect(computeEquity({
      hole: C('Ah Qh'), board: C('Kd 8h 3h 2c 5d'), opponents: [Range.full()],
      rng: createRng('nb2'), iterations: 2_000,
    }).breakdown).toBeNull();
  });

  it('does not meaningfully slow the hot loop', () => {
    const started = Date.now();
    computeEquity({
      hole: C('Ah Qh'), board: C('Kd 8h 3h'),
      opponents: [Range.parse(['22+', 'A2s+', 'KTs+'])],
      rng: createRng('perf-breakdown'), iterations: 100_000,
    });
    expect(Date.now() - started).toBeLessThan(400);
  });
});
