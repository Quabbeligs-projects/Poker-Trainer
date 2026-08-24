/**
 * potOdds.ts — the arithmetic side of the drill.
 *
 * Everything here is exact; none of it is estimated. Pot odds are graded to a
 * tighter tolerance than equity precisely because there is a single right
 * answer and no sampling noise.
 */

export interface PotOddsResult {
  /** Chips hero must put in to continue. */
  readonly callAmount: number;
  /** Pot size BEFORE hero's call, i.e. including the opponent's bet. */
  readonly potBeforeCall: number;
  /** Pot size hero would be contesting after calling. */
  readonly potAfterCall: number;
  /** Pot odds as a percentage, `call / (pot + call) * 100`. */
  readonly potOddsPercent: number;
  /**
   * Equity hero needs for calling to break even, ignoring implied odds.
   * Numerically identical to `potOddsPercent`; exposed separately because the
   * two are conceptually distinct and the feedback templates name both.
   */
  readonly breakEvenEquityPercent: number;
  /** The classic "X to 1" phrasing, e.g. 3 for a pot-sized-call getting 3:1. */
  readonly oddsAgainst: number;
}

/**
 * Pot odds for a call.
 *
 * `potBeforeCall` must already include the bet hero is facing — that is the
 * pot as displayed at the moment of the decision.
 */
export function potOdds(callAmount: number, potBeforeCall: number): PotOddsResult {
  if (!Number.isFinite(callAmount) || callAmount < 0) {
    throw new Error(`Call amount must be a non-negative number, got ${callAmount}`);
  }
  if (!Number.isFinite(potBeforeCall) || potBeforeCall < 0) {
    throw new Error(`Pot must be a non-negative number, got ${potBeforeCall}`);
  }
  const potAfterCall = potBeforeCall + callAmount;
  // A free check is 0% pot odds: hero risks nothing to see the next card.
  const potOddsPercent = potAfterCall === 0 ? 0 : (callAmount / potAfterCall) * 100;
  return {
    callAmount,
    potBeforeCall,
    potAfterCall,
    potOddsPercent,
    breakEvenEquityPercent: potOddsPercent,
    oddsAgainst: callAmount === 0 ? Infinity : potBeforeCall / callAmount,
  };
}

/**
 * Equity needed to call profitably, as a fraction rather than a percentage.
 * Convenience for the action solver, which works in fractions throughout.
 */
export function breakEvenEquity(callAmount: number, potBeforeCall: number): number {
  return potOdds(callAmount, potBeforeCall).potOddsPercent / 100;
}

/**
 * The fraction of the time a pure bluff of `betSize` into `pot` must win
 * immediately to break even: `bet / (pot + bet)`.
 *
 * Used by the action solver's fold-equity term, and by the feedback templates
 * when explaining why a bet is or is not profitable as a bluff.
 */
export function requiredFoldEquity(betSize: number, pot: number): number {
  if (!Number.isFinite(betSize) || betSize <= 0) {
    throw new Error(`Bet size must be a positive number, got ${betSize}`);
  }
  if (!Number.isFinite(pot) || pot < 0) {
    throw new Error(`Pot must be a non-negative number, got ${pot}`);
  }
  return betSize / (pot + betSize);
}

/** Rounds a percentage for display without letting 0.5pp errors creep in. */
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}
