/**
 * session.ts — the state machines for both modes.
 *
 * Both follow the same shape: a hand is BUILT and its truth FROZEN before it is
 * handed to the caller, the caller submits input, and grading is a pure
 * comparison. A session never recomputes truth in response to input.
 *
 * Outs mode: flop, then turn if the flop was answered correctly. No river.
 * A correct fold ends the hand there as a win, per the spec.
 *
 * Preflop mode: one action, graded against the charts.
 */

import {
  type CardCode,
  type Rng,
  createRng,
  generateSeed,
  shuffledDeckCodes,
} from '../engine/deck';
import { type ActionKind } from '../engine/actionSolver';
import {
  type ChartPosition,
  type Range,
  RangeCharts,
  openerBucket,
  seatPositions,
} from '../engine/ranges';
import { tableAdjustedResponse, tableAdjustedRfi } from '../engine/tableScaling';
import { gradeHand } from './grading';
import {
  buildOutsSpot,
  opponentRangeOnStreet,
  priceOnStreet,
  withStreetActions,
  type OutsSpot,
} from './spot';
import { buildTruth, deepFreeze } from './truth';
import {
  BIG_BLIND,
  type HandGrade,
  type HandInput,
  type HandTruth,
  type Seat,
  type Settings,
  type Street,
} from './types';

/* -------------------------------------------------------------------------- */
/* Outs mode                                                                   */
/* -------------------------------------------------------------------------- */

export type OutsPhase = 'flop' | 'turn' | 'won' | 'lost';

export interface OutsHandState {
  readonly seed: string;
  readonly phase: OutsPhase;
  /** Truth for the current decision, or null once the hand is over. */
  readonly truth: HandTruth | null;
  /** Grades collected so far, flop first. */
  readonly grades: readonly HandGrade[];
  /** Set when the hand ended, explaining why. */
  readonly outcome: 'won' | 'lost' | null;
  readonly outcomeReason: string | null;
}

export class OutsHand {
  private readonly spot: OutsSpot;
  private readonly rng: Rng;
  private state: OutsHandState;

  constructor(
    readonly seed: string,
    private readonly settings: Settings,
    charts: RangeCharts,
    private readonly iterations?: number,
  ) {
    this.rng = createRng(seed);
    this.spot = buildOutsSpot(seed, settings, charts, this.rng);
    this.state = {
      seed,
      phase: 'flop',
      truth: this.truthFor('flop'),
      grades: [],
      outcome: null,
      outcomeReason: null,
    };
  }

  get current(): OutsHandState {
    return this.state;
  }

  /** The board visible at a street. */
  private boardFor(street: 'flop' | 'turn'): CardCode[] {
    return street === 'flop' ? [...this.spot.flop] : [...this.spot.flop, this.spot.turnCard];
  }

  private truthFor(street: 'flop' | 'turn'): HandTruth {
    const board = this.boardFor(street);
    const range = opponentRangeOnStreet(this.spot, street);
    const { pot, toCall } = priceOnStreet(this.spot, street);
    const seats = withStreetActions(this.spot.seats, this.spot, street);
    const opponentSeat = seats.find((s) => s.seatIndex === this.spot.opponentSeatIndex);
    if (opponentSeat === undefined) throw new Error('Opponent seat vanished');

    return buildTruth({
      seed: `${this.seed}:${street}`,
      street,
      heroCards: this.spot.heroCards,
      board,
      pot,
      toCall,
      seats,
      heroSeatIndex: this.spot.heroSeatIndex,
      opponentRanges: [range],
      opponentSeats: [opponentSeat],
      asksForOuts: this.settings.countOutsYourself,
      // A fresh generator per street, derived from the seed, so the flop's
      // Monte Carlo cannot shift the turn's by consuming draws.
      rng: createRng(`${this.seed}:${street}:equity`),
      ...(this.iterations === undefined ? {} : { iterations: this.iterations }),
    });
  }

  /**
   * Submits hero's answers for the current street.
   *
   * `answering` is the truth object the caller RENDERED, and it must be the one
   * currently pending. Requiring it makes a whole class of bug impossible to
   * express: a UI holding stale state could otherwise show one hand while this
   * graded another, which is exactly what happened once — a screen rendered the
   * previous hand's cards while the answers were graded against a freshly dealt
   * one, so a correct answer was marked wrong and the same seed appeared to
   * produce two different truths.
   *
   * Grading itself is pure; this method only advances the phase.
   */
  submit(
    input: HandInput,
    answering: HandTruth,
  ): { grade: HandGrade; state: OutsHandState } {
    // The truth object stays populated after the hand ends so the feedback
    // panel can render it, so completion is signalled by the phase, not by a
    // null truth.
    if (this.state.phase === 'won' || this.state.phase === 'lost') {
      throw new Error(`This hand is already over (${this.state.outcome})`);
    }
    const truth = this.state.truth;
    if (truth === null) throw new Error('No decision is pending');
    if (answering !== truth) {
      throw new Error(
        'Refusing to grade: the answers belong to a different hand than the one '
        + `pending (${answering.seed} vs ${truth.seed}). The caller is holding `
        + 'stale state.',
      );
    }

    const grade = gradeHand(truth, input);
    const grades = [...this.state.grades, grade];

    if (!grade.passed) {
      this.state = {
        ...this.state,
        phase: 'lost',
        truth,
        grades,
        outcome: 'lost',
        outcomeReason: input.timedOut ? 'ran out of time' : 'wrong answer',
      };
      return { grade, state: this.state };
    }

    // Fold edge case: a correct fold ends the hand as a win. There is no turn
    // to see, because hero is no longer in the pot.
    if (input.action === 'fold') {
      this.state = {
        ...this.state,
        phase: 'won',
        truth,
        grades,
        outcome: 'won',
        outcomeReason: 'correct fold — the hand ends here',
      };
      return { grade, state: this.state };
    }

    if (this.state.phase === 'flop') {
      this.state = {
        seed: this.seed,
        phase: 'turn',
        truth: this.truthFor('turn'),
        grades,
        outcome: null,
        outcomeReason: null,
      };
      return { grade, state: this.state };
    }

    this.state = {
      ...this.state,
      phase: 'won',
      truth,
      grades,
      outcome: 'won',
      outcomeReason: 'flop and turn both correct',
    };
    return { grade, state: this.state };
  }
}

/* -------------------------------------------------------------------------- */
/* Preflop mode                                                                */
/* -------------------------------------------------------------------------- */

/** What hero is facing when the action reaches them. */
export type FacingAction = 'foldedToHero' | 'open' | 'openWithCallers' | 'threeBet';

export interface PreflopTruth {
  readonly seed: string;
  readonly heroCardCodes: readonly CardCode[];
  readonly heroSeatIndex: number;
  readonly seats: readonly Seat[];
  readonly facing: FacingAction;
  /** Seat that opened, when there is one. */
  readonly openerSeatIndex: number | null;
  readonly accepted: readonly ActionKind[];
  readonly best: ActionKind;
  readonly firedRules: readonly string[];
  /** The chart ranges consulted, for the feedback grid. */
  readonly rangeLabel: string;
  readonly rangePercent: number;
}

/**
 * Hero's correct preflop action, straight from the charts.
 *
 * Documented facing-action rules:
 *   - folded to hero: raise if the hand is in the table-adjusted opening range,
 *     otherwise fold. Calling is never correct when nobody has entered.
 *   - facing an open: 3-bet if the hand is in the 3-bet range; call if it is in
 *     the calling range; otherwise fold. When a hand appears in both, both are
 *     accepted, because the charts express it as a mixed strategy.
 *   - facing an open with callers: squeeze or overcall from the multiway chart.
 *   - facing a 3-bet: 4-bet or call from the vs-3-bet chart, otherwise fold.
 */
export function solvePreflop(
  charts: RangeCharts,
  settings: Settings,
  heroSeatIndex: number,
  heroCards: readonly CardCode[],
  facing: FacingAction,
  openerChart: ChartPosition | null,
): { accepted: ActionKind[]; best: ActionKind; rules: string[]; label: string; percent: number } {
  const inRange = (range: Range): boolean =>
    range.weightOfCards(heroCards[0] as CardCode, heroCards[1] as CardCode) > 0;
  const rules: string[] = [];

  if (facing === 'foldedToHero') {
    const rfi = tableAdjustedRfi(charts, settings.playerCount, heroSeatIndex);
    if (inRange(rfi)) {
      rules.push(`hand is in the ${rfi.label} opening range (${rfi.percentOfHands.toFixed(1)}%) → raise`);
      return { accepted: ['raise'], best: 'raise', rules, label: rfi.label, percent: rfi.percentOfHands };
    }
    rules.push(`hand is outside the ${rfi.label} opening range → fold`);
    return { accepted: ['fold'], best: 'fold', rules, label: rfi.label, percent: rfi.percentOfHands };
  }

  if (openerChart === null) throw new Error(`Facing ${facing} needs an opener`);

  if (facing === 'threeBet') {
    const response = charts.vsThreeBet(
      (seatPositions(settings.playerCount)[heroSeatIndex] as { chart: ChartPosition }).chart,
    );
    const accepted: ActionKind[] = [];
    if (inRange(response.fourBet)) { accepted.push('raise'); rules.push('hand is in the 4-bet range → raise'); }
    if (inRange(response.call)) { accepted.push('call'); rules.push('hand is in the calling range vs a 3-bet → call'); }
    if (accepted.length === 0) {
      rules.push('hand is in neither the 4-bet nor the calling range vs a 3-bet → fold');
      return { accepted: ['fold'], best: 'fold', rules, label: response.call.label, percent: response.call.percentOfHands };
    }
    return { accepted, best: accepted[0] as ActionKind, rules, label: response.call.label, percent: response.call.percentOfHands };
  }

  const response = facing === 'openWithCallers'
    ? charts.vsOpenWithCallers(
        (seatPositions(settings.playerCount)[heroSeatIndex] as { chart: ChartPosition }).chart,
      )
    : tableAdjustedResponse(charts, settings.playerCount, heroSeatIndex, openerChart);

  const raiseRange = facing === 'openWithCallers' ? response.squeeze : response.threeBet;
  const accepted: ActionKind[] = [];
  if (inRange(raiseRange)) {
    accepted.push('raise');
    rules.push(`hand is in the ${raiseRange.label} range (${raiseRange.percentOfHands.toFixed(1)}%) → raise`);
  }
  if (inRange(response.call)) {
    accepted.push('call');
    rules.push(`hand is in the ${response.call.label} range (${response.call.percentOfHands.toFixed(1)}%) → call`);
  }
  if (accepted.length === 0) {
    rules.push(`hand is in neither the calling nor the raising range vs a ${openerBucket(openerChart)} open → fold`);
    return { accepted: ['fold'], best: 'fold', rules, label: response.call.label, percent: response.call.percentOfHands };
  }
  return {
    accepted, best: accepted[0] as ActionKind, rules,
    label: response.call.label, percent: response.call.percentOfHands,
  };
}

export interface PreflopGrade {
  readonly passed: boolean;
  readonly given: ActionKind | null;
  readonly best: ActionKind;
  readonly accepted: readonly ActionKind[];
  readonly firedRules: readonly string[];
  readonly mistakes: readonly string[];
}

/** Builds one Preflop-mode hand and freezes its truth. */
export function buildPreflopHand(
  seed: string,
  settings: Settings,
  charts: RangeCharts,
): PreflopTruth {
  const rng = createRng(seed);
  const positions = seatPositions(settings.playerCount);
  const heroSeatIndex = settings.fixedSeatIndex !== null
    ? Math.min(settings.fixedSeatIndex, positions.length - 1)
    : rng.nextInt(positions.length);
  const heroPosition = positions[heroSeatIndex];
  if (heroPosition === undefined) throw new Error(`Invalid hero seat ${heroSeatIndex}`);

  const heroCards = shuffledDeckCodes(rng).slice(0, 2);

  // Which facing actions are possible depends on whether anyone acts before hero.
  const earlier = positions.filter(
    (seat) => seat.seatIndex < heroSeatIndex && seat.chart !== 'BB',
  );
  const options: FacingAction[] = earlier.length === 0
    ? ['foldedToHero']
    : ['foldedToHero', 'open', 'open', 'openWithCallers', 'threeBet'];
  const facing = options[rng.nextInt(options.length)] as FacingAction;

  const opener = facing === 'foldedToHero' || earlier.length === 0
    ? null
    : earlier[rng.nextInt(earlier.length)];

  const solved = solvePreflop(
    charts, settings, heroSeatIndex, heroCards, facing,
    opener === undefined || opener === null ? null : opener.chart,
  );

  const seats: Seat[] = positions.map((seat) => {
    const isHero = seat.seatIndex === heroSeatIndex;
    const actions = [];
    if (isHero) {
      actions.push({ street: 'preflop' as Street, description: 'to act' });
    } else if (opener !== null && opener !== undefined && seat.seatIndex === opener.seatIndex) {
      actions.push({
        street: 'preflop' as Street,
        description: facing === 'threeBet' ? `3-bet to ${BIG_BLIND * 9}` : `raised to ${BIG_BLIND * 3}`,
      });
    } else if (seat.seatIndex < heroSeatIndex) {
      actions.push({ street: 'preflop' as Street, description: 'folded' });
    }
    return {
      seatIndex: seat.seatIndex,
      display: seat.display,
      chart: seat.chart,
      isHero,
      hasFolded: !isHero && seat.seatIndex < heroSeatIndex
        && !(opener !== null && opener !== undefined && seat.seatIndex === opener.seatIndex),
      actions,
    };
  });

  return deepFreeze({
    seed,
    heroCardCodes: heroCards,
    heroSeatIndex,
    seats,
    facing,
    openerSeatIndex: opener === null || opener === undefined ? null : opener.seatIndex,
    accepted: solved.accepted,
    best: solved.best,
    firedRules: solved.rules,
    rangeLabel: solved.label,
    rangePercent: solved.percent,
  });
}

/** Grades a Preflop-mode answer. Pure. */
export function gradePreflop(
  truth: PreflopTruth,
  given: ActionKind | null,
  timedOut: boolean,
): PreflopGrade {
  const passed = !timedOut && given !== null && truth.accepted.includes(given);
  const mistakes: string[] = [];
  if (timedOut) mistakes.push('TIMEOUT');
  else if (!passed) {
    if (truth.best === 'fold') mistakes.push('ACTION_SHOULD_FOLD');
    else if (given === 'fold') mistakes.push('ACTION_TOO_PASSIVE');
    else mistakes.push('ACTION_TOO_AGGRESSIVE');
  }
  return {
    passed,
    given,
    best: truth.best,
    accepted: truth.accepted,
    firedRules: truth.firedRules,
    mistakes,
  };
}

/** Generates the next hand's seed from a session-level generator. */
export function nextSeed(rng: Rng): string {
  return generateSeed(rng);
}
