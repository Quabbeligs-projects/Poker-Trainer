import { describe, expect, it } from 'vitest';
import { breakEvenEquity, potOdds, requiredFoldEquity } from '../src/engine/potOdds';

describe('pot odds', () => {
  it('computes call / (pot + call)', () => {
    // Facing a 50 bet into a pot that is now 150 total: call 50 to win 200.
    const result = potOdds(50, 150);
    expect(result.potAfterCall).toBe(200);
    expect(result.potOddsPercent).toBeCloseTo(25, 10);
    expect(result.breakEvenEquityPercent).toBeCloseTo(25, 10);
    expect(result.oddsAgainst).toBeCloseTo(3, 10);
  });

  it('matches the standard reference numbers', () => {
    const cases: Array<[number, number, number]> = [
      // [call, potBeforeCall, expected pot odds %]
      [10, 10, 50],       // pot-sized bet into an empty pot
      [100, 100, 50],
      [50, 150, 25],      // 1/2 pot bet -> 25%
      [100, 200, 33.3333333333], // pot-sized bet -> 33.3%
      [66, 166, 28.4482758620],  // 2/3 pot bet
      [25, 175, 12.5],
      [200, 100, 66.6666666666], // facing a bet twice the pot
    ];
    for (const [call, pot, expected] of cases) {
      expect(potOdds(call, pot).potOddsPercent).toBeCloseTo(expected, 6);
    }
  });

  it('treats a free check as 0% pot odds', () => {
    expect(potOdds(0, 100).potOddsPercent).toBe(0);
    expect(potOdds(0, 0).potOddsPercent).toBe(0);
    expect(potOdds(0, 100).oddsAgainst).toBe(Infinity);
  });

  it('exposes break-even equity as a fraction', () => {
    expect(breakEvenEquity(50, 150)).toBeCloseTo(0.25, 10);
    expect(breakEvenEquity(100, 200)).toBeCloseTo(1 / 3, 10);
  });

  it('never returns pot odds outside 0..100', () => {
    for (let call = 0; call <= 1000; call += 7) {
      for (let pot = 0; pot <= 1000; pot += 13) {
        const value = potOdds(call, pot).potOddsPercent;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it('rejects negative or non-finite inputs instead of returning nonsense', () => {
    expect(() => potOdds(-1, 100)).toThrow();
    expect(() => potOdds(50, -100)).toThrow();
    expect(() => potOdds(NaN, 100)).toThrow();
    expect(() => potOdds(50, Infinity)).toThrow();
  });
});

describe('required fold equity', () => {
  it('computes bet / (pot + bet)', () => {
    // A 2/3-pot bluff must work 40% of the time.
    expect(requiredFoldEquity(66.67, 100)).toBeCloseTo(0.4, 3);
    // A pot-sized bluff must work half the time.
    expect(requiredFoldEquity(100, 100)).toBeCloseTo(0.5, 10);
    // A half-pot bluff must work a third of the time.
    expect(requiredFoldEquity(50, 100)).toBeCloseTo(1 / 3, 10);
  });

  it('rejects non-positive bets', () => {
    expect(() => requiredFoldEquity(0, 100)).toThrow();
    expect(() => requiredFoldEquity(-10, 100)).toThrow();
    expect(() => requiredFoldEquity(10, -1)).toThrow();
  });
});
