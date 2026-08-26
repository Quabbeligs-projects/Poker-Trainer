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
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  timePerHandSeconds: null,
  playerCount: 6,
  fixedSeatIndex: null,
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
export interface HitProbabilityTruth {
  readonly outs: number;
  /** Exact probability of hitting at least one out. */
  readonly exact: number;
  /** The adjusted rule of 4 and 2 for this out count, for display. */
  readonly ruleOfThumb: number;
  /** Cards still to come: 2 on the flop, 1 on the turn. */
  readonly cardsToCome: number;
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
  readonly equity: EquityTruth;
  readonly potOdds: PotOddsTruth;
  readonly action: ActionTruth;
  readonly opponents: readonly OpponentView[];
}

/* -------------------------------------------------------------------------- */
/* Input and grading                                                           */
/* -------------------------------------------------------------------------- */

export interface HandInput {
  /** Hero's hit-probability estimate, percent. Null when not asked. */
  readonly hitProbability: number | null;
  /** Hero's equity estimate, percent. Null in Preflop mode. */
  readonly equity: number | null;
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
  readonly hitProbability: FieldGrade | null;
  readonly equity: FieldGrade | null;
  readonly potOdds: FieldGrade | null;
  readonly action: ActionGrade;
  /** Every category that applies, most important first. */
  readonly mistakes: readonly MistakeCategory[];
  /** Templated diagnosis lines, populated with computed values. */
  readonly diagnosis: readonly string[];
  /** The solver's rules, verbatim. */
  readonly firedRules: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Tolerances                                                                  */
/* -------------------------------------------------------------------------- */

/** Equity is an estimate; +/-5pp is the spec's tolerance. */
export const EQUITY_TOLERANCE = 5;
/** Pot odds is arithmetic, not estimation, so it is graded tighter. */
export const POT_ODDS_TOLERANCE = 2;
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
