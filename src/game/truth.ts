/**
 * truth.ts — computing and freezing ground truth for one decision point.
 *
 * The whole file exists to satisfy one rule from the spec: the engine computes
 * and stores ground truth for a hand BEFORE rendering it, and grading compares
 * stored truth against hero's input. Nothing about the input may influence the
 * computation.
 *
 * Two mechanisms enforce that:
 *   - `HandTruth` is deeply readonly, so writing to it is a compile error;
 *   - `freezeTruth` deep-freezes it, so writing to it at runtime is a no-op in
 *     sloppy mode and a TypeError in strict mode (which modules are).
 *
 * `buildTruth` takes no player input of any kind. It cannot: there is no
 * parameter to pass one through.
 */

import { cardFromCode, type CardCode, type Rng } from '../engine/deck';
import { HAND_CATEGORIES, categoryOfStrength, evaluator } from '../engine/evaluator';
import { computeEquity, DEFAULT_ITERATIONS } from '../engine/equity';
import { countOuts, exactHitProbability, ruleOfFourAndTwo } from '../engine/outs';
import { potOdds } from '../engine/potOdds';
import { priceAction, solveAction } from '../engine/actionSolver';
import { classifyCombo, splitByFoldDecision } from '../engine/rangeNarrowing';
import type { Range } from '../engine/ranges';
import type { HandTruth, Seat, Street } from './types';

/** Recursively freezes an object graph. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export interface TruthInputs {
  readonly seed: string;
  readonly street: Street;
  readonly heroCards: readonly CardCode[];
  readonly board: readonly CardCode[];
  readonly pot: number;
  readonly toCall: number;
  readonly seats: readonly Seat[];
  readonly heroSeatIndex: number;
  /** One narrowed range per live opponent, aligned with `opponentSeats`. */
  readonly opponentRanges: readonly Range[];
  readonly opponentSeats: readonly Seat[];
  readonly rng: Rng;
  readonly iterations?: number;
}

/**
 * Computes everything the trainer will grade against, then freezes it.
 *
 * Deliberately takes no player input. Adding one would be visible in this
 * signature, which is the point.
 */
export function buildTruth(inputs: TruthInputs): HandTruth {
  const {
    seed, street, heroCards, board, pot, toCall, seats, heroSeatIndex,
    opponentRanges, opponentSeats, rng, iterations = DEFAULT_ITERATIONS,
  } = inputs;

  if (heroCards.length !== 2) {
    throw new Error(`Hero must hold exactly 2 cards, received ${heroCards.length}`);
  }
  if (opponentRanges.length === 0) {
    throw new Error('A decision point needs at least one live opponent');
  }

  /* --- equity ----------------------------------------------------------- */
  const equityResult = computeEquity({
    hole: heroCards, board, opponents: opponentRanges, rng, iterations,
  });

  /* --- equity against only the hands that continue ---------------------- */
  // Split each opponent at exactly the price the solver will use, so the two
  // cannot drift apart.
  const pricing = priceAction(pot, toCall);
  const continuing = opponentRanges.map((range) => splitByFoldDecision(
    range, board, pricing.villainMustCall, pricing.potVillainFaces,
  ).continuing);
  const everyoneCanContinue = continuing.every((range) => !range.isEmpty);
  const vsContinuingPercent = everyoneCanContinue
    ? computeEquity({
        hole: heroCards, board, opponents: continuing, rng, iterations,
      }).equity
    : equityResult.equity;

  /* --- hit probability -------------------------------------------------- */
  const hitProbability = (board.length === 3 || board.length === 4)
    ? (() => {
        const outs = countOuts(heroCards, board);
        const cardsToCome = board.length === 3 ? 2 : 1;
        return {
          outs: outs.total,
          exact: exactHitProbability(outs.total, cardsToCome, outs.unseen),
          ruleOfThumb: ruleOfFourAndTwo(outs.total, cardsToCome),
          cardsToCome,
        };
      })()
    : null;

  /* --- pot odds --------------------------------------------------------- */
  const odds = potOdds(toCall, pot);

  /* --- action ----------------------------------------------------------- */
  const solution = solveAction({
    equity: equityResult.equityFraction,
    equityVsContinuing: vsContinuingPercent / 100,
    pot,
    toCall,
    opponentRange: opponentRanges[0] as Range,
    board,
  });

  /* --- hero's hand ------------------------------------------------------ */
  const heroStrength = board.length >= 3
    ? evaluator.strengthOfCodes([...heroCards, ...board])
    : null;
  const heroCategory = heroStrength === null
    ? 'High Card'
    : (HAND_CATEGORIES[categoryOfStrength(heroStrength)] ?? 'High Card');
  const heroClass = board.length >= 3
    ? classifyCombo(heroCards[0] as CardCode, heroCards[1] as CardCode, board).madeClass
    : 'nothing';

  const truth: HandTruth = {
    seed,
    street,
    heroCards: heroCards.map(cardFromCode),
    heroCardCodes: [...heroCards],
    board: board.map(cardFromCode),
    boardCodes: [...board],
    heroCategory,
    heroClass,
    pot,
    toCall,
    seats,
    heroSeatIndex,
    hitProbability,
    equity: {
      percent: equityResult.equity,
      standardError: equityResult.standardError,
      iterations: equityResult.iterations,
      breakdown: equityResult.breakdown,
      vsContinuingPercent,
    },
    potOdds: {
      percent: odds.potOddsPercent,
      callAmount: toCall,
      potBeforeCall: pot,
    },
    action: {
      best: solution.best,
      accepted: solution.accepted,
      ranked: solution.ranked,
      firedRules: solution.firedRules,
      betSize: solution.betSize,
      foldEquity: solution.foldEquity,
    },
    opponents: opponentRanges.map((range, index) => {
      const seat = opponentSeats[index] as Seat;
      return {
        seatIndex: seat.seatIndex,
        display: seat.display,
        label: range.label,
        comboCount: range.comboCount,
        percentOfHands: range.percentOfHands,
        handKeyWeights: [...range.handKeyWeights().entries()]
          .map(([key, value]) => [key, value.weight / value.combos] as const),
      };
    }),
  };

  return deepFreeze(truth);
}
