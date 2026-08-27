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
import {
  HAND_CATEGORIES,
  type HandCategory,
  categoryOfStrength,
  evaluator,
} from '../engine/evaluator';
import { computeEquity, DEFAULT_ITERATIONS } from '../engine/equity';
import { adjustedRuleOfThumb, countOuts, exactHitProbability } from '../engine/outs';
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
  /** Whether hero is asked to count the outs themselves. */
  readonly asksForOuts: boolean;
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
    opponentRanges, opponentSeats, rng, asksForOuts,
    iterations = DEFAULT_ITERATIONS,
  } = inputs;

  if (heroCards.length !== 2) {
    throw new Error(`Hero must hold exactly 2 cards, received ${heroCards.length}`);
  }
  if (opponentRanges.length === 0) {
    throw new Error('A decision point needs at least one live opponent');
  }

  // Remove hero's cards and the board from every opponent range before anything
  // touches them. `computeEquity` does this internally, but the fold split and
  // the rendered range grid did not, so a caller supplying an unfiltered range
  // got a "duplicate cards" error from deep inside the evaluator. Doing it once
  // here means no downstream consumer has to remember.
  const known: CardCode[] = [...heroCards, ...board];
  const liveRanges = opponentRanges.map((range, index) => {
    const live = range.removeCards(known);
    if (live.isEmpty) {
      throw new Error(
        `Opponent ${index + 1}'s range (${range.label || 'unlabelled'}) has no combos `
        + 'left once hero\'s cards and the board are removed.',
      );
    }
    return live;
  });

  /* --- outs ------------------------------------------------------------- */
  const outsCount = (board.length === 3 || board.length === 4)
    ? countOuts(heroCards, board)
    : null;

  /* --- equity ----------------------------------------------------------- */
  // Tracking the outs costs one lookup per dealt card per iteration, so the
  // per-out win rates come out of the run that was happening anyway.
  const equityResult = computeEquity({
    hole: heroCards, board, opponents: liveRanges, rng, iterations,
    ...(outsCount === null ? {} : { trackOuts: outsCount.outs.map((out) => out.code) }),
  });

  /* --- equity against only the hands that continue ---------------------- */
  // Split each opponent at exactly the price the solver will use, so the two
  // cannot drift apart.
  const pricing = priceAction(pot, toCall);
  const continuing = liveRanges.map((range) => splitByFoldDecision(
    range, board, pricing.villainMustCall, pricing.potVillainFaces,
  ).continuing);
  const everyoneCanContinue = continuing.every((range) => !range.isEmpty);
  const vsContinuingPercent = everyoneCanContinue
    ? computeEquity({
        hole: heroCards, board, opponents: continuing, rng, iterations,
      }).equity
    : equityResult.equity;

  /* --- hit probability -------------------------------------------------- */
  const hitProbability = outsCount === null ? null : (() => {
    const cardsToCome = board.length === 3 ? 2 : 1;
    return {
      outs: outsCount.total,
      outCards: outsCount.outs.map((out) => ({ card: out.card, to: out.to })),
      exact: exactHitProbability(outsCount.total, cardsToCome, outsCount.unseen),
      ruleOfThumb: adjustedRuleOfThumb(outsCount.total, cardsToCome),
      cardsToCome,
    };
  })();

  /* --- how many of those outs actually win ------------------------------ */
  const cleanOuts = (outsCount === null || equityResult.outOutcomes === null)
    ? null
    : (() => {
        const rateByCard = new Map(
          equityResult.outOutcomes.map((outcome) => [outcome.code, outcome.winRate]),
        );
        const groups = new Map<string, { count: number; sum: number }>();
        let total = 0;
        for (const out of outsCount.outs) {
          const rate = rateByCard.get(out.code) ?? 0;
          total += rate;
          const group = groups.get(out.to);
          if (group) { group.count += 1; group.sum += rate; }
          else groups.set(out.to, { count: 1, sum: rate });
        }
        return {
          total,
          groups: [...groups.entries()]
            .map(([category, group]) => ({
              category: category as HandCategory,
              count: group.count,
              winRate: group.sum / group.count,
              cleanEquivalent: group.sum,
            }))
            .sort((a, b) => b.cleanEquivalent - a.cleanEquivalent),
        };
      })();

  /* --- pot odds --------------------------------------------------------- */
  const odds = potOdds(toCall, pot);

  /* --- action ----------------------------------------------------------- */
  const solution = solveAction({
    equity: equityResult.equityFraction,
    equityVsContinuing: vsContinuingPercent / 100,
    pot,
    toCall,
    opponentRange: liveRanges[0] as Range,
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
    cleanOuts,
    asksForOuts: asksForOuts && hitProbability !== null,
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
    opponents: liveRanges.map((range, index) => {
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
