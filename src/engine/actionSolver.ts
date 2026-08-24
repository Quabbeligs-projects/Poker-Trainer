/**
 * actionSolver.ts — the correct action, rule-based and transparent.
 *
 * Every action gets an expected value in chips, measured against folding, which
 * is defined as zero. Nothing here is a heuristic score: each EV is an explicit
 * pot-arithmetic expression, written out below, using equities the Monte Carlo
 * engine computed and fold frequencies `rangeNarrowing.ts` derived.
 *
 * The solver returns `firedRules` — the human-readable reasons that produced
 * the verdict — so the feedback panel never has to guess why an action won.
 *
 * ============================================================================
 * THE EV MODEL
 * ============================================================================
 * `pot` always means the pot as displayed at the moment of hero's decision,
 * including any bet hero is facing. `toCall` is what hero must put in to
 * continue, zero when hero can check.
 *
 *   FOLD    0, by definition. Hero's chips already in the pot are not hero's.
 *
 *   CHECK   equity x pot
 *           Hero invests nothing and realises equity in the current pot. This
 *           ignores future betting, which is the documented simplification
 *           below.
 *
 *   CALL    equity x (pot + toCall) - toCall
 *           Hero invests toCall and wins the resulting pot `equity` of the time.
 *           Profitable exactly when equity exceeds pot odds, which is why the
 *           trainer grades pot odds and action together.
 *
 *   BET     f x pot + (1 - f) x [equityVsContinuing x (pot + 2b) - b]
 *           where b = BET_FRACTION x pot and f is how often the opponent folds.
 *           When called, hero's equity is measured against the range that
 *           CONTINUES, not the whole range — the folding hands are exactly the
 *           ones hero already beats, so using total equity here would
 *           systematically overvalue betting.
 *
 *   RAISE   f x pot + (1 - f) x [equityVsContinuing x (pot + r + (r - toCall)) - r]
 *           where r = toCall + BET_FRACTION x (pot + toCall): hero calls the
 *           bet, then raises two thirds of the resulting pot.
 *
 * ============================================================================
 * SIMPLIFICATIONS, STATED PLAINLY
 * ============================================================================
 *   - One street at a time. No implied odds, no future betting, no multi-street
 *     planning. A call that is marginally -EV on this street alone may be
 *     correct in a real game; the trainer grades the single-street calculation.
 *   - One bet size, fixed at two thirds of the pot, per the spec.
 *   - Multiway pots resolve as a simple showdown: fold equity is taken against
 *     the modelled opponent's range, not against several opponents in sequence.
 */

import { type CardCode } from './deck';
import { type Range } from './ranges';
import { potOdds, requiredFoldEquity } from './potOdds';
import { splitByFoldDecision } from './rangeNarrowing';

/** The actions the trainer offers. */
export const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise'] as const;
export type ActionKind = (typeof ACTIONS)[number];

/**
 * Bet and raise sizing, as a fraction of the pot. Fixed at two thirds by the
 * spec so that the drill has one price to reason about rather than a sizing
 * decision on top of an action decision.
 */
export const BET_FRACTION = 2 / 3;

/**
 * An action counts as correct when its EV is within this fraction of the best
 * action's EV.
 */
export const EV_TOLERANCE_FRACTION = 0.05;

/**
 * Absolute floor on that tolerance, as a fraction of the pot.
 *
 * Without it, grading becomes knife-edge whenever the best EV is near zero: a
 * 5% band around an EV of 0.02 chips would reject an action worth 0.01 chips,
 * which is not a real mistake. Set to 1% of the pot.
 */
export const EV_TOLERANCE_POT_FRACTION = 0.01;

export interface ActionEV {
  readonly action: ActionKind;
  /** Expected value in chips, relative to folding. */
  readonly ev: number;
  /** Chips hero puts in for this action. */
  readonly amount: number;
  /** True when this action is within tolerance of the best. */
  readonly correct: boolean;
  /** Why this action scores what it scores. */
  readonly explanation: string;
}

export interface ActionSolverInput {
  /** Hero's equity against the opponent's full narrowed range, as a fraction. */
  readonly equity: number;
  /**
   * Hero's equity against only the part of the range that continues against a
   * bet or raise, as a fraction. When omitted, `equity` is used and the solver
   * records that the fold-equity term is approximate.
   */
  readonly equityVsContinuing?: number;
  /** Pot as displayed at the decision, including any bet hero faces. */
  readonly pot: number;
  /** Chips hero must add to continue. Zero when hero may check. */
  readonly toCall: number;
  /** The opponent's narrowed range, for the fold-equity estimate. */
  readonly opponentRange: Range;
  /** The board visible at the decision. */
  readonly board: readonly CardCode[];
}

export interface ActionSolution {
  /** Every legal action, best EV first. */
  readonly ranked: readonly ActionEV[];
  /** Actions accepted as correct. Always at least one. */
  readonly accepted: readonly ActionKind[];
  /** The single highest-EV action. */
  readonly best: ActionKind;
  /** Human-readable rules that produced the verdict. */
  readonly firedRules: readonly string[];
  /** Pot odds hero is being offered, as a percentage. */
  readonly potOddsPercent: number;
  /** How often the opponent folds to hero's bet or raise, as a fraction. */
  readonly foldEquity: number;
  /** The bet or raise size the solver priced. */
  readonly betSize: number;
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(0)}%`;
const chips = (value: number) => (Math.round(value * 10) / 10).toString();

/**
 * Ranks every legal action by expected value.
 *
 * Nothing about hero's input reaches this function: it takes only the hand's
 * facts. That is what lets the game layer compute and freeze ground truth
 * before rendering anything.
 */
export function solveAction(input: ActionSolverInput): ActionSolution {
  const { equity, pot, toCall, opponentRange, board } = input;

  if (!(equity >= 0 && equity <= 1)) {
    throw new Error(`Equity must be a fraction within [0, 1], got ${equity}`);
  }
  if (!(pot > 0)) throw new Error(`Pot must be positive, got ${pot}`);
  if (!(toCall >= 0)) throw new Error(`toCall must be non-negative, got ${toCall}`);

  const facingBet = toCall > 0;
  const firedRules: string[] = [];

  // ---- Sizing -------------------------------------------------------------
  const betSize = facingBet
    ? toCall + BET_FRACTION * (pot + toCall)
    : BET_FRACTION * pot;

  // ---- Fold equity --------------------------------------------------------
  // The opponent's fold decision turns on the price THEY are laid, so work out
  // what they must call and into what pot. For a bet they call `betSize` into
  // `pot + betSize`. For a raise they have already invested `toCall`, so they
  // add only the difference into a pot that already contains hero's raise.
  const villainMustCall = facingBet ? betSize - toCall : betSize;
  const potVillainFaces = pot + betSize;
  const split = splitByFoldDecision(opponentRange, board, villainMustCall, potVillainFaces);
  const foldEquity = split.foldFrequency;
  const equityVsContinuing = input.equityVsContinuing ?? equity;
  if (input.equityVsContinuing === undefined) {
    firedRules.push(
      'fold-equity term uses total equity rather than equity against the '
      + 'continuing range, so bet and raise EV are slightly optimistic',
    );
  }

  // ---- Pot odds -----------------------------------------------------------
  const odds = potOdds(toCall, pot);
  const potOddsFraction = odds.potOddsPercent / 100;

  // ---- EV per action ------------------------------------------------------
  const candidates: ActionEV[] = [];

  // FOLD is always legal and always the zero baseline.
  candidates.push({
    action: 'fold',
    ev: 0,
    amount: 0,
    correct: false,
    explanation: 'folding is the zero baseline: chips already in the pot are not hero\'s',
  });

  if (facingBet) {
    const evCall = equity * (pot + toCall) - toCall;
    candidates.push({
      action: 'call',
      ev: evCall,
      amount: toCall,
      correct: false,
      explanation:
        `call ${chips(toCall)} into ${chips(pot)}: ${pct(equity)} x ${chips(pot + toCall)} `
        + `- ${chips(toCall)} = ${chips(evCall)}`,
    });

    const raiseTo = betSize;
    const potIfCalled = pot + raiseTo + (raiseTo - toCall);
    const evRaise = foldEquity * pot
      + (1 - foldEquity) * (equityVsContinuing * potIfCalled - raiseTo);
    candidates.push({
      action: 'raise',
      ev: evRaise,
      amount: raiseTo,
      correct: false,
      explanation:
        `raise to ${chips(raiseTo)}: folds ${pct(foldEquity)} of the time winning `
        + `${chips(pot)}, otherwise ${pct(equityVsContinuing)} of ${chips(potIfCalled)} `
        + `for ${chips(raiseTo)} = ${chips(evRaise)}`,
    });
  } else {
    const evCheck = equity * pot;
    candidates.push({
      action: 'check',
      ev: evCheck,
      amount: 0,
      correct: false,
      explanation:
        `check: ${pct(equity)} of the current ${chips(pot)} pot = ${chips(evCheck)}, `
        + 'investing nothing',
    });

    const potIfCalled = pot + 2 * betSize;
    const evBet = foldEquity * pot
      + (1 - foldEquity) * (equityVsContinuing * potIfCalled - betSize);
    candidates.push({
      action: 'bet',
      ev: evBet,
      amount: betSize,
      correct: false,
      explanation:
        `bet ${chips(betSize)}: folds ${pct(foldEquity)} of the time winning ${chips(pot)}, `
        + `otherwise ${pct(equityVsContinuing)} of ${chips(potIfCalled)} for `
        + `${chips(betSize)} = ${chips(evBet)}`,
    });
  }

  // ---- Ranking and acceptance --------------------------------------------
  const ranked = [...candidates].sort((a, b) => b.ev - a.ev);
  const bestEV = (ranked[0] as ActionEV).ev;
  const tolerance = Math.max(
    Math.abs(bestEV) * EV_TOLERANCE_FRACTION,
    pot * EV_TOLERANCE_POT_FRACTION,
  );

  const withCorrectness = ranked.map((candidate) => ({
    ...candidate,
    correct: bestEV - candidate.ev <= tolerance,
  }));
  const accepted = withCorrectness.filter((c) => c.correct).map((c) => c.action);

  // ---- Fired rules --------------------------------------------------------
  if (facingBet) {
    if (equity > potOddsFraction) {
      firedRules.push(
        `equity (${pct(equity)}) exceeds pot odds (${odds.potOddsPercent.toFixed(0)}%) `
        + '→ call is profitable',
      );
    } else {
      firedRules.push(
        `equity (${pct(equity)}) is below the break-even ${odds.potOddsPercent.toFixed(0)}% `
        + 'this price demands → calling loses chips',
      );
    }
    const needed = requiredFoldEquity(betSize - toCall, pot);
    if (foldEquity >= needed) {
      firedRules.push(
        `opponent folds ${pct(foldEquity)} to a ${chips(betSize)} raise, above the `
        + `${pct(needed)} a raise of that size needs → raising has fold equity`,
      );
    } else {
      firedRules.push(
        `opponent folds only ${pct(foldEquity)} to a raise, below the ${pct(needed)} `
        + 'it needs to break even as a bluff → no meaningful fold equity',
      );
    }
    if (equity <= potOddsFraction && foldEquity < needed) {
      firedRules.push('equity below break-even and no meaningful fold equity → fold');
    }
  } else {
    const needed = requiredFoldEquity(betSize, pot);
    firedRules.push(
      `no bet to call, so checking realises ${pct(equity)} of the ${chips(pot)} pot for free`,
    );
    if (foldEquity >= needed) {
      firedRules.push(
        `opponent folds ${pct(foldEquity)} to a ${chips(betSize)} bet, above the `
        + `${pct(needed)} needed → betting is profitable on fold equity alone`,
      );
    }
    if (equityVsContinuing > 0.55) {
      firedRules.push(
        `still ${pct(equityVsContinuing)} equity against the hands that continue `
        + '→ betting is a value bet, not a bluff',
      );
    }
  }

  const best = (withCorrectness[0] as ActionEV).action;
  if (accepted.length > 1) {
    firedRules.push(
      `${accepted.join(' and ')} are within ${pct(EV_TOLERANCE_FRACTION)} of each other `
      + '→ both count as correct',
    );
  }

  return {
    ranked: withCorrectness,
    accepted,
    best,
    firedRules,
    potOddsPercent: odds.potOddsPercent,
    foldEquity,
    betSize,
  };
}
