/**
 * types.ts — the shapes the game layer passes around.
 *
 * The central rule of this layer: GROUND TRUTH IS COMPUTED AND FROZEN BEFORE
 * THE HAND IS RENDERED, and grading is a pure function of (truth, input).
 * Nothing the player types can reach the computation. `HandTruth` is deeply
 * readonly and deeply frozen at runtime, so an accidental write is a TypeScript
 * error at compile time and a no-op (or a throw in strict mode) at runtime.
 */

import type { Card, CardCode } from '../engine/deck';
import type { HandCategory } from '../engine/evaluator';
import type { EquityBreakdown } from '../engine/equity';
import type { ActionKind, ActionEV } from '../engine/actionSolver';
import type { ChartPosition } from '../engine/ranges';
import type { MadeClass } from '../engine/rangeNarrowing';

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/** Every player starts with this. Fixed by the spec; money is not the point. */
export const STARTING_STACK = 1000;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;

export interface Settings {
  /** Seconds allowed per hand, or null when the timer is off. */
  readonly timePerHandSeconds: number | null;
  /** 1 to 10. 1 is hero alone, for pure equity drilling. */
  readonly playerCount: number;
  /** Seat index hero always occupies, or null to randomise each hand. */
  readonly fixedSeatIndex: number | null;
  /**
   * Ask hero to count the outs, rather than showing the number.
   *
   * On by default: counting outs is the mechanical skill that actually gets
   * used at a table, and showing the count reduces the drill to arithmetic.
   * Turn it off to drop back to three inputs per hand when five is too slow
   * under a time trial.
   */
  readonly countOutsYourself: boolean;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  timePerHandSeconds: null,
  playerCount: 6,
  fixedSeatIndex: null,
  countOutsYourself: true,
});

/** Time-trial choices: 5:00 down to 0:15 in 15-second steps. */
export function timeTrialChoices(): number[] {
  const out: number[] = [];
  for (let seconds = 300; seconds >= 15; seconds -= 15) out.push(seconds);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Table state                                                                 */
/* -------------------------------------------------------------------------- */

export type Street = 'preflop' | 'flop' | 'turn';

/** What a seat did, in the order it happened, for display. */
export interface SeatAction {
  readonly street: Street;
  /** Free text as shown: "checked", "bet 45", "raised to 120", "called", "folded". */
  readonly description: string;
}

export interface Seat {
  readonly seatIndex: number;
  /** Label shown on screen, e.g. "UTG+1". */
  readonly display: string;
  /** Which 6-max chart this seat uses. */
  readonly chart: ChartPosition;
  readonly isHero: boolean;
  readonly hasFolded: boolean;
  readonly actions: readonly SeatAction[];
}

/* -------------------------------------------------------------------------- */
/* Ground truth                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the player is asked for, and what the engine says the answer is.
 *
 * `hitProbability` is graded against `exact` alone, within
 * `HIT_PROBABILITY_TOLERANCE`. `ruleOfThumb` carries the adjusted shortcut for
 * display, so feedback can show both figures side by side.
 */
/** One card that improves hero's hand, and what it improves it to. */
export interface OutCard {
  readonly card: Card;
  readonly to: HandCategory;
}

export interface HitProbabilityTruth {
  readonly outs: number;
  /**
   * Every out, so feedback can show the full list grouped by what it makes.
   *
   * Note the feedback cannot say WHICH outs hero missed: the input is a count,
   * so entering 11 against 14 identifies no particular cards. Showing all of
   * them grouped lets hero spot the omission themselves, which is honest;
   * naming three would be a guess.
   */
  readonly outCards: readonly OutCard[];
  /** Exact probability of hitting at least one out. */
  readonly exact: number;
  /** The adjusted rule of 4 and 2 for this out count, for display. */
  readonly ruleOfThumb: number;
  /** Cards still to come: 2 on the flop, 1 on the turn. */
  readonly cardsToCome: number;
}

/**
 * Equity is asked for as a BAND, not a number.
 *
 * A numeric equity input asks for something no human can compute at a table:
 * 64.5% against a 445-combo range is a Monte Carlo result, not an estimate. The
 * per-field timings made the case — 557 seconds on that one field in a real
 * session. What a player CAN judge, and must, is roughly where they stand.
 *
 * Outs, hit probability and pot odds stay exact, because all three are
 * calculable. The exact equity, the as-is/improved split and the range grid all
 * still appear in the feedback: the information is valuable, the input was not.
 */
export const EQUITY_BANDS = [
  { id: 'wayBehind', label: 'way behind', min: 0, max: 25 },
  { id: 'behind', label: 'behind', min: 25, max: 40 },
  { id: 'even', label: 'even', min: 40, max: 60 },
  { id: 'ahead', label: 'ahead', min: 60, max: 80 },
  { id: 'wayAhead', label: 'way ahead', min: 80, max: 100 },
] as const;

export type EquityBandId = (typeof EQUITY_BANDS)[number]['id'];

/**
 * How close to a band edge counts as "on the boundary".
 *
 * Without this, a true equity of 40.1% would fail an answer of "behind" by a
 * tenth of a point — the same knife-edge problem that sank the two-anchor
 * hit-probability scheme, moved to band edges. Within this margin of an edge,
 * either adjoining band is accepted.
 */
export const BAND_BOUNDARY_TOLERANCE = 2;

/** The band a true equity falls in. */
export function bandOf(percent: number): EquityBandId {
  for (const band of EQUITY_BANDS) {
    if (percent < band.max) return band.id;
  }
  return 'wayAhead';
}

/** Every band an answer of `percent` could legitimately be called. */
export function acceptableBands(percent: number): EquityBandId[] {
  const accepted = new Set<EquityBandId>([bandOf(percent)]);
  accepted.add(bandOf(Math.max(0, percent - BAND_BOUNDARY_TOLERANCE)));
  accepted.add(bandOf(Math.min(100, percent + BAND_BOUNDARY_TOLERANCE)));
  return [...accepted];
}

export interface BandGrade {
  readonly correct: boolean;
  readonly given: EquityBandId | null;
  /** The band the true equity actually falls in. */
  readonly truthBand: EquityBandId;
  readonly truthPercent: number;
  /** Every band accepted, which is more than one only near a boundary. */
  readonly accepted: readonly EquityBandId[];
}

/**
 * How many of hero's outs actually win, measured rather than judged.
 *
 * For each out the Monte Carlo reports `P(win | that card arrives)`. The
 * clean-out equivalent is the sum of those probabilities: four straight outs
 * winning 96% of the time they land are worth 3.85 outs; six cards that pair a
 * weak kicker and win 48% of the time are worth 2.89.
 *
 * This replaced an "I discounted soft outs" checkbox, which changed only the
 * wording of the feedback and left the judgement itself ungraded.
 */
export interface OutGroupTruth {
  readonly category: HandCategory;
  readonly count: number;
  /** Mean `P(win | it arrives)` across the group. */
  readonly winRate: number;
  /** `count x winRate` — what the group is worth in clean outs. */
  readonly cleanEquivalent: number;
}

export interface CleanOutsTruth {
  /** Sum of `P(win | it arrives)` over every out. */
  readonly total: number;
  readonly groups: readonly OutGroupTruth[];
}

export interface EquityTruth {
  /** Hero's equity percentage against the narrowed opponent range(s). */
  readonly percent: number;
  /** Standard error of the estimate, in percentage points. */
  readonly standardError: number;
  readonly iterations: number;
  /** Where the equity comes from. Null only if the board is not flop/turn. */
  readonly breakdown: EquityBreakdown | null;
  /** Equity against only the hands that continue against a bet or raise. */
  readonly vsContinuingPercent: number;
}

export interface PotOddsTruth {
  readonly percent: number;
  readonly callAmount: number;
  readonly potBeforeCall: number;
}

export interface ActionTruth {
  readonly best: ActionKind;
  readonly accepted: readonly ActionKind[];
  readonly ranked: readonly ActionEV[];
  readonly firedRules: readonly string[];
  readonly betSize: number;
  readonly foldEquity: number;
}

/** A rendered opponent range, for the 13x13 feedback grid. */
export interface OpponentView {
  readonly seatIndex: number;
  readonly display: string;
  readonly label: string;
  readonly comboCount: number;
  readonly percentOfHands: number;
  /** Weight per hand key, for the grid. */
  readonly handKeyWeights: ReadonlyArray<readonly [string, number]>;
}

/**
 * The frozen ground truth for one decision point.
 *
 * Deeply readonly, and deeply frozen by `freezeTruth`. Grading reads this and
 * nothing else.
 */
export interface HandTruth {
  readonly seed: string;
  readonly street: Street;
  readonly heroCards: readonly Card[];
  readonly heroCardCodes: readonly CardCode[];
  readonly board: readonly Card[];
  readonly boardCodes: readonly CardCode[];
  readonly heroCategory: HandCategory;
  readonly heroClass: MadeClass;
  readonly pot: number;
  readonly toCall: number;
  readonly seats: readonly Seat[];
  readonly heroSeatIndex: number;
  readonly hitProbability: HitProbabilityTruth | null;
  /** How many of those outs actually win. Present whenever outs are. */
  readonly cleanOuts: CleanOutsTruth | null;
  /**
   * Whether hero was asked to count the outs themselves. A flow flag rather
   * than a fact about the hand, kept here so `gradeHand(truth, input)` stays a
   * two-argument pure function.
   */
  readonly asksForOuts: boolean;
  readonly equity: EquityTruth;
  readonly potOdds: PotOddsTruth;
  readonly action: ActionTruth;
  readonly opponents: readonly OpponentView[];
}

/* -------------------------------------------------------------------------- */
/* Input and grading                                                           */
/* -------------------------------------------------------------------------- */

/** Per-field time spent, in milliseconds. */
export type FieldTimings = Partial<Record<InputField, number>>;

export const INPUT_FIELDS = [
  'outs', 'cleanOuts', 'hitProbability', 'equity', 'potOdds', 'action',
] as const;
export type InputField = (typeof INPUT_FIELDS)[number];

export interface HandInput {
  /** Hero's out count. Null when not asked. */
  readonly outs: number | null;
  /** How many of those hero thinks actually win. Null when not asked. */
  readonly cleanOuts: number | null;
  /** How long each field took. Recorded for the post-hand breakdown. */
  readonly timings: FieldTimings;
  /** Hero's hit-probability estimate, percent. Null when not asked. */
  readonly hitProbability: number | null;
  /** Hero's judgement of where they stand. Null in Preflop mode. */
  readonly equityBand: EquityBandId | null;
  /** Hero's pot odds answer, percent. Null in Preflop mode. */
  readonly potOdds: number | null;
  readonly action: ActionKind | null;
  /** True when the hand ran out of time. */
  readonly timedOut: boolean;
}

export const MISTAKE_CATEGORIES = [
  'EQUITY_UNDER',
  'EQUITY_OVER',
  'POT_ODDS_ARITHMETIC',
  'HIT_PROBABILITY',
  'OUTS_MISCOUNT',
  'CLEAN_OUTS',
  'ACTION_TOO_PASSIVE',
  'ACTION_TOO_AGGRESSIVE',
  'ACTION_SHOULD_FOLD',
  'TIMEOUT',
] as const;

export type MistakeCategory = (typeof MISTAKE_CATEGORIES)[number];

export interface FieldGrade {
  readonly correct: boolean;
  /** What hero answered, or null if unanswered. */
  readonly given: number | null;
  /** The engine's value. */
  readonly truth: number;
  /** Signed error, `given - truth`. Null when unanswered. */
  readonly error: number | null;
  /** The tolerance applied, in percentage points. */
  readonly tolerance: number;
}

export interface ActionGrade {
  readonly correct: boolean;
  readonly given: ActionKind | null;
  readonly best: ActionKind;
  readonly accepted: readonly ActionKind[];
}

export interface HandGrade {
  readonly passed: boolean;
  readonly outs: FieldGrade | null;
  readonly cleanOuts: FieldGrade | null;
  readonly hitProbability: FieldGrade | null;
  readonly equity: BandGrade | null;
  readonly potOdds: FieldGrade | null;
  readonly action: ActionGrade;
  /** Every category that applies, most important first. */
  readonly mistakes: readonly MistakeCategory[];
  /** Templated diagnosis lines, populated with computed values. */
  readonly diagnosis: readonly string[];
  /** The solver's rules, verbatim. */
  readonly firedRules: readonly string[];
  /** Time spent per field, echoed from the input for the post-hand breakdown. */
  readonly timings: FieldTimings;
}

/* -------------------------------------------------------------------------- */
/* Tolerances                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Retained for the calibration report, which still measures the engine against
 * the +/-5pp tolerance a numeric equity input would have used. The trainer
 * grades equity by band; see `EQUITY_BANDS`.
 */
export const EQUITY_TOLERANCE = 5;
/** Pot odds is arithmetic, not estimation, so it is graded tighter. */
export const POT_ODDS_TOLERANCE = 2;
/**
 * Outs are counted, not estimated, so the count must be exactly right. The
 * judgement about which of them are worth having is graded separately, by
 * `CLEAN_OUTS_TOLERANCE`.
 */
export const OUTS_TOLERANCE = 0;

/**
 * Clean outs are a judgement about which outs are worth counting, so unlike the
 * raw count they are not graded exactly.
 */
export const CLEAN_OUTS_TOLERANCE = 2;

/**
 * Hit probability is graded against the exact probability alone, within this
 * band.
 *
 * An earlier design accepted two anchors — the exact figure and the rule of 4
 * and 2 — each within 2pp, because the plain shortcut diverges from exact by up
 * to 5.9pp at 15 outs. That was wrong twice over. It left a HOLE: two 2pp bands
 * around anchors 4.8pp apart accept 49-53 and 54-58, so 53.5 fails while 53 and
 * 54 both pass, and a value between two accepted answers cannot be graded
 * wrong. And it was solving a problem the calibration invented by using the
 * UNADJUSTED shortcut as its baseline. With the adjustment players actually
 * apply (x4 minus the excess over 8 outs), the shortcut sits within 1.2pp of
 * exact across 1-15 outs, so a single band around the exact value covers a
 * correctly-applied shortcut with room to spare.
 */
export const HIT_PROBABILITY_TOLERANCE = 3;
