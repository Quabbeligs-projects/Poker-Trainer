/**
 * tableScaling.ts — adjusting 6-max charts for tables of 1 to 10 players.
 *
 * ============================================================================
 * THE PROBLEM
 * ============================================================================
 * The charts in `ranges.json` are 6-max. Mapping seat NAMES onto a 9-handed
 * table is not enough: UTG 9-handed has eight players left to act behind,
 * against five for UTG 6-handed. The same chart would be far too loose.
 *
 * ============================================================================
 * THE APPROACH CHOSEN, AND WHY
 * ============================================================================
 * A single documented scaling rule, NOT separate authored chart sets.
 *
 * The key observation is that range width is driven by PLAYERS LEFT TO ACT
 * BEHIND HERO, not by table size as such. A cutoff has exactly three players
 * behind whether the table is 6-handed or 9-handed, and published 6-max and
 * full-ring cutoff ranges are indeed near-identical. The same holds for the
 * button (always two behind) and the blinds. Only the early seats differ
 * between table sizes, and they differ precisely because they have more players
 * behind. So "table size" is the wrong axis; "players behind" is the right one.
 *
 * The bundled 6-max charts already sample that curve at four points:
 *
 *     players behind:      2       3       4       5
 *     position:           BTN     CO      MP     UTG
 *     opening width:     41.8%   25.5%   18.9%   14.3%
 *
 * Beyond five players behind, width is extrapolated by a constant multiplier
 * per additional player. `WIDTH_FACTOR_PER_EXTRA_PLAYER` is set to 0.90, which
 * reproduces standard published full-ring opening ranges closely:
 *
 *     seat (9-handed)   behind   this rule   published full-ring
 *     UTG                  8       10.4%          ~10-11%
 *     UTG+1                7       11.6%           ~12%
 *     UTG+2                6       12.9%          ~13-14%
 *     MP (LJ)              5       17.0%           ~16%
 *     MP+1 (HJ)            4       18.9%           ~19%
 *     CO                   3       25.5%           ~25%
 *     BTN                  2       41.8%          ~43-45%
 *
 * Why a rule rather than separate 6-max and full-ring chart sets:
 *
 *   - There is exactly ONE hand-authored chart set to review and disagree with.
 *     Authored chart data is the part of this engine that no test can prove
 *     correct, only self-consistent, so having half as much of it is a real
 *     reduction in risk.
 *   - The rule covers all ten table sizes uniformly, including the 7-, 8- and
 *     10-handed cases that no published chart set covers well.
 *   - It applies uniformly to calling and 3-betting ranges too, which separate
 *     chart sets would have to duplicate all over again.
 *   - It is falsifiable: `test/tableScaling.test.ts` asserts the produced widths
 *     against the published full-ring figures above.
 *
 * The single exception is HEADS-UP, which is not scaled at all. At 2 players the
 * button has one player behind — fewer than the 6-max button's two — so the
 * rule would want to WIDEN the chart, and no widening of a 41.8% button range
 * produces a correct ~85% heads-up button range. Heads-up is a structurally
 * different game (button posts the small blind, is in position postflop, and
 * plays every hand against a single opponent), so it gets its own authored
 * charts under `headsUp` in `ranges.json`.
 *
 * ============================================================================
 * HOW A RANGE IS TIGHTENED
 * ============================================================================
 * Weakest hands are dropped first. "Weakest" is decided by, in order:
 *
 *   1. CHART TIER — the tightest opening chart that contains the hand.
 *      A hand UTG opens is tier 0; a hand only the button opens is tier 3.
 *      This ordering is derived from the charts themselves, so it carries the
 *      chart author's opinion about playability rather than imposing a new one.
 *      It depends on the RFI charts being nested (UTG subset of MP subset of CO
 *      subset of BTN), which `test/tableScaling.test.ts` asserts.
 *
 *   2. EQUITY AGAINST A RANDOM HAND — from `handStrength.json`, engine-derived,
 *      used ONLY to break ties inside a tier.
 *
 * Tier dominates deliberately. Equity against a random hand is a poor measure of
 * opening value on its own: it ranks K2s above 76s, whereas the charts (and
 * most players) prefer 76s. Because K2s is button-only (tier 3) and 76s is
 * opened from the cutoff (tier 2), tier ordering keeps 76s in the range longer,
 * which is the intended behaviour.
 *
 * The boundary hand is trimmed FRACTIONALLY rather than being dropped whole, so
 * a target width is hit exactly and the sampler still draws it at the right
 * frequency. This is why ranges carry per-combo weights at all.
 */

import handStrengthJson from '../data/handStrength.json';
import {
  CHART_POSITIONS,
  type ChartPosition,
  COMBO_COUNT,
  type HandKey,
  HAND_GRID,
  type ParsedResponse,
  Range,
  type RangeCharts,
  combosOfHandKey,
  handKeyOfCombo,
  seatPositions,
} from './ranges';

/**
 * Width multiplier applied per player behind hero beyond the 6-max baseline.
 *
 * TUNABLE. Lower means early seats at big tables tighten harder. 0.90 was
 * chosen because it reproduces published full-ring opening widths (see the
 * table at the top of this file); it is not derived from theory.
 */
export const WIDTH_FACTOR_PER_EXTRA_PLAYER = 0.90;

/**
 * Never tighten below this fraction of the original range, whatever the table
 * size. A guard so an implausible table size cannot collapse a range to almost
 * nothing. At 10 players the tightest factor the rule produces is 0.9^5 = 0.59,
 * so this floor is not reached in normal play.
 */
export const MIN_WIDTH_FACTOR = 0.35;

const EQUITY_VS_RANDOM: Readonly<Record<string, number>> =
  (handStrengthJson as { equityVsRandom: Record<string, number> }).equityVsRandom;

/* -------------------------------------------------------------------------- */
/* Players behind                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How many players act after hero preflop. Seat 0 is first to act, so hero at
 * seat `i` of an `n`-handed table has `n - 1 - i` players behind.
 */
export function playersBehind(seatIndex: number, playerCount: number): number {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= playerCount) {
    throw new Error(`Seat ${seatIndex} is not a seat at a ${playerCount}-handed table`);
  }
  return playerCount - 1 - seatIndex;
}

/**
 * Players behind each chart position at 6-max — the baseline the charts were
 * authored for. Derived from the seat mapping rather than hardcoded, so it can
 * never drift out of step with it.
 */
export const SIX_MAX_PLAYERS_BEHIND: Readonly<Record<ChartPosition, number>> = (() => {
  const seats = seatPositions(6);
  const out = {} as Record<ChartPosition, number>;
  for (const seat of seats) out[seat.chart] = playersBehind(seat.seatIndex, 6);
  return Object.freeze(out);
})();

/**
 * The width multiplier for a seat.
 *
 * Returns 1 when hero has no more players behind than the 6-max baseline for
 * that chart position: the rule only ever tightens, never widens.
 */
export function widthScaleFactor(chart: ChartPosition, behind: number): number {
  const baseline = SIX_MAX_PLAYERS_BEHIND[chart];
  const extra = behind - baseline;
  if (extra <= 0) return 1;
  return Math.max(MIN_WIDTH_FACTOR, WIDTH_FACTOR_PER_EXTRA_PLAYER ** extra);
}

/* -------------------------------------------------------------------------- */
/* Hand ordering                                                               */
/* -------------------------------------------------------------------------- */

/** The RFI charts, tightest first. A hand's tier is its index in this list. */
const TIER_ORDER: readonly ChartPosition[] = ['UTG', 'MP', 'CO', 'BTN'];

/** Tier of a hand that appears in none of the opening charts. */
const UNTIERED = TIER_ORDER.length;

export interface HandOrdering {
  /** Hand keys strongest first: trimming removes from the end. */
  readonly keys: readonly HandKey[];
  /** Tier per hand key; lower is stronger. */
  readonly tiers: ReadonlyMap<HandKey, number>;
}

const orderingCache = new WeakMap<RangeCharts, HandOrdering>();

/**
 * Builds the trimming order for a chart set. Cached per `RangeCharts` instance,
 * so editing `ranges.json` and reloading produces a fresh ordering.
 */
export function handOrdering(charts: RangeCharts): HandOrdering {
  const cached = orderingCache.get(charts);
  if (cached) return cached;

  const tiers = new Map<HandKey, number>();
  for (const key of HAND_GRID.flat()) {
    let tier = UNTIERED;
    for (let i = 0; i < TIER_ORDER.length; i++) {
      const range = charts.rfi(TIER_ORDER[i] as ChartPosition);
      const present = combosOfHandKey(key).some((combo) => range.weightOf(combo) > 0);
      if (present) {
        tier = i;
        break;
      }
    }
    tiers.set(key, tier);
  }

  const keys = [...tiers.keys()].sort((a, b) => {
    const tierDelta = (tiers.get(a) as number) - (tiers.get(b) as number);
    if (tierDelta !== 0) return tierDelta;
    const equityDelta = (EQUITY_VS_RANDOM[b] ?? 0) - (EQUITY_VS_RANDOM[a] ?? 0);
    if (equityDelta !== 0) return equityDelta;
    // Code-unit comparison, NOT localeCompare. This tie-break decides which
    // hands survive table-size trimming, which changes opponent ranges, which
    // changes graded truth — so it must not depend on the ICU data a
    // particular Node build happens to ship.
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const ordering: HandOrdering = { keys, tiers };
  orderingCache.set(charts, ordering);
  return ordering;
}

/* -------------------------------------------------------------------------- */
/* Trimming                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Trims a range down to `targetWeight` total combo weight, dropping the weakest
 * hands first and trimming the boundary hand fractionally to hit the target
 * exactly. Returns the range unchanged when it is already at or below target.
 */
export function trimToWeight(
  range: Range,
  targetWeight: number,
  ordering: HandOrdering,
  label = range.label,
): Range {
  if (targetWeight <= 0) return Range.empty(label);
  if (range.totalWeight <= targetWeight) return range;

  const weights = new Float64Array(COMBO_COUNT);
  let remaining = targetWeight;

  for (const key of ordering.keys) {
    if (remaining <= 0) break;
    const combos = combosOfHandKey(key);
    let keyWeight = 0;
    for (const combo of combos) keyWeight += range.weightOf(combo);
    if (keyWeight <= 0) continue;

    if (keyWeight <= remaining) {
      for (const combo of combos) weights[combo] = range.weightOf(combo);
      remaining -= keyWeight;
    } else {
      const scale = remaining / keyWeight;
      for (const combo of combos) weights[combo] = range.weightOf(combo) * scale;
      remaining = 0;
    }
  }

  return Range.fromWeights(weights, label);
}

/** Applies a width multiplier to a range, trimming the weakest hands. */
export function scaleRangeWidth(
  range: Range,
  factor: number,
  ordering: HandOrdering,
  label = range.label,
): Range {
  if (factor >= 1 || range.isEmpty) return range;
  return trimToWeight(range, range.totalWeight * factor, ordering, label);
}

/* -------------------------------------------------------------------------- */
/* Table-aware chart lookup                                                    */
/* -------------------------------------------------------------------------- */

export interface TableSeat {
  readonly seatIndex: number;
  readonly display: string;
  readonly chart: ChartPosition;
  readonly playersBehind: number;
  readonly widthFactor: number;
}

/** Seats of an N-handed table, each carrying its width multiplier. */
export function tableSeats(playerCount: number): TableSeat[] {
  return seatPositions(playerCount).map((seat) => {
    const behind = playersBehind(seat.seatIndex, playerCount);
    return {
      seatIndex: seat.seatIndex,
      display: seat.display,
      chart: seat.chart,
      playersBehind: behind,
      // Heads-up uses authored charts verbatim, so no scaling is applied.
      widthFactor: playerCount === 2 ? 1 : widthScaleFactor(seat.chart, behind),
    };
  });
}

/**
 * Hero's opening range at a seat, adjusted for table size.
 *
 * At 2 players this returns the authored heads-up button chart. Everywhere else
 * it returns the 6-max chart for the mapped position, tightened by the width
 * rule when hero has more players behind than the 6-max baseline.
 */
export function tableAdjustedRfi(
  charts: RangeCharts,
  playerCount: number,
  seatIndex: number,
): Range {
  const seat = tableSeats(playerCount)[seatIndex];
  if (seat === undefined) {
    throw new Error(`Seat ${seatIndex} is not a seat at a ${playerCount}-handed table`);
  }
  if (playerCount === 2) {
    if (seat.chart === 'BB') return Range.empty('HU BB RFI');
    const headsUp = charts.headsUpRfi();
    if (!headsUp.isEmpty) return headsUp;
  }
  const base = charts.rfi(seat.chart);
  const label = `${seat.display} RFI (${playerCount}-handed)`;
  return scaleRangeWidth(base, seat.widthFactor, handOrdering(charts), label);
}

/**
 * Hero's response to an open, adjusted for table size.
 *
 * Defending ranges tighten for the same reason opening ranges do: more players
 * still to act behind hero means more chance of running into a stronger hand
 * after committing chips. The same multiplier is applied to the calling and
 * 3-betting ranges.
 */
export function tableAdjustedResponse(
  charts: RangeCharts,
  playerCount: number,
  seatIndex: number,
  openerChart: ChartPosition,
): ParsedResponse {
  const seat = tableSeats(playerCount)[seatIndex];
  if (seat === undefined) {
    throw new Error(`Seat ${seatIndex} is not a seat at a ${playerCount}-handed table`);
  }
  if (playerCount === 2 && seat.chart === 'BB' && charts.hasHeadsUpCharts) {
    return charts.headsUpVsOpen();
  }
  const base = charts.vsOpen(
    seat.chart,
    openerChart === 'BB' ? 'late' : openerBucketOf(openerChart),
  );
  const ordering = handOrdering(charts);
  const factor = seat.widthFactor;
  return {
    call: scaleRangeWidth(base.call, factor, ordering),
    threeBet: scaleRangeWidth(base.threeBet, factor, ordering),
    fourBet: scaleRangeWidth(base.fourBet, factor, ordering),
    squeeze: scaleRangeWidth(base.squeeze, factor, ordering),
  };
}

function openerBucketOf(position: ChartPosition) {
  switch (position) {
    case 'UTG':
    case 'MP':
      return 'early' as const;
    case 'CO':
      return 'middle' as const;
    case 'SB':
      return 'sb' as const;
    default:
      return 'late' as const;
  }
}

/** Summary rows for the range viewer and for eyeballing the rule's output. */
export function describeTable(charts: RangeCharts, playerCount: number): Array<{
  seat: TableSeat;
  rfiPercent: number;
}> {
  return tableSeats(playerCount).map((seat) => ({
    seat,
    rfiPercent: tableAdjustedRfi(charts, playerCount, seat.seatIndex).percentOfHands,
  }));
}

export { CHART_POSITIONS, handKeyOfCombo };
