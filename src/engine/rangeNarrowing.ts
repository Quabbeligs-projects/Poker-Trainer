/**
 * rangeNarrowing.ts — narrowing an opponent's range from their actions.
 *
 * ============================================================================
 * HOW TO READ AND CHANGE THIS FILE
 * ============================================================================
 * Every number that shapes a range lives in `NARROWING_RULES` below, as a named
 * multiplier with a comment. Nothing is hidden elsewhere: if you disagree with
 * how a check-call narrows a range, change the numbers in `checkCall` and the
 * whole engine follows, including the equity the trainer grades you against.
 *
 * A multiplier is applied to a combo's weight:
 *
 *     1.0   unchanged
 *     0.2   this action makes the hand five times less likely, but possible
 *     0.0   impossible — avoided, see the floor rule below
 *
 * Each rule is tagged:
 *
 *     [DERIVED]   follows from the rules of the game or from arithmetic the
 *                 engine already does. Changing it makes the engine wrong.
 *     [JUDGEMENT] a modelling opinion about how a typical opponent plays.
 *                 Reasonable people differ. These are yours to tune.
 *
 * Most of this file is [JUDGEMENT]. That is unavoidable: there is no
 * deterministic truth about what a check means. What the engine guarantees is
 * that whatever you set here is applied consistently, transparently, and
 * identically to the range you are shown and the range equity is computed
 * against.
 *
 * ============================================================================
 * THE FLOOR
 * ============================================================================
 * A range is never narrowed to nothing. After every street, if the surviving
 * range falls below `MIN_SURVIVING_COMBOS` or its total weight below
 * `MIN_SURVIVING_WEIGHT`, the narrowing is blended back toward the pre-action
 * range until it clears the floor. An empty range would make equity undefined
 * and the trainer would either crash or, far worse, quietly grade against
 * nonsense.
 *
 * ============================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ============================================================================
 * No opponent modelling that learns, no board-texture-dependent bet sizing
 * reads, no blockers-in-the-opponent's-own-range reasoning. Those are out of
 * scope for v1 and would add judgement without adding checkable truth.
 */

import { type CardCode } from './deck';
import { potOdds } from './potOdds';
import { evaluator } from './evaluator';
import {
  COMBO_COUNT,
  Range,
  comboHigh,
  comboLow,
} from './ranges';

/* ========================================================================== */
/* Hand classification                                                        */
/* ========================================================================== */

/**
 * How strong a holding is on the current board, in the only terms the narrowing
 * rules need. Classification is [DERIVED]: it comes from the evaluator and from
 * counting outs, not from opinion.
 */
export const MADE_CLASSES = [
  'nothing',      // no pair, no meaningful draw
  'weakDraw',     // gutshot or two overcards: roughly 4-6 outs
  'strongDraw',   // flush draw or open-ended straight draw: 8-9 outs
  'weakPair',     // any pair below top pair
  'topPair',      // top pair, any kicker
  'overpair',     // pocket pair above the board
  'strong',       // two pair or a set
  'monster',      // straight or better
] as const;

export type MadeClass = (typeof MADE_CLASSES)[number];

export interface ComboClassification {
  readonly madeClass: MadeClass;
  /** Cards that improve this hand to a likely winner. [DERIVED] */
  readonly outs: number;
  /** True when the hand can improve to a flush or straight. [DERIVED] */
  readonly hasDraw: boolean;
}

/**
 * Classifies a two-card combo against a board.
 *
 * [DERIVED] throughout — every branch is a fact about the cards. The only
 * choice embedded here is where the class boundaries sit, which is documented
 * per branch.
 */
export function classifyCombo(
  a: CardCode,
  b: CardCode,
  board: readonly CardCode[],
): ComboClassification {
  const evaluation = evaluator.evaluate([a, b, ...board]);
  const category = evaluation.categoryIndex;

  // Straight (4) or better is a monster on any board.
  if (category >= 4) {
    return { madeClass: 'monster', outs: 0, hasDraw: false };
  }
  // Two pair (2) or trips (3) is 'strong'.
  if (category >= 2) {
    return { madeClass: 'strong', outs: 0, hasDraw: false };
  }

  const draw = countDraws(a, b, board);

  if (category === 1) {
    // One pair. Distinguish by what it is paired with.
    const boardRanks = board.map((c) => c >> 2);
    const topBoardRank = Math.max(...boardRanks);
    const aRank = a >> 2;
    const bRank = b >> 2;
    const isPocketPair = aRank === bRank;

    if (isPocketPair && aRank > topBoardRank) {
      return { madeClass: 'overpair', outs: draw.outs, hasDraw: draw.hasDraw };
    }
    const pairedWithTop =
      (!isPocketPair && (aRank === topBoardRank || bRank === topBoardRank));
    if (pairedWithTop) {
      return { madeClass: 'topPair', outs: draw.outs, hasDraw: draw.hasDraw };
    }
    return { madeClass: 'weakPair', outs: draw.outs, hasDraw: draw.hasDraw };
  }

  // No pair. A draw is what is left.
  if (draw.outs >= 8) {
    return { madeClass: 'strongDraw', outs: draw.outs, hasDraw: draw.hasDraw };
  }
  if (draw.outs >= 4) {
    return { madeClass: 'weakDraw', outs: draw.outs, hasDraw: draw.hasDraw };
  }
  return { madeClass: 'nothing', outs: draw.outs, hasDraw: draw.hasDraw };
}

/**
 * Counts flush and straight outs, plus overcard outs.
 *
 * [DERIVED] — this counts cards, it does not estimate. Overcards are counted at
 * 3 outs each because pairing an overcard usually, but not always, wins; the
 * discount is applied by the caller's class boundaries rather than here.
 */
function countDraws(
  a: CardCode,
  b: CardCode,
  board: readonly CardCode[],
): { outs: number; hasDraw: boolean } {
  const cards = [a, b, ...board];

  // --- flush draw -----------------------------------------------------------
  const suitCounts = [0, 0, 0, 0];
  for (const card of cards) suitCounts[card & 3] = (suitCounts[card & 3] as number) + 1;
  const holeSuits = new Set([a & 3, b & 3]);
  let flushOuts = 0;
  for (const suit of holeSuits) {
    // Four to a flush, using at least one hole card, needs 9 more of that suit.
    if ((suitCounts[suit] as number) === 4) flushOuts = 9;
  }

  // --- straight draw --------------------------------------------------------
  const rankPresent = new Set(cards.map((c) => c >> 2));
  let straightOuts = 0;
  // Try every card that could complete a straight and see whether it does.
  for (let rank = 0; rank < 13; rank++) {
    if (rankPresent.has(rank)) continue;
    if (makesStraight(rankPresent, rank)) {
      // 4 cards of that rank exist, minus any already visible.
      const seen = cards.filter((c) => (c >> 2) === rank).length;
      straightOuts += 4 - seen;
    }
  }

  // --- overcards ------------------------------------------------------------
  const boardTop = Math.max(...board.map((c) => c >> 2));
  let overcardOuts = 0;
  if ((a >> 2) > boardTop) overcardOuts += 3;
  if ((b >> 2) > boardTop) overcardOuts += 3;

  const hasDraw = flushOuts > 0 || straightOuts > 0;
  // Flush and straight outs can overlap; subtracting a card for the overlap is
  // more precise than adding them blindly.
  const drawOuts = flushOuts + straightOuts > 0
    ? Math.max(flushOuts, straightOuts) + Math.min(flushOuts, straightOuts) * 0.75
    : 0;

  return { outs: Math.round(drawOuts + (hasDraw ? 0 : overcardOuts)), hasDraw };
}

/** True when adding `rank` to the present ranks completes a five-card run. */
function makesStraight(present: ReadonlySet<number>, rank: number): boolean {
  const withRank = new Set(present);
  withRank.add(rank);
  // Ace plays low: rank 12 also counts as -1 for the wheel.
  const has = (r: number) => withRank.has(r === -1 ? 12 : r);
  for (let start = -1; start <= 8; start++) {
    let run = 0;
    for (let i = 0; i < 5; i++) if (has(start + i)) run++;
    if (run === 5) return true;
  }
  return false;
}

/* ========================================================================== */
/* THE RULES — everything tunable lives here                                  */
/* ========================================================================== */

/** A multiplier per made-hand class. Missing entries default to 1.0. */
export type ClassWeights = Partial<Record<MadeClass, number>>;

export interface NarrowingRule {
  /** Shown verbatim in feedback, so write it the way you want to read it. */
  readonly label: string;
  readonly weights: ClassWeights;
}

/**
 * The postflop actions the engine models.
 *
 * `donk` (leading into the previous street's aggressor) is deliberately absent:
 * modelling it well needs opponent-specific reads, and treating it as a plain
 * bet is less wrong than inventing a rule for it.
 */
export const POSTFLOP_ACTIONS = ['check', 'checkCall', 'checkRaise', 'bet', 'raise', 'call'] as const;
export type PostflopAction = (typeof POSTFLOP_ACTIONS)[number];

/**
 * ============================ TUNE ME =====================================
 *
 * Read each block as: "when the opponent does X, how much more or less likely
 * is each kind of hand?"
 */
export const NARROWING_RULES: Readonly<Record<PostflopAction, NarrowingRule>> = Object.freeze({
  /**
   * CHECK (and the action passes on).
   *
   * [JUDGEMENT] Checking weights away from strong made hands, because most
   * opponents bet those — but not to zero, because slowplaying a monster is
   * real and pretending it never happens makes hero overfold later. 0.35 on
   * 'strong' and 'monster' means a set is roughly a third as likely as it was,
   * not impossible: that is the trap frequency this engine assumes.
   */
  check: {
    label: 'checked — weighted away from strong made hands, some traps kept',
    weights: {
      monster: 0.35,
      strong: 0.35,
      overpair: 0.45,
      topPair: 0.65,
      weakPair: 1.15,
      strongDraw: 0.9,
      weakDraw: 1.1,
      nothing: 1.25,
    },
  },

  /**
   * CHECK then CALL a bet.
   *
   * [JUDGEMENT] The classic marginal-made-hand-or-draw action. Weighted toward
   * hands good enough to continue but not good enough to raise. Monsters are
   * heavily discounted because a check-call with the nuts is rarer than a
   * check-raise, but again not zeroed.
   */
  checkCall: {
    label: 'checked then called — marginal made hands and draws',
    weights: {
      monster: 0.25,
      strong: 0.5,
      overpair: 0.9,
      topPair: 1.3,
      weakPair: 1.4,
      strongDraw: 1.5,
      weakDraw: 1.0,
      nothing: 0.25,
    },
  },

  /**
   * CHECK then RAISE.
   *
   * [JUDGEMENT] The most polarised action in the game: very strong hands and
   * semi-bluffs, very little in between. Note 'nothing' at 0.35 rather than 0 —
   * pure bluff check-raises exist, and zeroing them would let hero call far too
   * wide against this line.
   */
  checkRaise: {
    label: 'check-raised — polarised to strong hands and semi-bluffs',
    weights: {
      monster: 3.0,
      strong: 2.6,
      overpair: 1.4,
      topPair: 0.7,
      weakPair: 0.25,
      strongDraw: 1.6,
      weakDraw: 0.5,
      nothing: 0.35,
    },
  },

  /**
   * BET.
   *
   * [JUDGEMENT] Value hands and semi-bluffs go up, hands that prefer to see a
   * cheap showdown go down. Deliberately gentler than check-raise: betting is a
   * far wider action, so the multipliers stay close to 1.
   */
  bet: {
    label: 'bet — value hands and semi-bluffs, fewer showdown-bound hands',
    weights: {
      monster: 1.6,
      strong: 1.6,
      overpair: 1.5,
      topPair: 1.4,
      weakPair: 0.7,
      strongDraw: 1.4,
      weakDraw: 0.9,
      nothing: 0.8,
    },
  },

  /**
   * RAISE a bet.
   *
   * [JUDGEMENT] Same shape as check-raise but slightly less polarised, since
   * raising in position is a wider action than check-raising out of position.
   */
  raise: {
    label: 'raised — strong made hands and semi-bluffs',
    weights: {
      monster: 2.8,
      strong: 2.4,
      overpair: 1.5,
      topPair: 0.8,
      weakPair: 0.3,
      strongDraw: 1.5,
      weakDraw: 0.5,
      nothing: 0.4,
    },
  },

  /**
   * CALL a bet, having not checked first (i.e. facing a bet in position).
   *
   * [JUDGEMENT] Similar to check-call but retains slightly more strong hands,
   * since flat-calling in position with a big hand is a common line.
   */
  call: {
    label: 'called — hands good enough to continue, few of the very best',
    weights: {
      monster: 0.35,
      strong: 0.6,
      overpair: 1.0,
      topPair: 1.3,
      weakPair: 1.3,
      strongDraw: 1.45,
      weakDraw: 1.0,
      nothing: 0.3,
    },
  },
});

/* -------------------------------------------------------------------------- */
/* Floor                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A narrowed range must keep at least this many combos.
 * [JUDGEMENT] 12 is enough that sampling stays meaningful and card removal
 * cannot block the whole range.
 */
export const MIN_SURVIVING_COMBOS = 12;

/**
 * A narrowed range must keep at least this much total weight.
 * [JUDGEMENT] Roughly 0.6% of all hands.
 */
export const MIN_SURVIVING_WEIGHT = 8;

/**
 * How far a range may be narrowed in one street, as a fraction of its
 * pre-action total weight.
 *
 * [JUDGEMENT] Without this, three streets of aggressive multipliers can
 * compound into an absurdly narrow range. 0.25 means a single action can never
 * remove more than three quarters of an opponent's range.
 */
export const MAX_NARROWING_PER_STREET = 0.25;

/* ========================================================================== */
/* Applying the rules                                                         */
/* ========================================================================== */

export interface NarrowingStep {
  /** Which action was applied. */
  readonly action: PostflopAction;
  /** The rule's human-readable label, for feedback. */
  readonly label: string;
  /** Combos before and after, for the feedback panel. */
  readonly combosBefore: number;
  readonly combosAfter: number;
  readonly weightBefore: number;
  readonly weightAfter: number;
  /** True when the floor or the per-street cap had to intervene. */
  readonly floorApplied: boolean;
}

export interface NarrowingResult {
  readonly range: Range;
  readonly steps: readonly NarrowingStep[];
}

/**
 * Applies one action to a range on a given board.
 *
 * Card removal is applied first: a combo containing a board card cannot be
 * held. [DERIVED]
 */
export function applyAction(
  range: Range,
  action: PostflopAction,
  board: readonly CardCode[],
): { range: Range; step: NarrowingStep } {
  const rule = NARROWING_RULES[action];
  const available = range.removeCards(board);

  const weightBefore = available.totalWeight;
  const combosBefore = available.comboCount;

  // Classification is cached per combo for this board, since several actions on
  // the same street re-use it.
  const classified = classifyRange(available, board);

  let narrowed = available.map((weight, index) => {
    const madeClass = classified[index] as MadeClass | undefined;
    if (madeClass === undefined) return weight;
    const multiplier = rule.weights[madeClass] ?? 1;
    return weight * multiplier;
  }, available.label);

  // Multipliers above 1 can push weights past the [0,1] cap, which silently
  // flattens the shape of the range. Rescale so the heaviest combo sits at 1
  // and relative frequencies are preserved. [DERIVED]
  narrowed = narrowed.normalised(available.label);

  let floorApplied = false;

  // Per-street cap: blend back toward the pre-action range if this single
  // action removed too much.
  const minWeightThisStreet = weightBefore * MAX_NARROWING_PER_STREET;
  if (narrowed.totalWeight < minWeightThisStreet && narrowed.totalWeight > 0) {
    narrowed = blendToward(narrowed, available, minWeightThisStreet);
    floorApplied = true;
  }

  // Absolute floor.
  if (narrowed.comboCount < MIN_SURVIVING_COMBOS
      || narrowed.totalWeight < MIN_SURVIVING_WEIGHT) {
    narrowed = blendToward(
      narrowed,
      available,
      Math.max(MIN_SURVIVING_WEIGHT, minWeightThisStreet),
    );
    floorApplied = true;
  }

  return {
    range: narrowed,
    step: {
      action,
      label: rule.label,
      combosBefore,
      combosAfter: narrowed.comboCount,
      weightBefore,
      weightAfter: narrowed.totalWeight,
      floorApplied,
    },
  };
}

/**
 * Blends a narrowed range back toward its pre-action form until it carries at
 * least `targetWeight`. Preserves the narrowing's shape rather than simply
 * reverting, so the opponent's read is softened rather than discarded.
 */
function blendToward(narrowed: Range, original: Range, targetWeight: number): Range {
  if (original.totalWeight <= 0) return original;
  if (narrowed.totalWeight >= targetWeight) return narrowed;

  // Solve for the blend factor t in (1-t)*narrowed + t*original that reaches
  // the target weight. [DERIVED]
  const deficit = targetWeight - narrowed.totalWeight;
  const headroom = original.totalWeight - narrowed.totalWeight;
  const t = headroom <= 0 ? 1 : Math.min(1, deficit / headroom);

  const blended = new Float64Array(COMBO_COUNT);
  for (let i = 0; i < COMBO_COUNT; i++) {
    const value = (1 - t) * narrowed.weightOf(i) + t * original.weightOf(i);
    blended[i] = value > 1 ? 1 : value;
  }
  return Range.fromWeights(blended, narrowed.label);
}

/** Classifies every live combo in a range against a board. */
export function classifyRange(
  range: Range,
  board: readonly CardCode[],
): ReadonlyArray<MadeClass | undefined> {
  const out = new Array<MadeClass | undefined>(COMBO_COUNT);
  for (const index of range.nonZeroIndices) {
    out[index] = classifyCombo(comboHigh(index), comboLow(index), board).madeClass;
  }
  return out;
}

/**
 * Applies a sequence of actions across streets.
 *
 * `board` must be the board visible at the time of each action, so a flop
 * action is evaluated against the flop and a turn action against the turn.
 */
export function narrowRange(
  startingRange: Range,
  actions: ReadonlyArray<{ action: PostflopAction; board: readonly CardCode[] }>,
): NarrowingResult {
  let range = startingRange;
  const steps: NarrowingStep[] = [];
  for (const { action, board } of actions) {
    const applied = applyAction(range, action, board);
    range = applied.range;
    steps.push(applied.step);
  }
  return { range, steps };
}

/**
 * Splits a range into the part that folds to a bet and the part that continues.
 *
 * [JUDGEMENT] in its thresholds, [DERIVED] in its arithmetic: a hand continues
 * when its class sits at or above the continue threshold for the price offered.
 * The threshold moves with the price — against a small bet an opponent
 * continues with weak pairs and draws; against an overbet they need a real hand.
 *
 * The action solver uses the CONTINUING range, not the whole range, when it
 * works out what a bet is worth when called. Using the whole range there would
 * systematically overvalue betting, because the hands that fold are exactly the
 * ones hero beats.
 */
export interface FoldSplit {
  /** The part of the range that folds. */
  readonly folding: Range;
  /** The part that calls or raises. */
  readonly continuing: Range;
  /** Weight fraction of the range that folds, `0..1`. */
  readonly foldFrequency: number;
}

export function splitByFoldDecision(
  range: Range,
  board: readonly CardCode[],
  amountToCall: number,
  potBeforeTheirCall: number,
): FoldSplit {
  // The opponent's decision depends on the POT ODDS they are being laid, not on
  // the raw size of hero's wager. This matters most for raises: a raise to 183
  // when the opponent has already bet 50 asks them to call only 133 into 333 —
  // a cheap price — even though 183 looks like an overbet next to the pot.
  // Pricing that as an overbet made every raise look enormously profitable.
  const priceRatio = potOdds(amountToCall, potBeforeTheirCall).potOddsPercent / 100;

  /**
   * [JUDGEMENT] Continue thresholds, keyed on the pot odds the opponent is laid.
   * The boundaries are stated as the familiar bet sizes they correspond to:
   *
   *     <= 0.25   a third-pot bet or smaller   -> continue with a weak draw up
   *     <= 0.40   up to a two-thirds-pot bet   -> continue with a weak pair up
   *     <= 0.50   up to a pot-sized bet        -> continue with top pair up
   *      > 0.50   an overbet                   -> continue with an overpair up
   *
   * Note this makes fold frequency a STEP function of price, not a smooth one:
   * every price inside a band folds out exactly the same hands, and two adjacent
   * bands coincide entirely when the class between them is empty on this board.
   * On a King-high flop with no straight draws available, for instance, nothing
   * classifies as `weakDraw`, so a tiny bet and a two-thirds-pot bet fold out an
   * identical fraction. That is a real consequence of using readable class
   * buckets rather than a continuous strength measure — a deliberate trade,
   * since the spec fixes bet sizing at two thirds of the pot and the solver
   * therefore only ever prices one or two bands.
   */
  let continueFrom: number;
  if (priceRatio <= 0.25) continueFrom = MADE_CLASSES.indexOf('weakDraw');
  else if (priceRatio <= 0.40) continueFrom = MADE_CLASSES.indexOf('weakPair');
  else if (priceRatio <= 0.50) continueFrom = MADE_CLASSES.indexOf('topPair');
  else continueFrom = MADE_CLASSES.indexOf('overpair');

  /**
   * [JUDGEMENT] Strong draws always continue regardless of price: their equity
   * plus implied odds justifies calling any normal sizing.
   */
  const strongDrawIndex = MADE_CLASSES.indexOf('strongDraw');

  const foldingWeights = new Float64Array(COMBO_COUNT);
  const continuingWeights = new Float64Array(COMBO_COUNT);
  let foldingWeight = 0;
  let total = 0;

  for (const index of range.nonZeroIndices) {
    const weight = range.weightOf(index);
    total += weight;
    const classification = classifyCombo(comboHigh(index), comboLow(index), board);
    const classIndex = MADE_CLASSES.indexOf(classification.madeClass);
    const continues = classIndex >= continueFrom || classIndex === strongDrawIndex;
    if (continues) {
      continuingWeights[index] = weight;
    } else {
      foldingWeights[index] = weight;
      foldingWeight += weight;
    }
  }

  return {
    folding: Range.fromWeights(foldingWeights, `${range.label} (folding)`),
    continuing: Range.fromWeights(continuingWeights, `${range.label} (continuing)`),
    foldFrequency: total <= 0 ? 0 : foldingWeight / total,
  };
}

/**
 * The fraction of a range that folds when asked to call `amountToCall` into
 * `potBeforeTheirCall`.
 */
export function foldFrequency(
  range: Range,
  board: readonly CardCode[],
  amountToCall: number,
  potBeforeTheirCall: number,
): number {
  return splitByFoldDecision(range, board, amountToCall, potBeforeTheirCall).foldFrequency;
}
