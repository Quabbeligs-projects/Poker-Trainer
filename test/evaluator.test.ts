/**
 * Differential testing of the evaluator wrapper.
 *
 * The app's evaluator (`phe`) is checked against two independent, unrelated
 * implementations — `pokersolver` (pure JS, category/kicker logic) and
 * `poker-evaluator` (the Two Plus Two 130MB lookup table). Agreement between
 * three independently written evaluators over hundreds of thousands of random
 * hands is a far stronger guarantee than trusting any one of them.
 */
import { describe, expect, it } from 'vitest';
import { Hand } from 'pokersolver';
import pokerEvaluator from 'poker-evaluator';

import {
  HAND_CATEGORIES,
  MAX_STRENGTH,
  MIN_STRENGTH,
  compareHands,
  evaluateText,
  evaluator,
} from '../src/engine/evaluator';
import {
  DECK_SIZE,
  cardToString,
  codeToString,
  codesFromStrings,
  createRng,
  shuffledDeckCodes,
} from '../src/engine/deck';

function randomSevenCardHands(count: number, seed: string): string[][] {
  const rng = createRng(seed);
  const hands: string[][] = [];
  for (let i = 0; i < count; i++) {
    hands.push(shuffledDeckCodes(rng).slice(0, 7).map(codeToString));
  }
  return hands;
}

describe('known hands', () => {
  const cases: Array<[string, string]> = [
    ['As Ks Qs Js Ts', 'Straight Flush'],
    ['9h 8h 7h 6h 5h', 'Straight Flush'],
    ['5c 4c 3c 2c Ac', 'Straight Flush'],
    ['7s 7h 7d 7c 2s', 'Four of a Kind'],
    ['Ks Kh Kd 4c 4s', 'Full House'],
    ['Ah Jh 8h 5h 2h', 'Flush'],
    ['9s 8h 7d 6c 5s', 'Straight'],
    ['Ah 2s 3d 4c 5h', 'Straight'],
    ['Qs Qh Qd 7c 2s', 'Three of a Kind'],
    ['Js Jh 4d 4c 9s', 'Two Pair'],
    ['Ts Th 8d 5c 2s', 'One Pair'],
    ['Ah Kd 9s 6c 3h', 'High Card'],
  ];

  it.each(cases)('classifies %s as %s', (hand, category) => {
    expect(evaluateText(hand).category).toBe(category);
  });

  it('orders the categories correctly', () => {
    const strengths = cases.map(([hand]) => evaluateText(hand).strength);
    // Category order in `cases` is strongest-first, so strengths must descend
    // whenever the category changes.
    for (let i = 1; i < cases.length; i++) {
      const previousCategory = HAND_CATEGORIES.indexOf(evaluateText(cases[i - 1]![0]).category);
      const currentCategory = HAND_CATEGORIES.indexOf(evaluateText(cases[i]![0]).category);
      if (previousCategory !== currentCategory) {
        expect(strengths[i - 1]!).toBeGreaterThan(strengths[i]!);
      }
    }
  });

  it('places a royal flush at the maximum and 7-5-4-3-2 at the minimum', () => {
    expect(evaluateText('As Ks Qs Js Ts').strength).toBe(MAX_STRENGTH);
    expect(evaluateText('7s 5h 4d 3c 2s').strength).toBe(MIN_STRENGTH);
  });

  it('recognises the wheel as the lowest straight', () => {
    const wheel = evaluateText('5h 4d 3c 2s Ah');
    const sixHigh = evaluateText('6h 5d 4c 3s 2h');
    expect(wheel.category).toBe('Straight');
    expect(sixHigh.strength).toBeGreaterThan(wheel.strength);
  });

  it('ranks kickers within a category', () => {
    const aceKicker = evaluateText('Ks Kh 9d 5c Ah');
    const queenKicker = evaluateText('Ks Kh 9d 5c Qh');
    expect(compareHands(aceKicker, queenKicker)).toBeGreaterThan(0);
  });
});

describe('best five cards', () => {
  it('picks the five cards that actually make the hand', () => {
    // Seven cards containing a flush plus two irrelevant cards.
        const evaluation = evaluator.evaluate(codesFromStrings(
      ['Ah', 'Kh', 'Qh', '7h', '2h', '9s', '9d'],
    ));
    expect(evaluation.category).toBe('Flush');
    const used = evaluation.cardsUsed.map(cardToString).sort();
    expect(used).toEqual(['2h', '7h', 'Ah', 'Kh', 'Qh']);
  });

  it('prefers a full house over a lower flush when both are available', () => {
    const evaluation = evaluator.evaluate(codesFromStrings(
      ['9h', '9d', '9s', '4h', '4d', '2h', '7h'],
    ));
    expect(evaluation.category).toBe('Full House');
    expect(evaluation.cardsUsed).toHaveLength(5);
  });

  it('always returns five cards whose strength equals the full-hand strength', () => {
    for (const hand of randomSevenCardHands(2000, 'best-five')) {
      const codes = codesFromStrings(hand);
      const evaluation = evaluator.evaluate(codes);
      const fiveStrength = evaluator.strengthOfCodes(
        evaluation.cardsUsed.map((c) => codesFromStrings([cardToString(c)])[0]!),
      );
      expect(fiveStrength).toBe(evaluation.strength);
    }
  });
});

describe('differential: phe vs pokersolver', () => {
  it('agrees on the winner of 50,000 random seven-card matchups', () => {
    const hands = randomSevenCardHands(100_000, 'diff-pokersolver');
    let disagreements = 0;
    let examples: string[] = [];
    for (let i = 0; i + 1 < hands.length; i += 2) {
      const a = hands[i]!;
      const b = hands[i + 1]!;
      const ours = Math.sign(
        evaluator.strengthOfCodes(codesFromStrings(a))
        - evaluator.strengthOfCodes(codesFromStrings(b)),
      );
      const solvedA = Hand.solve(a);
      const solvedB = Hand.solve(b);
      const winners = Hand.winners([solvedA, solvedB]);
      const theirs = winners.length === 2 ? 0 : winners[0] === solvedA ? 1 : -1;
      if (ours !== theirs) {
        disagreements++;
        if (examples.length < 3) examples.push(`${a.join(' ')} vs ${b.join(' ')}`);
      }
    }
    expect(examples).toEqual([]);
    expect(disagreements).toBe(0);
  });

  it('agrees on hand category names', () => {
    const nameMap: Record<string, string> = {
      'Straight Flush': 'Straight Flush',
      'Four of a Kind': 'Four of a Kind',
      'Full House': 'Full House',
      Flush: 'Flush',
      Straight: 'Straight',
      'Three of a Kind': 'Three of a Kind',
      'Two Pair': 'Two Pair',
      Pair: 'One Pair',
      'High Card': 'High Card',
      'Royal Flush': 'Straight Flush',
    };
    let disagreements = 0;
    for (const hand of randomSevenCardHands(20_000, 'diff-category')) {
      const ours = evaluator.evaluate(codesFromStrings(hand)).category;
      const theirs = nameMap[Hand.solve(hand).name];
      if (ours !== theirs) disagreements++;
    }
    expect(disagreements).toBe(0);
  });
});

describe('differential: phe vs poker-evaluator (Two Plus Two tables)', () => {
  it('agrees on the winner of 50,000 random seven-card matchups', () => {
    const hands = randomSevenCardHands(100_000, 'diff-pe');
    let disagreements = 0;
    const examples: string[] = [];
    for (let i = 0; i + 1 < hands.length; i += 2) {
      const a = hands[i]!;
      const b = hands[i + 1]!;
      const ours = Math.sign(
        evaluator.strengthOfCodes(codesFromStrings(a))
        - evaluator.strengthOfCodes(codesFromStrings(b)),
      );
      const theirs = Math.sign(
        pokerEvaluator.evalHand(a).value - pokerEvaluator.evalHand(b).value,
      );
      if (ours !== theirs) {
        disagreements++;
        if (examples.length < 3) examples.push(`${a.join(' ')} vs ${b.join(' ')}`);
      }
    }
    expect(examples).toEqual([]);
    expect(disagreements).toBe(0);
  });
});

describe('input handling', () => {
  it('accepts codes, strings and card objects interchangeably', () => {
    const asStrings = evaluator.evaluate(['Ah', 'Kh', 'Qh', 'Jh', 'Th']);
    const asCodes = evaluator.evaluate(codesFromStrings(['Ah', 'Kh', 'Qh', 'Jh', 'Th']));
    const asObjects = evaluator.evaluate([
      { rank: 'A', suit: 'h' }, { rank: 'K', suit: 'h' }, { rank: 'Q', suit: 'h' },
      { rank: 'J', suit: 'h' }, { rank: 'T', suit: 'h' },
    ]);
    expect(asStrings.strength).toBe(asCodes.strength);
    expect(asObjects.strength).toBe(asCodes.strength);
  });

  it('rejects duplicate cards and wrong card counts', () => {
    expect(() => evaluator.evaluate(['Ah', 'Ah', 'Qh', 'Jh', 'Th'])).toThrow(/[Dd]uplicate/);
    expect(() => evaluator.evaluate(['Ah', 'Kh', 'Qh', 'Jh'])).toThrow();
    expect(() => evaluator.evaluate([])).toThrow();
  });

  it('evaluates six-card hands', () => {
    const six = evaluator.evaluate(['Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c']);
    expect(six.category).toBe('Straight Flush');
    expect(six.strength).toBe(MAX_STRENGTH);
  });

  it('produces strengths inside the documented range for every hand', () => {
    let outOfRange = 0;
    for (const hand of randomSevenCardHands(20_000, 'range-check')) {
      const strength = evaluator.strengthOfCodes(codesFromStrings(hand));
      if (strength < MIN_STRENGTH || strength > MAX_STRENGTH) outOfRange++;
    }
    expect(outOfRange).toBe(0);
  });
});

describe('performance ceiling', () => {
  it('evaluates 200,000 seven-card hands without an algorithmic regression', () => {
    // A generous ceiling rather than a throughput assertion: `npm run bench`
    // prints the real rate, and CI does not gate on it.
    const rng = createRng('perf');
    const hands: number[][] = [];
    for (let i = 0; i < 200_000; i++) hands.push(shuffledDeckCodes(rng).slice(0, 7));
    const started = Date.now();
    let accumulator = 0;
    for (const h of hands) {
      accumulator += evaluator.strengthOf7(h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!);
    }
    expect(accumulator).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('deck coverage', () => {
  it('can evaluate a hand containing every card in the deck', () => {
    let failures = 0;
    for (let code = 0; code < DECK_SIZE; code++) {
      const others = [];
      for (let c = 0; c < DECK_SIZE && others.length < 6; c++) if (c !== code) others.push(c);
      try {
        evaluator.evaluate([code, ...others]);
      } catch {
        failures++;
      }
    }
    expect(failures).toBe(0);
  });
});
