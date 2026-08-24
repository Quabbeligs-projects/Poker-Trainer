import { describe, expect, it } from 'vitest';

import rangesJson from '../src/data/ranges.json';
import { RangeCharts, Range, type RangeChartsJson } from '../src/engine/ranges';
import { codesFromStrings } from '../src/engine/deck';
import {
  BET_FRACTION,
  EV_TOLERANCE_FRACTION,
  solveAction,
} from '../src/engine/actionSolver';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const C = (text: string) => codesFromStrings(text.split(/\s+/).filter(Boolean));
const board = C('Kd 8h 3h');
const villain = charts.rfi('CO').removeCards(board);

const base = {
  pot: 150,
  toCall: 50,
  opponentRange: villain,
  board,
};

describe('EV arithmetic is exactly what the header documents', () => {
  it('prices a call as equity x (pot + call) - call', () => {
    const solution = solveAction({ ...base, equity: 0.4 });
    const call = solution.ranked.find((r) => r.action === 'call')!;
    expect(call.ev).toBeCloseTo(0.4 * (150 + 50) - 50, 9);
  });

  it('makes fold exactly zero', () => {
    const solution = solveAction({ ...base, equity: 0.4 });
    expect(solution.ranked.find((r) => r.action === 'fold')!.ev).toBe(0);
  });

  it('prices a check as equity x pot when nothing is bet', () => {
    const solution = solveAction({ ...base, toCall: 0, equity: 0.4 });
    expect(solution.ranked.find((r) => r.action === 'check')!.ev)
      .toBeCloseTo(0.4 * 150, 9);
  });

  it('sizes bets and raises at two thirds of the pot', () => {
    const betting = solveAction({ ...base, toCall: 0, equity: 0.5 });
    expect(betting.betSize).toBeCloseTo(BET_FRACTION * 150, 9);

    const raising = solveAction({ ...base, equity: 0.5 });
    expect(raising.betSize).toBeCloseTo(50 + BET_FRACTION * 200, 9);
  });

  it('prices a bet as fold equity plus equity when called', () => {
    const solution = solveAction({
      ...base, toCall: 0, equity: 0.6, equityVsContinuing: 0.5,
    });
    const bet = solution.ranked.find((r) => r.action === 'bet')!;
    const b = BET_FRACTION * 150;
    const f = solution.foldEquity;
    expect(bet.ev).toBeCloseTo(f * 150 + (1 - f) * (0.5 * (150 + 2 * b) - b), 9);
  });

  it('uses equity against the continuing range, not the whole range', () => {
    // The hands that fold are the ones hero already beats, so total equity
    // would overvalue betting.
    const optimistic = solveAction({ ...base, toCall: 0, equity: 0.6 });
    const honest = solveAction({
      ...base, toCall: 0, equity: 0.6, equityVsContinuing: 0.35,
    });
    const evOf = (s: typeof optimistic) => s.ranked.find((r) => r.action === 'bet')!.ev;
    expect(evOf(honest)).toBeLessThan(evOf(optimistic));
    // And it says so when the caller does not supply the honest number.
    expect(optimistic.firedRules.join(' ')).toMatch(/slightly optimistic/);
  });
});

describe('the verdict follows the pot odds', () => {
  it('reports calling as profitable when equity clears the price', () => {
    // 50 into 150 is 25% pot odds. Note "profitable" is not the same as "best":
    // with real fold equity available, raising can still outrank a profitable
    // call, and the accepted set is decided by EV alone.
    const solution = solveAction({ ...base, equity: 0.45 });
    expect(solution.potOddsPercent).toBeCloseTo(25, 6);
    expect(solution.ranked.find((r) => r.action === 'call')!.ev).toBeGreaterThan(0);
    expect(solution.firedRules.join(' ')).toMatch(/exceeds pot odds/);
  });

  it('makes calling the best action when the opponent will not fold', () => {
    // A range that continues with everything leaves a raise no fold equity, so
    // a profitable call becomes the correct action.
    const sticky = Range.parse(['AA', 'KK', '88', '33', 'K8s', 'KQo', 'KJo', 'QQ', 'JJ'])
      .removeCards(board);
    const solution = solveAction({
      ...base, equity: 0.45, equityVsContinuing: 0.42, opponentRange: sticky,
    });
    expect(solution.foldEquity).toBeLessThan(0.2);
    expect(solution.accepted).toContain('call');
    expect(solution.best).toBe('call');
  });

  it('folds when equity is far below the price and there is no fold equity', () => {
    const nutted = Range.parse(['KK', 'AA', '88', '33', 'K8s', 'K3s']).removeCards(board);
    const solution = solveAction({
      ...base, equity: 0.05, equityVsContinuing: 0.03, opponentRange: nutted,
    });
    expect(solution.best).toBe('fold');
    expect(solution.accepted).toEqual(['fold']);
    expect(solution.firedRules.join(' ')).toMatch(/no meaningful fold equity/);
  });

  it('quotes the exact numbers in its rules, per the spec', () => {
    const solution = solveAction({ ...base, equity: 0.41 });
    const joined = solution.firedRules.join(' | ');
    expect(joined).toMatch(/41%/);
    expect(joined).toMatch(/25%/);
  });

  it('never marks calling correct when it is clearly losing chips', () => {
    const solution = solveAction({ ...base, equity: 0.05, equityVsContinuing: 0.05 });
    const call = solution.ranked.find((r) => r.action === 'call')!;
    expect(call.ev).toBeLessThan(0);
    expect(call.correct).toBe(false);
  });

  it('raises when equity is high and the opponent folds often', () => {
    const weak = Range.parse(['72o', '93o', 'J4o', 'Q6o']).removeCards(board);
    const solution = solveAction({
      ...base, equity: 0.8, equityVsContinuing: 0.7, opponentRange: weak,
    });
    expect(solution.best).toBe('raise');
    expect(solution.foldEquity).toBeGreaterThan(0.5);
  });
});

describe('the accepted set', () => {
  it('always contains at least one action', () => {
    for (const equity of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 1]) {
      const solution = solveAction({ ...base, equity });
      expect(solution.accepted.length).toBeGreaterThanOrEqual(1);
      expect(solution.accepted).toContain(solution.best);
    }
  });

  it('accepts every action within 5% of the best', () => {
    const solution = solveAction({ ...base, equity: 0.5 });
    const bestEV = solution.ranked[0]!.ev;
    for (const candidate of solution.ranked) {
      if (candidate.correct) {
        expect(bestEV - candidate.ev).toBeLessThanOrEqual(
          Math.max(Math.abs(bestEV) * EV_TOLERANCE_FRACTION, base.pot * 0.01) + 1e-9,
        );
      }
    }
  });

  it('can accept two actions at once when they are genuinely close', () => {
    // Sweep equity and confirm the tolerance band produces ties somewhere.
    let sawMultiple = false;
    for (let equity = 0.05; equity <= 0.95; equity += 0.01) {
      const solution = solveAction({ ...base, equity });
      if (solution.accepted.length > 1) sawMultiple = true;
    }
    expect(sawMultiple).toBe(true);
  });

  it('explains itself when more than one action is correct', () => {
    for (let equity = 0.05; equity <= 0.95; equity += 0.01) {
      const solution = solveAction({ ...base, equity });
      if (solution.accepted.length > 1) {
        expect(solution.firedRules.join(' ')).toMatch(/count as correct/);
        return;
      }
    }
  });

  it('ranks strictly by EV', () => {
    const solution = solveAction({ ...base, equity: 0.45 });
    for (let i = 1; i < solution.ranked.length; i++) {
      expect(solution.ranked[i - 1]!.ev).toBeGreaterThanOrEqual(solution.ranked[i]!.ev);
    }
    expect(solution.best).toBe(solution.ranked[0]!.action);
  });
});

describe('legal actions', () => {
  it('offers fold, call and raise when facing a bet', () => {
    const actions = solveAction({ ...base, equity: 0.4 }).ranked.map((r) => r.action).sort();
    expect(actions).toEqual(['call', 'fold', 'raise']);
  });

  it('offers fold, check and bet when there is no bet to face', () => {
    const actions = solveAction({ ...base, toCall: 0, equity: 0.4 })
      .ranked.map((r) => r.action).sort();
    expect(actions).toEqual(['bet', 'check', 'fold']);
  });

  it('never prefers folding to a free check', () => {
    for (const equity of [0, 0.01, 0.5, 1]) {
      const solution = solveAction({ ...base, toCall: 0, equity });
      expect(solution.best).not.toBe('fold');
    }
  });
});

describe('monotonicity: more equity is never worse', () => {
  it('call EV rises with equity', () => {
    let previous = -Infinity;
    for (let equity = 0; equity <= 1.0001; equity += 0.05) {
      const ev = solveAction({ ...base, equity: Math.min(equity, 1) })
        .ranked.find((r) => r.action === 'call')!.ev;
      expect(ev).toBeGreaterThan(previous);
      previous = ev;
    }
  });

  it('the best action shifts from fold to call to raise as equity grows', () => {
    const bestAt = (equity: number) =>
      solveAction({ ...base, equity, equityVsContinuing: equity }).best;
    expect(bestAt(0.05)).toBe('fold');
    expect(bestAt(0.95)).toBe('raise');
  });

  it('is deterministic', () => {
    const run = () => JSON.stringify(solveAction({ ...base, equity: 0.42 }).ranked);
    expect(run()).toBe(run());
  });
});

describe('input validation', () => {
  it('rejects impossible equities and pots', () => {
    expect(() => solveAction({ ...base, equity: 1.5 })).toThrow();
    expect(() => solveAction({ ...base, equity: -0.1 })).toThrow();
    expect(() => solveAction({ ...base, equity: 0.4, pot: 0 })).toThrow();
    expect(() => solveAction({ ...base, equity: 0.4, toCall: -1 })).toThrow();
  });

  it('produces an explanation for every action', () => {
    for (const candidate of solveAction({ ...base, equity: 0.4 }).ranked) {
      expect(candidate.explanation.length).toBeGreaterThan(10);
    }
  });

  it('produces at least one fired rule in every spot', () => {
    for (const toCall of [0, 25, 50, 150]) {
      for (const equity of [0.1, 0.5, 0.9]) {
        const solution = solveAction({ ...base, toCall, equity });
        expect(solution.firedRules.length).toBeGreaterThan(0);
      }
    }
  });
});
