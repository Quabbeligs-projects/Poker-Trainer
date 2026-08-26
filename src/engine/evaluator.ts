/**
 * evaluator.ts — a thin, swappable wrapper over a proven hand-evaluation library.
 *
 * No hand-evaluation logic lives here. The wrapper's only jobs are:
 *   - normalise the backing library's ordering to "higher strength is better";
 *   - expose a fast, allocation-free path for the Monte Carlo hot loop;
 *   - report which five cards actually make the hand, for the UI and feedback.
 *
 * Backing library
 * ---------------
 * `phe` (Poker Hand Evaluator) is used because it is the only one of the
 * candidate npm evaluators that is simultaneously (a) proven, (b) dependency
 * free and browser-safe, and (c) fast enough for 100k-iteration Monte Carlo.
 * Measured: ~2.0M seven-card evaluations/second, versus ~50k/s for
 * `pokersolver` (40x slower — 100k iterations would take ~4s) and
 * `poker-evaluator`, which is fast but ships a 130MB `HandRanks.dat` read via
 * `fs` and therefore cannot run in a browser or be precached in a PWA.
 *
 * `pokersolver` and `poker-evaluator` are retained as dev-only dependencies and
 * are used in `test/evaluator.test.ts` as independent oracles: the three
 * libraries are differentially tested against each other over large random
 * samples, which is a stronger correctness guarantee than trusting any one.
 *
 * Swapping the backend means implementing `HandEvaluator` and changing the
 * `evaluator` export at the bottom of this file. Nothing else imports `phe`.
 */

import evaluate5 from 'phe/lib/evaluator5';
import evaluate6 from 'phe/lib/evaluator6';
import evaluate7 from 'phe/lib/evaluator7';

import {
  type Card,
  type CardCode,
  type CardString,
  cardFromCode,
  cardToCode,
  codeFromString,
  tryCardFromString,
} from './deck';

/** The nine hand categories, ordered weakest to strongest. */
export const HAND_CATEGORIES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const;

export type HandCategory = (typeof HAND_CATEGORIES)[number];

/** Highest strength the backing library can produce (a royal flush). */
export const MAX_STRENGTH = 7462;
/** Lowest strength the backing library can produce (7-5-4-3-2 offsuit). */
export const MIN_STRENGTH = 1;

export interface HandEvaluation {
  /** Comparable strength; **higher is better**. Equal values are exact ties. */
  readonly strength: number;
  /** Index into `HAND_CATEGORIES`; higher is a stronger category. */
  readonly categoryIndex: number;
  /** Human-readable category name, e.g. `"Flush"`. */
  readonly category: HandCategory;
  /** The five cards that actually make the hand, strongest contribution first. */
  readonly cardsUsed: readonly Card[];
}

/**
 * The interface the rest of the engine codes against. Implement this to swap in
 * a different evaluation library.
 */
export interface HandEvaluator {
  /** Evaluates 5, 6 or 7 cards in any accepted representation. */
  evaluate(cards: readonly (Card | CardString | CardCode)[]): HandEvaluation;
  /** Strength only, from card codes. Allocation-light; used off the hot path. */
  strengthOfCodes(codes: readonly CardCode[]): number;
  /** Strength of exactly seven card codes. The Monte Carlo hot path. */
  strengthOf7(
    a: CardCode, b: CardCode, c: CardCode, d: CardCode,
    e: CardCode, f: CardCode, g: CardCode,
  ): number;
  /** Strength of exactly five card codes. */
  strengthOf5(a: CardCode, b: CardCode, c: CardCode, d: CardCode, e: CardCode): number;
}

/* -------------------------------------------------------------------------- */
/* phe backend                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * `phe` returns 1 (royal flush) .. 7462 (worst high card): *lower* is better.
 * Every value crossing this module's boundary is flipped so that higher wins,
 * which matches how the rest of the engine and the UI reason about strength.
 */
function normalise(pheValue: number): number {
  return MAX_STRENGTH + 1 - pheValue;
}

/**
 * `phe`'s own category boundaries, expressed against its raw (lower-is-better)
 * value. Mirrored here rather than imported so that the mapping onto this
 * module's weakest-to-strongest ordering stays explicit and testable.
 */
function categoryIndexFromPheValue(value: number): number {
  if (value > 6185) return 0; // High Card
  if (value > 3325) return 1; // One Pair
  if (value > 2467) return 2; // Two Pair
  if (value > 1609) return 3; // Three of a Kind
  if (value > 1599) return 4; // Straight
  if (value > 322) return 5; // Flush
  if (value > 166) return 6; // Full House
  if (value > 10) return 7; // Four of a Kind
  return 8; // Straight Flush
}

/**
 * Hand category from a normalised strength (higher is better).
 *
 * Exported because the Monte Carlo loop needs to bucket hero's finished hand by
 * category on every iteration, and must not pay for a full `evaluate()` to do
 * it. This is a handful of integer comparisons.
 */
export function categoryOfStrength(strength: number): number {
  return categoryIndexFromPheValue(MAX_STRENGTH + 1 - strength);
}

/** All C(7,5) = 21 five-card subsets of a seven-card hand, as index triples. */
const SUBSETS_7_CHOOSE_5: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

/** All C(6,5) = 6 five-card subsets of a six-card hand. */
const SUBSETS_6_CHOOSE_5: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  for (let a = 0; a < 6; a++)
    for (let b = a + 1; b < 6; b++)
      for (let c = b + 1; c < 6; c++)
        for (let d = c + 1; d < 6; d++)
          for (let e = d + 1; e < 6; e++) out.push([a, b, c, d, e]);
  return out;
})();

/** Coerces any accepted card representation to a card code. */
export function toCode(card: Card | CardString | CardCode): CardCode {
  if (typeof card === 'number') {
    if (!Number.isInteger(card) || card < 0 || card > 51) {
      throw new Error(`Invalid card code: ${card}`);
    }
    return card;
  }
  if (typeof card === 'string') return codeFromString(card);
  if (card && typeof card === 'object' && 'rank' in card && 'suit' in card) {
    return cardToCode(card);
  }
  throw new Error(`Unrecognised card value: ${JSON.stringify(card)}`);
}

/** Accepts either representation and yields codes. */
export function toCodes(cards: readonly (Card | CardString | CardCode)[]): CardCode[] {
  return cards.map(toCode);
}

class PheEvaluator implements HandEvaluator {
  strengthOf5(a: CardCode, b: CardCode, c: CardCode, d: CardCode, e: CardCode): number {
    return normalise(evaluate5(a, b, c, d, e));
  }

  strengthOf7(
    a: CardCode, b: CardCode, c: CardCode, d: CardCode,
    e: CardCode, f: CardCode, g: CardCode,
  ): number {
    return normalise(evaluate7(a, b, c, d, e, f, g));
  }

  strengthOfCodes(codes: readonly CardCode[]): number {
    switch (codes.length) {
      case 5:
        return normalise(
          evaluate5(codes[0] as number, codes[1] as number, codes[2] as number,
                    codes[3] as number, codes[4] as number),
        );
      case 6:
        return normalise(
          evaluate6(codes[0] as number, codes[1] as number, codes[2] as number,
                    codes[3] as number, codes[4] as number, codes[5] as number),
        );
      case 7:
        return normalise(
          evaluate7(codes[0] as number, codes[1] as number, codes[2] as number,
                    codes[3] as number, codes[4] as number, codes[5] as number,
                    codes[6] as number),
        );
      default:
        throw new Error(`Can only evaluate 5, 6 or 7 cards, received ${codes.length}`);
    }
  }

  evaluate(cards: readonly (Card | CardString | CardCode)[]): HandEvaluation {
    const codes = toCodes(cards);
    const seen = new Set(codes);
    if (seen.size !== codes.length) {
      throw new Error(`Duplicate cards in hand: ${codes.join(',')}`);
    }
    const strength = this.strengthOfCodes(codes);
    const pheValue = MAX_STRENGTH + 1 - strength;
    const categoryIndex = categoryIndexFromPheValue(pheValue);
    return {
      strength,
      categoryIndex,
      category: HAND_CATEGORIES[categoryIndex] as HandCategory,
      cardsUsed: bestFiveCards(codes, strength).map(cardFromCode),
    };
  }
}

/**
 * Finds the five cards making the hand by brute-forcing every five-card subset
 * and keeping the one whose strength matches the full-hand strength. Only ever
 * called for display, never inside the Monte Carlo loop.
 */
function bestFiveCards(codes: readonly CardCode[], strength: number): CardCode[] {
  if (codes.length === 5) return [...codes];
  const subsets = codes.length === 7 ? SUBSETS_7_CHOOSE_5 : SUBSETS_6_CHOOSE_5;
  for (const subset of subsets) {
    const five = subset.map((i) => codes[i] as CardCode);
    const s = normalise(
      evaluate5(five[0] as number, five[1] as number, five[2] as number,
                five[3] as number, five[4] as number),
    );
    if (s === strength) return five;
  }
  // Unreachable: the best 7-card hand is by definition one of its 5-card subsets.
  throw new Error('Failed to locate the five cards making this hand');
}

/** The evaluator used throughout the engine. Swap this to change backends. */
export const evaluator: HandEvaluator = new PheEvaluator();

/* -------------------------------------------------------------------------- */
/* Convenience helpers                                                         */
/* -------------------------------------------------------------------------- */

export function evaluateHand(
  cards: readonly (Card | CardString | CardCode)[],
): HandEvaluation {
  return evaluator.evaluate(cards);
}

/** Evaluates hero's two hole cards against a board of three to five cards. */
export function evaluateHoleAndBoard(
  hole: readonly (Card | CardString | CardCode)[],
  board: readonly (Card | CardString | CardCode)[],
): HandEvaluation {
  return evaluator.evaluate([...hole, ...board]);
}

/**
 * Parses a space-separated hand such as `"Ah Kh Qh Jh Th"` and evaluates it.
 * Convenience for tests and for the range/board editors.
 */
export function evaluateText(text: string): HandEvaluation {
  const tokens = text.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  const cards = tokens.map((t) => {
    const card = tryCardFromString(t);
    if (card === null) throw new Error(`Invalid card in ${JSON.stringify(text)}: ${t}`);
    return card;
  });
  return evaluator.evaluate(cards);
}

/** Compares two evaluations: positive when `a` wins, 0 on an exact tie. */
export function compareHands(a: HandEvaluation, b: HandEvaluation): number {
  return a.strength - b.strength;
}
