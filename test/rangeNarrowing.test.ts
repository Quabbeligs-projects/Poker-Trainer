import { describe, expect, it } from 'vitest';

import rangesJson from '../src/data/ranges.json';
import { RangeCharts, Range, type RangeChartsJson, comboHigh, comboLow } from '../src/engine/ranges';
import { codesFromStrings } from '../src/engine/deck';
import {
  MAX_INTENSITY,
  MIN_INTENSITY,
  REFERENCE_BET_FRACTION,
  narrowingIntensity,
  MADE_CLASSES,
  MAX_NARROWING_PER_STREET,
  MIN_SURVIVING_COMBOS,
  MIN_SURVIVING_WEIGHT,
  NARROWING_RULES,
  POSTFLOP_ACTIONS,
  type PostflopAction,
  applyAction,
  classifyCombo,
  foldFrequency,
  narrowRange,
  splitByFoldDecision,
} from '../src/engine/rangeNarrowing';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const C = (text: string) => codesFromStrings(text.split(/\s+/).filter(Boolean));

/** Average weight the rule assigns to a class across a range, for assertions. */
function weightOfClass(range: Range, board: number[], target: string): number {
  let total = 0;
  for (const index of range.nonZeroIndices) {
    const c = classifyCombo(comboHigh(index), comboLow(index), board);
    if (c.madeClass === target) total += range.weightOf(index);
  }
  return total;
}

describe('hand classification is derived, not guessed', () => {
  const board = C('Kd 8h 3h');

  it('classifies made hands by what they actually are', () => {
    const cases: Array<[string, string]> = [
      ['Kc Kh', 'strong'],    // a set is 'strong'; 'monster' starts at a straight
      ['8s 8d', 'strong'],    // set of eights
      ['Ks 8c', 'strong'],    // two pair
      ['Ah Ad', 'overpair'],
      ['Ks 9c', 'topPair'],
      ['8s 7c', 'weakPair'],
      ['Qh Jh', 'strongDraw'], // flush draw
      ['7c 2d', 'nothing'],
    ];
    for (const [hand, expected] of cases) {
      const [a, b] = C(hand) as [number, number];
      expect(classifyCombo(a, b, board).madeClass, hand).toBe(expected);
    }
  });

  it('reserves monster for a straight or better', () => {
    const flushBoard = C('Kh 8h 3h');
    const [a, b] = C('Ah 2h') as [number, number];
    expect(classifyCombo(a, b, flushBoard).madeClass).toBe('monster');
    const straightBoard = C('Qd Jc Th');
    const [c, d] = C('Ah Ks') as [number, number];
    expect(classifyCombo(c, d, straightBoard).madeClass).toBe('monster');
  });

  it('finds no straight draw on a board that cannot make one', () => {
    // 8, 3 and K share no run, so nothing on this flop is a straight draw.
    // This is why weakDraw is legitimately empty on such boards.
    const board = C('Kd 8h 3h');
    let weakDraws = 0;
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        if (board.includes(a) || board.includes(b)) continue;
        if (classifyCombo(a, b, board).madeClass === 'weakDraw') weakDraws++;
      }
    }
    expect(weakDraws).toBe(0);
  });

  it('counts a flush draw as nine outs', () => {
    const [a, b] = C('Qh Jh') as [number, number];
    const result = classifyCombo(a, b, board);
    expect(result.hasDraw).toBe(true);
    expect(result.outs).toBeGreaterThanOrEqual(8);
  });

  it('counts an open-ended straight draw as eight outs', () => {
    const oesdBoard = C('Kd 7c 6s');
    const [a, b] = C('9h 8d') as [number, number];
    const result = classifyCombo(a, b, oesdBoard);
    expect(result.madeClass).toBe('strongDraw');
    expect(result.outs).toBeGreaterThanOrEqual(8);
  });

  it('treats a gutshot as a weak draw, not a strong one', () => {
    const gutshotBoard = C('Kd 7c 6s');
    const [a, b] = C('Th 9d') as [number, number];
    // T9 needs an 8 only: four outs.
    expect(classifyCombo(a, b, gutshotBoard).madeClass).toBe('weakDraw');
  });

  it('recognises an overpair only when it beats the whole board', () => {
    const [qa, qb] = C('Qh Qd') as [number, number];
    // Board is King-high, so queens are NOT an overpair.
    expect(classifyCombo(qa, qb, board).madeClass).toBe('weakPair');
    const [aa, ab] = C('Ah Ad') as [number, number];
    expect(classifyCombo(aa, ab, board).madeClass).toBe('overpair');
  });

  it('handles the wheel when counting straight outs', () => {
    const wheelBoard = C('4d 3c Kh');
    const [a, b] = C('Ah 2d') as [number, number];
    // A2 with 43 needs a 5 for the wheel.
    const result = classifyCombo(a, b, wheelBoard);
    expect(result.outs).toBeGreaterThan(0);
  });
});

describe('every documented rule does what its comment says', () => {
  const board = C('Kd 8h 3h');
  const base = charts.rfi('CO');

  it('has a rule for every modelled action, with a readable label', () => {
    for (const action of POSTFLOP_ACTIONS) {
      const rule = NARROWING_RULES[action];
      expect(rule.label.length).toBeGreaterThan(10);
      for (const [key, value] of Object.entries(rule.weights)) {
        expect(MADE_CLASSES).toContain(key);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('check weights away from strong made hands but keeps traps', () => {
    const { range } = applyAction(base, 'check', board);
    // Sets and two pair survive a check: the rule keeps traps rather than
    // zeroing them, so hero cannot assume a checker is weak.
    expect(weightOfClass(range, board, 'strong')).toBeGreaterThan(0);
    expect(NARROWING_RULES.check.weights.monster!).toBeLessThan(1);
    expect(NARROWING_RULES.check.weights.strong!).toBeLessThan(1);
    expect(NARROWING_RULES.check.weights.nothing!).toBeGreaterThan(1);
  });

  it('check-call weights toward marginal made hands and draws', () => {
    const rule = NARROWING_RULES.checkCall.weights;
    expect(rule.topPair!).toBeGreaterThan(1);
    expect(rule.weakPair!).toBeGreaterThan(1);
    expect(rule.strongDraw!).toBeGreaterThan(1);
    expect(rule.monster!).toBeLessThan(0.5);
    expect(rule.nothing!).toBeLessThan(0.5);
  });

  it('bet and raise weight toward strong made hands and semi-bluffs', () => {
    for (const action of ['bet', 'raise', 'checkRaise'] as PostflopAction[]) {
      const rule = NARROWING_RULES[action].weights;
      expect(rule.monster!, action).toBeGreaterThan(1);
      expect(rule.strong!, action).toBeGreaterThan(1);
      expect(rule.strongDraw!, action).toBeGreaterThan(1);
    }
  });

  it('never zeroes bluffs out of a raising range', () => {
    // Zeroing 'nothing' from a raise would let hero call far too wide.
    for (const action of ['raise', 'checkRaise'] as PostflopAction[]) {
      expect(NARROWING_RULES[action].weights.nothing!).toBeGreaterThan(0);
    }
  });

  it('makes a raised range genuinely stronger than a checked one', () => {
    const raised = applyAction(base, 'raise', board).range;
    const checked = applyAction(base, 'check', board).range;
    const strongShare = (range: Range) => {
      let strong = 0;
      let total = 0;
      for (const index of range.nonZeroIndices) {
        const weight = range.weightOf(index);
        total += weight;
        const c = classifyCombo(comboHigh(index), comboLow(index), board);
        if (c.madeClass === 'monster' || c.madeClass === 'strong' || c.madeClass === 'overpair') {
          strong += weight;
        }
      }
      return strong / total;
    };
    expect(strongShare(raised)).toBeGreaterThan(strongShare(checked));
  });
});

describe('bet size changes how hard a rule bites', () => {
  const board = C('Qd 8h 3c');
  const base = charts.rfi('CO');

  const airShare = (range: Range) => {
    let air = 0;
    let total = 0;
    for (const index of range.nonZeroIndices) {
      const weight = range.weightOf(index);
      total += weight;
      if (classifyCombo(comboHigh(index), comboLow(index), board).madeClass === 'nothing') {
        air += weight;
      }
    }
    return air / total;
  };

  it('is neutral at the reference size and clamps at the extremes', () => {
    expect(narrowingIntensity(REFERENCE_BET_FRACTION)).toBeCloseTo(1, 9);
    expect(narrowingIntensity(0.05)).toBe(MIN_INTENSITY);
    expect(narrowingIntensity(10)).toBe(MAX_INTENSITY);
    expect(narrowingIntensity(0)).toBe(1);
    expect(narrowingIntensity(NaN)).toBe(1);
  });

  it('leaves a bigger bettor with less air than a small bettor', () => {
    // Treating a quarter-pot stab and a pot-sized bet identically was a real
    // defect: it gave a gutshot facing a pot bet the same read as a min-bet.
    const small = applyAction(base, 'bet', board, { betFraction: 0.25 }).range;
    const large = applyAction(base, 'bet', board, { betFraction: 1.0 }).range;
    expect(airShare(large)).toBeLessThan(airShare(small));
    expect(airShare(small)).toBeLessThan(airShare(base.removeCards(board)) + 1e-9);
  });

  it('never inverts a rule, however extreme the sizing', () => {
    // A promotion must stay a promotion and a demotion a demotion at any size.
    for (const betFraction of [0.05, 0.25, 0.5, 1, 2, 10]) {
      const narrowed = applyAction(base, 'raise', board, { betFraction }).range;
      const before = base.removeCards(board);
      const shareOf = (range: Range, target: string) => {
        let hit = 0;
        let total = 0;
        for (const index of range.nonZeroIndices) {
          const weight = range.weightOf(index);
          total += weight;
          if (classifyCombo(comboHigh(index), comboLow(index), board).madeClass === target) {
            hit += weight;
          }
        }
        return hit / total;
      };
      expect(shareOf(narrowed, 'strong'), `bet ${betFraction}`)
        .toBeGreaterThan(shareOf(before, 'strong'));
      expect(shareOf(narrowed, 'nothing'), `bet ${betFraction}`)
        .toBeLessThan(shareOf(before, 'nothing'));
    }
  });

  it('defaults to the reference size when no sizing is supplied', () => {
    const implicit = applyAction(base, 'bet', board).range;
    const explicit = applyAction(base, 'bet', board,
      { betFraction: REFERENCE_BET_FRACTION }).range;
    expect(implicit.totalWeight).toBeCloseTo(explicit.totalWeight, 9);
  });

  it('records the intensity it used', () => {
    const { step } = applyAction(base, 'bet', board, { betFraction: 1.0 });
    expect(step.intensity).toBeCloseTo(1.0 / REFERENCE_BET_FRACTION, 9);
  });
});

describe('the floor', () => {
  const board = C('Kd 8h 3h');

  it('never narrows a range to nothing, however many aggressive actions', () => {
    let range = charts.rfi('UTG');
    for (let street = 0; street < 6; street++) {
      const applied = applyAction(range, 'raise', board);
      range = applied.range;
      expect(range.isEmpty, `empty after ${street + 1} raises`).toBe(false);
      expect(range.comboCount).toBeGreaterThanOrEqual(MIN_SURVIVING_COMBOS);
      expect(range.totalWeight).toBeGreaterThanOrEqual(MIN_SURVIVING_WEIGHT * 0.999);
    }
  });

  it('caps how much a single street can remove', () => {
    const before = charts.rfi('BTN').removeCards(board);
    const { range, step } = applyAction(charts.rfi('BTN'), 'checkRaise', board);
    expect(range.totalWeight).toBeGreaterThanOrEqual(
      before.totalWeight * MAX_NARROWING_PER_STREET * 0.999,
    );
    expect(step.weightBefore).toBeCloseTo(before.totalWeight, 6);
  });

  it('reports when the floor intervened', () => {
    // A six-combo range is already under MIN_SURVIVING_COMBOS, so the floor
    // must fire and must say so.
    const applied = applyAction(Range.parse(['AA']), 'checkRaise', board);
    expect(applied.step.floorApplied).toBe(true);
    expect(applied.range.isEmpty).toBe(false);
  });

  it('converges rather than collapsing under repeated aggression', () => {
    // Successive raises should keep tightening but level off, never vanish.
    let range = charts.rfi('UTG');
    const weights: number[] = [];
    for (let i = 0; i < 5; i++) {
      range = applyAction(range, 'checkRaise', board).range;
      weights.push(range.totalWeight);
    }
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeLessThan(weights[i - 1]!);
    }
    expect(weights[weights.length - 1]!).toBeGreaterThan(MIN_SURVIVING_WEIGHT);
  });

  it('survives a tiny starting range', () => {
    const tiny = Range.parse(['AA', 'KK']);
    const { range } = applyAction(tiny, 'check', board);
    expect(range.isEmpty).toBe(false);
  });
});

describe('card removal', () => {
  it('drops combos containing a board card', () => {
    const board = C('As Kd 7h');
    const { range } = applyAction(Range.parse(['AA', 'KK', 'QQ']), 'check', board);
    for (const index of range.nonZeroIndices) {
      for (const card of [comboHigh(index), comboLow(index)]) {
        expect(board).not.toContain(card);
      }
    }
  });

  it('reports combo counts before and after', () => {
    const board = C('As Kd 7h');
    const { step } = applyAction(charts.rfi('BTN'), 'bet', board);
    expect(step.combosBefore).toBeGreaterThan(0);
    expect(step.combosAfter).toBeGreaterThan(0);
    expect(step.label).toBe(NARROWING_RULES.bet.label);
  });
});

describe('multi-street narrowing', () => {
  it('applies each action against the board visible at the time', () => {
    const flop = C('Kd 8h 3h');
    const turn = C('Kd 8h 3h 2c');
    const result = narrowRange(charts.rfi('CO'), [
      { action: 'bet', board: flop },
      { action: 'bet', board: turn },
    ]);
    expect(result.steps).toHaveLength(2);
    expect(result.range.isEmpty).toBe(false);
    // The turn card must be removed from the surviving range.
    for (const index of result.range.nonZeroIndices) {
      expect([comboHigh(index), comboLow(index)]).not.toContain(turn[3]);
    }
  });

  it('is deterministic', () => {
    const flop = C('Kd 8h 3h');
    const run = () => narrowRange(charts.rfi('CO'), [
      { action: 'checkCall', board: flop },
    ]).range.totalWeight;
    expect(run()).toBe(run());
  });

  it('leaves weights inside [0, 1]', () => {
    const flop = C('Kd 8h 3h');
    const { range } = narrowRange(charts.rfi('BTN'), [{ action: 'raise', board: flop }]);
    for (let i = 0; i < range.weights.length; i++) {
      expect(range.weights[i]!).toBeGreaterThanOrEqual(0);
      expect(range.weights[i]!).toBeLessThanOrEqual(1);
    }
  });
});

describe('fold frequency', () => {
  const board = C('Kd 8h 3h');
  const range = charts.rfi('CO').removeCards(board);

  it('never decreases as the bet grows, and rises across the full range', () => {
    // Fold frequency is a STEP function of bet size: sizings inside one
    // threshold band fold out identical hands, and two bands coincide when the
    // class between them is empty on this board. Monotonic, not strict.
    const sizes = [10, 20, 34, 50, 66, 80, 110, 150, 300];
    const values = sizes.map((bet) => foldFrequency(range, board, bet, 100));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!, `bet ${sizes[i]} vs ${sizes[i - 1]}`)
        .toBeGreaterThanOrEqual(values[i - 1]!);
    }
    expect(values[values.length - 1]!).toBeGreaterThan(values[0]! + 0.2);
  });

  it('stays a fraction', () => {
    for (const bet of [10, 33, 66, 100, 200, 400]) {
      const f = foldFrequency(range, board, bet, 100);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('splits the range into two parts that add back up', () => {
    const split = splitByFoldDecision(range, board, 66, 100);
    expect(split.folding.totalWeight + split.continuing.totalWeight)
      .toBeCloseTo(range.totalWeight, 6);
    expect(split.foldFrequency)
      .toBeCloseTo(split.folding.totalWeight / range.totalWeight, 9);
  });

  it('keeps strong draws in the continuing range at any price', () => {
    const drawOnly = Range.parse(['QhJh', 'ThJh']);
    const split = splitByFoldDecision(drawOnly, board, 500, 100);
    expect(split.continuing.comboCount).toBeGreaterThan(0);
  });

  it('folds out air against a large bet', () => {
    const air = Range.parse(['7c2d', '9c4d']);
    expect(foldFrequency(air, board, 150, 100)).toBe(1);
  });

  it('never folds a monster', () => {
    const nuts = Range.parse(['KcKh']);
    expect(foldFrequency(nuts, board, 500, 100)).toBe(0);
  });
});
