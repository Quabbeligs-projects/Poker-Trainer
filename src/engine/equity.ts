/**
 * equity.ts — Monte Carlo equity against weighted opponent ranges.
 *
 * Method
 * ------
 * For each iteration:
 *   1. Sample one concrete hand per active opponent from that opponent's
 *      narrowed, weighted range, by rejection sampling against every card
 *      already known to be gone (hero's hole cards, the visible board, and the
 *      hands sampled for earlier opponents in this same iteration).
 *   2. Deal the remaining board cards uniformly from what is left of the deck.
 *   3. Evaluate the showdown. Hero scores 1 for an outright win, `1/k` for a
 *      k-way tie, and 0 for a loss.
 *
 * The mean of that score is hero's equity, which is the standard definition:
 * the share of the pot hero wins on average at showdown.
 *
 * Accuracy over speed
 * -------------------
 * The run reports the standard error of the estimate. If it exceeds
 * `targetStandardError` (0.5 percentage points by default) the run
 * automatically continues with more iterations rather than reporting a number
 * that is too noisy to grade against a +/-5pp tolerance.
 *
 * This module has no DOM or React dependency, so it can be moved into a Web
 * Worker verbatim.
 */

import { type CardCode, DECK_SIZE, type Rng } from './deck';
import {
  HAND_CATEGORIES,
  type HandCategory,
  categoryOfStrength,
  evaluator,
} from './evaluator';
import { type Range, RangeSampler, comboHigh, comboLow } from './ranges';

/** Default iteration count. Measured at well under 100ms for heads-up. */
export const DEFAULT_ITERATIONS = 100_000;

/** Hard ceiling on auto-raised iterations, so a run can never hang the UI. */
export const MAX_ITERATIONS = 1_000_000;

/** Auto-raise iterations while the standard error exceeds this, in percentage points. */
export const DEFAULT_TARGET_STANDARD_ERROR = 0.5;

export interface EquityOptions {
  /** Hero's two hole cards. */
  readonly hole: readonly CardCode[];
  /** Visible board: 0, 3, 4 or 5 cards. */
  readonly board?: readonly CardCode[];
  /** One weighted range per active opponent. */
  readonly opponents: readonly Range[];
  /** Seeded random source. Required — the engine never uses `Math.random`. */
  readonly rng: Rng;
  /** Iterations for the first pass. Defaults to 100,000. */
  readonly iterations?: number;
  /** Target standard error in percentage points. Defaults to 0.5. */
  readonly targetStandardError?: number;
  /** Ceiling on total iterations after auto-raising. Defaults to 1,000,000. */
  readonly maxIterations?: number;
}

/**
 * Where hero's equity comes from.
 *
 * A bare "31%" teaches nothing: the player cannot tell whether that is a draw
 * that gets there, or a hand that is already ahead of the opponent's air. The
 * split lets feedback say "16 points from making the flush, 15 from ace-high
 * being good when he misses", which is the actual lesson.
 *
 * `asIs` and `improved` partition hero's equity exactly: they sum to `equity`.
 * "Improved" means hero's hand CATEGORY at showdown is higher than it was on
 * the visible board. Note the board can improve hero without hero hitting an
 * out — a fourth heart giving hero a flush hero was not drawing to counts as
 * improvement, which is correct, if not always what "I hit my draw" means.
 */
export interface EquityBreakdown {
  /** Hero's category on the visible board, before any further cards. */
  readonly currentCategory: HandCategory;
  /** Equity, in percentage points, won WITHOUT the category improving. */
  readonly asIs: number;
  /** Equity, in percentage points, won after the category improved. */
  readonly improved: number;
  /** Fraction of runouts where hero's category improved, won or not. */
  readonly improvementRate: number;
  /** Equity contributed by each finishing category, strongest first. */
  readonly byFinalCategory: ReadonlyArray<{
    readonly category: HandCategory;
    /** Percentage points of equity contributed. */
    readonly equity: number;
    /** Fraction of runouts finishing in this category. */
    readonly frequency: number;
  }>;
}

export interface EquityResult {
  /** Hero's equity as a percentage, `0..100`. */
  readonly equity: number;
  /** The same figure as a fraction, `0..1`. */
  readonly equityFraction: number;
  /** Iterations where hero held the single best hand. */
  readonly wins: number;
  /** Iterations where hero was tied for the best hand. */
  readonly ties: number;
  /** Iterations where hero was beaten. */
  readonly losses: number;
  /** Iterations actually run, after any auto-raise. */
  readonly iterations: number;
  /** Standard error of the equity estimate, in percentage points. */
  readonly standardError: number;
  /** True when the run stopped at `maxIterations` still above the SE target. */
  readonly hitIterationCeiling: boolean;
  /** Milliseconds spent in the sampling loop. */
  readonly elapsedMs: number;
  /**
   * Where the equity came from. Present only with a visible board of 3 or 4
   * cards: preflop there is no hand yet to improve on, and on the river nothing
   * can change.
   */
  readonly breakdown: EquityBreakdown | null;
}

/** Running totals, so an auto-raised run can extend rather than restart. */
interface Accumulator {
  scoreSum: number;
  scoreSquaredSum: number;
  wins: number;
  ties: number;
  losses: number;
  iterations: number;
  /** Hero's category on the visible board, or -1 when not tracked. */
  currentCategoryIndex: number;
  /** Equity won without the category improving. */
  asIsScore: number;
  /** Equity won after improving. */
  improvedScore: number;
  /** Runouts where the category improved. */
  improvedCount: number;
  /** Equity and frequency per finishing category. */
  categoryScore: Float64Array;
  categoryCount: Float64Array;
}

function standardErrorOf(acc: Accumulator): number {
  if (acc.iterations < 2) return Infinity;
  const mean = acc.scoreSum / acc.iterations;
  const meanSquare = acc.scoreSquaredSum / acc.iterations;
  // Population variance of the per-iteration score, floored at 0 to absorb
  // floating-point noise when every iteration scored identically.
  const variance = Math.max(0, meanSquare - mean * mean);
  return Math.sqrt(variance / acc.iterations) * 100;
}

/**
 * Computes hero's equity.
 *
 * Opponent ranges must already be narrowed; this function does no range
 * reasoning of its own. Cards known to be gone are removed from each range
 * before sampling, so a range whose every combo is blocked fails loudly instead
 * of silently biasing the result.
 */
export function computeEquity(options: EquityOptions): EquityResult {
  const {
    hole,
    board = [],
    opponents,
    rng,
    iterations = DEFAULT_ITERATIONS,
    targetStandardError = DEFAULT_TARGET_STANDARD_ERROR,
    maxIterations = MAX_ITERATIONS,
  } = options;

  if (hole.length !== 2) {
    throw new Error(`Hero must hold exactly 2 cards, received ${hole.length}`);
  }
  if (board.length !== 0 && board.length !== 3 && board.length !== 4 && board.length !== 5) {
    throw new Error(`Board must have 0, 3, 4 or 5 cards, received ${board.length}`);
  }
  if (opponents.length === 0) {
    throw new Error(
      'computeEquity needs at least one opponent range. For solo equity drilling, ' +
      'pass a single Range.full() opponent to measure equity against a random hand.',
    );
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`Iterations must be a positive integer, received ${iterations}`);
  }

  const known: CardCode[] = [...hole, ...board];
  const baseUsed = new Uint8Array(DECK_SIZE);
  for (const code of known) {
    if (code < 0 || code >= DECK_SIZE) throw new Error(`Invalid card code: ${code}`);
    if (baseUsed[code]) throw new Error(`Duplicate card in hero hand or board: ${code}`);
    baseUsed[code] = 1;
  }

  // Remove known cards from every opponent range up front: a combo containing a
  // board card can never be held, and leaving it in would waste rejections.
  const samplers = opponents.map((range, i) => {
    const filtered = range.removeCards(known);
    if (filtered.isEmpty) {
      throw new Error(
        `Opponent ${i + 1}'s range (${range.label || 'unlabelled'}) contains no combos ` +
        'once hero\'s cards and the board are removed.',
      );
    }
    return { sampler: new RangeSampler(filtered), range: filtered };
  });

  // Hero's category is only meaningful once there is a board to make a hand on,
  // and only interesting while cards are still to come.
  const trackBreakdown = board.length === 3 || board.length === 4;
  const currentCategoryIndex = trackBreakdown
    ? categoryOfStrength(evaluator.strengthOfCodes([...hole, ...board]))
    : -1;

  const acc: Accumulator = {
    scoreSum: 0,
    scoreSquaredSum: 0,
    wins: 0,
    ties: 0,
    losses: 0,
    iterations: 0,
    currentCategoryIndex,
    asIsScore: 0,
    improvedScore: 0,
    improvedCount: 0,
    categoryScore: new Float64Array(HAND_CATEGORIES.length),
    categoryCount: new Float64Array(HAND_CATEGORIES.length),
  };

  const started = Date.now();
  runIterations(acc, iterations, hole, board, samplers, rng);

  // Auto-raise: extend the run until the estimate is precise enough to grade
  // against a +/-5pp tolerance, or the ceiling is reached.
  let hitIterationCeiling = false;
  while (standardErrorOf(acc) > targetStandardError && acc.iterations < maxIterations) {
    const variance = Math.max(
      1e-9,
      acc.scoreSquaredSum / acc.iterations - (acc.scoreSum / acc.iterations) ** 2,
    );
    const target = targetStandardError / 100;
    const needed = Math.ceil(variance / (target * target));
    const extra = Math.min(
      Math.max(needed - acc.iterations, Math.ceil(acc.iterations * 0.5)),
      maxIterations - acc.iterations,
    );
    if (extra <= 0) break;
    runIterations(acc, extra, hole, board, samplers, rng);
    if (acc.iterations >= maxIterations) {
      hitIterationCeiling = standardErrorOf(acc) > targetStandardError;
      break;
    }
  }
  const elapsedMs = Date.now() - started;

  const equityFraction = acc.scoreSum / acc.iterations;

  let breakdown: EquityBreakdown | null = null;
  if (trackBreakdown) {
    const byFinalCategory = [];
    for (let i = HAND_CATEGORIES.length - 1; i >= 0; i--) {
      const count = acc.categoryCount[i] as number;
      if (count === 0) continue;
      byFinalCategory.push({
        category: HAND_CATEGORIES[i] as HandCategory,
        equity: ((acc.categoryScore[i] as number) / acc.iterations) * 100,
        frequency: count / acc.iterations,
      });
    }
    breakdown = {
      currentCategory: HAND_CATEGORIES[currentCategoryIndex] as HandCategory,
      asIs: (acc.asIsScore / acc.iterations) * 100,
      improved: (acc.improvedScore / acc.iterations) * 100,
      improvementRate: acc.improvedCount / acc.iterations,
      byFinalCategory,
    };
  }

  return {
    equity: equityFraction * 100,
    equityFraction,
    wins: acc.wins,
    ties: acc.ties,
    losses: acc.losses,
    iterations: acc.iterations,
    standardError: standardErrorOf(acc),
    hitIterationCeiling,
    elapsedMs,
    breakdown,
  };
}

interface OpponentSampler {
  readonly sampler: RangeSampler;
  readonly range: Range;
}

/**
 * The hot loop. Deliberately allocation-free: every buffer is created once
 * before the loop and reused, and the evaluator is called with seven positional
 * arguments rather than an array.
 */
function runIterations(
  acc: Accumulator,
  count: number,
  hole: readonly CardCode[],
  board: readonly CardCode[],
  opponents: readonly OpponentSampler[],
  rng: Rng,
): void {
  const opponentCount = opponents.length;
  const heroA = hole[0] as number;
  const heroB = hole[1] as number;

  const baseUsed = new Uint8Array(DECK_SIZE);
  baseUsed[heroA] = 1;
  baseUsed[heroB] = 1;
  for (const code of board) baseUsed[code] = 1;

  const used = new Uint8Array(DECK_SIZE);
  const fullBoard = new Int32Array(5);
  for (let i = 0; i < board.length; i++) fullBoard[i] = board[i] as number;
  const boardToDeal = 5 - board.length;
  const oppCards = new Int32Array(opponentCount * 2);

  // Cap on blind rejection attempts before falling back to an exact weighted
  // scan over the combos that are still available.
  const MAX_REJECTIONS = 64;

  for (let iter = 0; iter < count; iter++) {
    used.set(baseUsed);

    // --- 1. Sample one hand per opponent from their range ------------------
    for (let o = 0; o < opponentCount; o++) {
      const { sampler, range } = opponents[o] as OpponentSampler;
      let a = -1;
      let b = -1;
      for (let attempt = 0; attempt < MAX_REJECTIONS; attempt++) {
        const combo = sampler.sample(rng.next());
        const hi = comboHigh(combo);
        const lo = comboLow(combo);
        if (used[hi] === 0 && used[lo] === 0) {
          a = hi;
          b = lo;
          break;
        }
      }
      if (a < 0) {
        // Exact weighted draw conditioned on availability. Rare, but it keeps
        // the distribution correct instead of degrading under heavy blocking.
        const combo = sampleAvailableCombo(range, used, rng.next());
        if (combo < 0) {
          throw new Error(
            `Opponent ${o + 1}'s range has no available combos left this iteration; ` +
            'too many players are sharing too narrow a range.',
          );
        }
        a = comboHigh(combo);
        b = comboLow(combo);
      }
      used[a] = 1;
      used[b] = 1;
      oppCards[o * 2] = a;
      oppCards[o * 2 + 1] = b;
    }

    // --- 2. Deal the remaining board ---------------------------------------
    for (let i = 0; i < boardToDeal; i++) {
      let card = 0;
      do {
        card = (rng.next() * DECK_SIZE) | 0;
      } while (used[card] === 1);
      used[card] = 1;
      fullBoard[board.length + i] = card;
    }

    const b0 = fullBoard[0] as number;
    const b1 = fullBoard[1] as number;
    const b2 = fullBoard[2] as number;
    const b3 = fullBoard[3] as number;
    const b4 = fullBoard[4] as number;

    // --- 3. Showdown --------------------------------------------------------
    const heroStrength = evaluator.strengthOf7(heroA, heroB, b0, b1, b2, b3, b4);
    let bestOpponent = -1;
    let tiedWithHero = 0;
    for (let o = 0; o < opponentCount; o++) {
      const strength = evaluator.strengthOf7(
        oppCards[o * 2] as number,
        oppCards[o * 2 + 1] as number,
        b0, b1, b2, b3, b4,
      );
      if (strength > bestOpponent) bestOpponent = strength;
      if (strength === heroStrength) tiedWithHero++;
    }

    let score: number;
    if (heroStrength > bestOpponent) {
      score = 1;
      acc.wins++;
    } else if (heroStrength === bestOpponent) {
      // Hero splits with everyone holding the same strength.
      score = 1 / (tiedWithHero + 1);
      acc.ties++;
    } else {
      score = 0;
      acc.losses++;
    }
    acc.scoreSum += score;
    acc.scoreSquaredSum += score * score;

    // Attribute the equity. `categoryOfStrength` is a handful of integer
    // comparisons, so this costs almost nothing per iteration.
    if (acc.currentCategoryIndex >= 0) {
      const finalCategory = categoryOfStrength(heroStrength);
      acc.categoryScore[finalCategory] = (acc.categoryScore[finalCategory] as number) + score;
      acc.categoryCount[finalCategory] = (acc.categoryCount[finalCategory] as number) + 1;
      if (finalCategory > acc.currentCategoryIndex) {
        acc.improvedScore += score;
        acc.improvedCount += 1;
      } else {
        acc.asIsScore += score;
      }
    }

    // Release the dealt board cards for the next iteration.
    for (let i = 0; i < boardToDeal; i++) used[fullBoard[board.length + i] as number] = 0;
  }

  acc.iterations += count;
}

/**
 * Weighted draw from the combos of `range` whose cards are both still
 * available. Returns -1 when nothing is available.
 */
function sampleAvailableCombo(range: Range, used: Uint8Array, u: number): number {
  const indices = range.nonZeroIndices;
  let total = 0;
  for (let i = 0; i < indices.length; i++) {
    const combo = indices[i] as number;
    if (used[comboHigh(combo)] === 0 && used[comboLow(combo)] === 0) {
      total += range.weightOf(combo);
    }
  }
  if (total <= 0) return -1;
  let target = u * total;
  for (let i = 0; i < indices.length; i++) {
    const combo = indices[i] as number;
    if (used[comboHigh(combo)] === 1 || used[comboLow(combo)] === 1) continue;
    target -= range.weightOf(combo);
    if (target <= 0) return combo;
  }
  // Floating-point shortfall: return the last available combo.
  for (let i = indices.length - 1; i >= 0; i--) {
    const combo = indices[i] as number;
    if (used[comboHigh(combo)] === 0 && used[comboLow(combo)] === 0) return combo;
  }
  return -1;
}

/**
 * Exhaustive equity for a fixed pair of hole cards on a complete or near
 * complete board. Used by the tests as an exact cross-check on the Monte Carlo
 * estimate, and cheap enough to use directly on the river.
 */
export function exactEquityVsHand(
  hole: readonly CardCode[],
  villain: readonly CardCode[],
  board: readonly CardCode[],
): number {
  if (hole.length !== 2 || villain.length !== 2) {
    throw new Error('Both players must hold exactly 2 cards');
  }
  const used = new Uint8Array(DECK_SIZE);
  for (const code of [...hole, ...villain, ...board]) {
    if (used[code]) throw new Error(`Duplicate card: ${code}`);
    used[code] = 1;
  }
  const remaining: number[] = [];
  for (let c = 0; c < DECK_SIZE; c++) if (used[c] === 0) remaining.push(c);

  const toDeal = 5 - board.length;
  const full = [...board, 0, 0, 0, 0, 0].slice(0, 5);
  const heroA = hole[0] as number;
  const heroB = hole[1] as number;
  const villainA = villain[0] as number;
  const villainB = villain[1] as number;
  let total = 0;
  let score = 0;

  const recurse = (start: number, filled: number): void => {
    if (filled === toDeal) {
      const f0 = full[0] as number;
      const f1 = full[1] as number;
      const f2 = full[2] as number;
      const f3 = full[3] as number;
      const f4 = full[4] as number;
      const heroStrength = evaluator.strengthOf7(heroA, heroB, f0, f1, f2, f3, f4);
      const villainStrength = evaluator.strengthOf7(villainA, villainB, f0, f1, f2, f3, f4);
      total++;
      if (heroStrength > villainStrength) score += 1;
      else if (heroStrength === villainStrength) score += 0.5;
      return;
    }
    for (let i = start; i <= remaining.length - (toDeal - filled); i++) {
      full[board.length + filled] = remaining[i] as number;
      recurse(i + 1, filled + 1);
    }
  };

  recurse(0, 0);
  return (score / total) * 100;
}
