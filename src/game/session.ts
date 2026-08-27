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
  comboIndex,
  handKeyOfCombo,
  openerBucket,
  type SeatPosition,
  seatPositions,
} from '../engine/ranges';
import {
  handOrdering,
  scaleRangeWidth,
  tableAdjustedResponse,
  tableAdjustedRfi,
  tableSeats,
} from '../engine/tableScaling';
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

/** A chart consulted for this decision, ready for the 13x13 grid. */
export interface PreflopRangeView {
  readonly action: ActionKind;
  readonly label: string;
  readonly percentOfHands: number;
  readonly handKeyWeights: ReadonlyArray<readonly [string, number]>;
}

export interface PreflopTruth {
  readonly seed: string;
  readonly heroCardCodes: readonly CardCode[];
  /** Hero's hand as a grid key, e.g. "AKs", so it can be located on the chart. */
  readonly heroHandKey: string;
  readonly heroSeatIndex: number;
  readonly seats: readonly Seat[];
  readonly facing: FacingAction;
  /** Seat that opened, when there is one. */
  readonly openerSeatIndex: number | null;
  /** Seat that called the open, for `openWithCallers`. */
  readonly callerSeatIndex: number | null;
  /** True when hero opened the pot and is now facing a re-raise. */
  readonly heroOpened: boolean;
  readonly accepted: readonly ActionKind[];
  readonly best: ActionKind;
  readonly firedRules: readonly string[];
  /**
   * Every chart consulted, for the feedback grid.
   *
   * Seeing where the hand sits on the chart is the whole lesson in Preflop
   * mode — a verdict without the chart teaches nothing about the next hand.
   */
  readonly ranges: readonly PreflopRangeView[];
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
): {
  accepted: ActionKind[];
  best: ActionKind;
  rules: string[];
  ranges: PreflopRangeView[];
} {
  const consulted = consultedRanges(charts, settings, heroSeatIndex, facing, openerChart);

  // A verdict with no chart behind it is a verdict with no basis. Every branch
  // below falls through to "fold" when the hand is in none of the consulted
  // ranges, so an empty chart set does not fail loudly on its own — it silently
  // folds everything, aces included. Refuse instead. legalFacings() keeps spot
  // generation from ever reaching this, and a test sweeps every seat to prove
  // it; this is the backstop that makes a gap impossible to ship quietly.
  if (!consulted.some((entry) => !entry.range.isEmpty)) {
    throw new Error(
      `No chart covers ${facing} for a ${(seatPositions(settings.playerCount)[heroSeatIndex] as { chart: ChartPosition }).chart} `
      + `seat at a ${settings.playerCount}-handed table (consulted: `
      + `${consulted.map((entry) => entry.range.label).join(', ') || 'nothing'}). `
      + 'This spot must not be generated.',
    );
  }

  const inRange = (range: Range): boolean =>
    range.weightOfCards(heroCards[0] as CardCode, heroCards[1] as CardCode) > 0;
  const view = (action: ActionKind, range: Range): PreflopRangeView => ({
    action,
    label: range.label,
    percentOfHands: range.percentOfHands,
    handKeyWeights: [...range.handKeyWeights().entries()]
      .map(([key, value]) => [key, value.weight / value.combos] as const),
  });

  const rules: string[] = [];
  const ranges = consulted.map((entry) => view(entry.action, entry.range));

  if (facing === 'foldedToHero') {
    const rfi = (consulted[0] as ConsultedRange).range;
    if (inRange(rfi)) {
      rules.push(`hand is in the ${rfi.label} opening range (${rfi.percentOfHands.toFixed(1)}%) → raise`);
      return { accepted: ['raise'], best: 'raise', rules, ranges };
    }
    rules.push(`hand is outside the ${rfi.label} opening range → fold`);
    return { accepted: ['fold'], best: 'fold', rules, ranges };
  }

  const accepted: ActionKind[] = [];
  for (const entry of consulted) {
    if (entry.range.isEmpty || !inRange(entry.range)) continue;
    accepted.push(entry.action);
    rules.push(
      `hand is in the ${entry.range.label} range (${entry.range.percentOfHands.toFixed(1)}%) → ${entry.action}`,
    );
  }
  if (accepted.length === 0) {
    rules.push(
      facing === 'threeBet'
        ? 'hand is in neither the 4-bet nor the calling range vs a 3-bet → fold'
        : `hand is in neither the calling nor the raising range vs a ${openerBucket(openerChart as ChartPosition)} open → fold`,
    );
    return { accepted: ['fold'], best: 'fold', rules, ranges };
  }
  return { accepted, best: accepted[0] as ActionKind, rules, ranges };
}

interface ConsultedRange {
  readonly action: ActionKind;
  readonly range: Range;
}

/**
 * Every chart `solvePreflop` will consult for this spot, in the order it
 * consults them, most aggressive first.
 *
 * Spot generation and the solver both read this, so the two can never disagree
 * about which charts back a verdict. When a seat/action pair has no chart, that
 * shows up here as an empty range, `legalFacings` refuses to generate the spot,
 * and `solvePreflop` throws rather than folding every hand by default.
 */
function consultedRanges(
  charts: RangeCharts,
  settings: Settings,
  heroSeatIndex: number,
  facing: FacingAction,
  openerChart: ChartPosition | null,
): ConsultedRange[] {
  const heroChart = (seatPositions(settings.playerCount)[heroSeatIndex] as { chart: ChartPosition }).chart;

  if (facing === 'foldedToHero') {
    return [{
      action: 'raise',
      range: tableAdjustedRfi(charts, settings.playerCount, heroSeatIndex),
    }];
  }

  if (openerChart === null) throw new Error(`Facing ${facing} needs an opener`);

  if (facing === 'threeBet') {
    const response = charts.vsThreeBet(heroChart);
    return [
      { action: 'raise', range: response.fourBet },
      { action: 'call', range: response.call },
    ];
  }

  if (facing === 'openWithCallers') {
    // Multiway charts are position-specific and are not part of the vsOpen
    // set, so they are looked up separately — but they get the same width
    // scaling as every other range, which the first version skipped.
    const seat = tableSeats(settings.playerCount)[heroSeatIndex] as { widthFactor: number };
    const base = charts.vsOpenWithCallers(heroChart);
    const ordering = handOrdering(charts);
    return [
      { action: 'raise', range: scaleRangeWidth(base.squeeze, seat.widthFactor, ordering) },
      { action: 'call', range: scaleRangeWidth(base.call, seat.widthFactor, ordering) },
    ];
  }

  const response = tableAdjustedResponse(charts, settings.playerCount, heroSeatIndex, openerChart);
  return [
    { action: 'raise', range: response.threeBet },
    { action: 'call', range: response.call },
  ];
}

export interface PreflopGrade {
  readonly passed: boolean;
  readonly given: ActionKind | null;
  readonly best: ActionKind;
  readonly accepted: readonly ActionKind[];
  readonly firedRules: readonly string[];
  readonly mistakes: readonly string[];
}

export interface LegalFacing {
  readonly facing: FacingAction;
  readonly openerSeatIndex: number | null;
  /** The seat that called the open, for `openWithCallers`. */
  readonly callerSeatIndex: number | null;
  /** True when hero opened the pot and is now facing a re-raise. */
  readonly heroOpened: boolean;
}

/**
 * Every preflop spot that can actually be dealt to this seat.
 *
 * Picking a facing action first and hoping the rest of the system could express
 * it is what produced two broken spot types: a big blind "folded to hero" that
 * no chart covers, and an "opened, with callers" whose table showed every seat
 * between the opener and hero as folded. The rules are enumerated here instead,
 * and every one of them is a fact about poker rather than a tuning knob:
 *
 *   - folded to hero — needs a seat that can be first in voluntarily. Folded to
 *     the BIG BLIND is not a spot at all: the blind is already posted, everyone
 *     has folded, and the hand is over without the big blind acting. So the big
 *     blind is excluded, which is also why no BB opening chart exists to grade
 *     it against.
 *   - facing an open — needs one earlier seat to be the opener. The big blind
 *     cannot be that seat: it acts last preflop, so it never opens.
 *   - opened, with callers — needs an opener AND at least one seat strictly
 *     between the opener and hero to be the caller. Without one there is nobody
 *     who could have called, and the squeeze chart is being applied to dead
 *     money that does not exist.
 *   - facing a 3-bet — hero opened and a LATER seat re-raised, so action came
 *     back around. The 3-bettor must therefore sit AFTER hero, not before, and
 *     hero must be able to open in the first place (so, not the big blind).
 *
 * A spot also has to have a chart behind it. That is checked against the same
 * lookup the solver uses rather than restated here, so the two cannot drift:
 * the multiway charts have no UTG entry, because at six-handed and smaller UTG
 * never faces an open at all. At eight-handed and larger several seats share
 * the UTG chart, so a later UTG seat CAN face an open with callers — a real
 * spot with no chart for it. Rather than grade it against a neighbouring
 * position's squeeze range, which would be inventing poker, it is not dealt.
 */
export function legalFacings(
  charts: RangeCharts,
  settings: Settings,
  positions: readonly SeatPosition[],
  heroSeatIndex: number,
): LegalFacing[] {
  const hero = positions[heroSeatIndex];
  if (hero === undefined) throw new Error(`Invalid hero seat ${heroSeatIndex}`);

  const canOpen = (seat: SeatPosition): boolean => seat.chart !== 'BB';
  const earlier = positions.filter((seat) => seat.seatIndex < heroSeatIndex && canOpen(seat));
  const later = positions.filter((seat) => seat.seatIndex > heroSeatIndex);

  const candidates: LegalFacing[] = [];

  if (canOpen(hero)) {
    candidates.push({
      facing: 'foldedToHero', openerSeatIndex: null, callerSeatIndex: null, heroOpened: false,
    });
  }

  for (const opener of earlier) {
    candidates.push({
      facing: 'open', openerSeatIndex: opener.seatIndex, callerSeatIndex: null, heroOpened: false,
    });
    for (const caller of positions) {
      if (caller.seatIndex <= opener.seatIndex || caller.seatIndex >= heroSeatIndex) continue;
      candidates.push({
        facing: 'openWithCallers',
        openerSeatIndex: opener.seatIndex,
        callerSeatIndex: caller.seatIndex,
        heroOpened: false,
      });
    }
  }

  if (canOpen(hero)) {
    for (const threeBettor of later) {
      candidates.push({
        facing: 'threeBet',
        openerSeatIndex: threeBettor.seatIndex,
        callerSeatIndex: null,
        heroOpened: true,
      });
    }
  }

  return candidates.filter((candidate) => {
    const openerChart = candidate.openerSeatIndex === null
      ? null
      : (positions[candidate.openerSeatIndex] as SeatPosition).chart;
    return consultedRanges(charts, settings, heroSeatIndex, candidate.facing, openerChart)
      .some((entry) => !entry.range.isEmpty);
  });
}

/**
 * How often each facing action comes up in the drill.
 *
 * [JUDGEMENT] These are drill weights, not observed frequencies. Picking
 * uniformly over the legal spots would weight by how many seats can hold each
 * role, which is not the same thing: at nine-handed an early seat has seven
 * players behind it and therefore seven distinct "facing a 3-bet" spots against
 * one "folded to hero", so a uniform draw served 3-bet spots a third of the
 * time. Facing an open is the most common real decision and gets the most
 * weight; the rest are levelled so the rarer branches still come up often
 * enough to practise.
 */
const FACING_WEIGHTS: Readonly<Record<FacingAction, number>> = {
  foldedToHero: 1,
  open: 2,
  openWithCallers: 1,
  threeBet: 1,
};

/**
 * Picks a facing action by weight, then a spot uniformly within it.
 *
 * Two stages rather than one weighted draw over all candidates, so the mix of
 * facing actions does not drift with table size.
 */
function pickFacing(legal: readonly LegalFacing[], rng: Rng): LegalFacing {
  const byFacing = new Map<FacingAction, LegalFacing[]>();
  for (const candidate of legal) {
    const bucket = byFacing.get(candidate.facing);
    if (bucket === undefined) byFacing.set(candidate.facing, [candidate]);
    else bucket.push(candidate);
  }
  const available = [...byFacing.keys()];
  const total = available.reduce((sum, facing) => sum + FACING_WEIGHTS[facing], 0);
  let roll = rng.next() * total;
  for (const facing of available) {
    roll -= FACING_WEIGHTS[facing];
    if (roll <= 0) {
      const bucket = byFacing.get(facing) as LegalFacing[];
      return bucket[rng.nextInt(bucket.length)] as LegalFacing;
    }
  }
  const last = byFacing.get(available[available.length - 1] as FacingAction) as LegalFacing[];
  return last[rng.nextInt(last.length)] as LegalFacing;
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

  // Which facing actions are possible depends on the seat. Picking one and
  // hoping the rest of the system can express it is what produced a big blind
  // "folded to hero" spot that had no chart behind it and graded AA as a fold.
  // The legal set is enumerated instead, and generation throws if it is empty.
  const legal = legalFacings(charts, settings, positions, heroSeatIndex);
  if (legal.length === 0) {
    throw new Error(
      `No preflop spot can be dealt to seat ${heroSeatIndex} `
      + `(${heroPosition.chart}) at a ${settings.playerCount}-handed table.`,
    );
  }
  const spot = pickFacing(legal, rng);
  const facing = spot.facing;
  const opener = spot.openerSeatIndex === null ? null : positions[spot.openerSeatIndex] ?? null;

  const solved = solvePreflop(
    charts, settings, heroSeatIndex, heroCards, facing,
    opener === null ? null : opener.chart,
  );

  // The table has to show the story the facing action claims. Facing a 3-bet
  // means hero opened and someone BEHIND re-raised, so hero's own raise appears
  // and everyone in front has folded; "opened, with callers" means a named seat
  // actually called rather than every seat between the opener and hero folding.
  const seats: Seat[] = positions.map((seat) => {
    const isHero = seat.seatIndex === heroSeatIndex;
    const isOpener = opener !== null && seat.seatIndex === opener.seatIndex;
    const isCaller = spot.callerSeatIndex !== null && seat.seatIndex === spot.callerSeatIndex;
    const actions = [];
    if (isHero) {
      if (spot.heroOpened) {
        actions.push({ street: 'preflop' as Street, description: `raised to ${BIG_BLIND * 3}` });
      }
      actions.push({ street: 'preflop' as Street, description: 'to act' });
    } else if (isOpener) {
      actions.push({
        street: 'preflop' as Street,
        description: facing === 'threeBet' ? `3-bet to ${BIG_BLIND * 9}` : `raised to ${BIG_BLIND * 3}`,
      });
    } else if (isCaller) {
      actions.push({ street: 'preflop' as Street, description: `called ${BIG_BLIND * 3}` });
    } else if (seat.seatIndex < heroSeatIndex) {
      actions.push({ street: 'preflop' as Street, description: 'folded' });
    }
    return {
      seatIndex: seat.seatIndex,
      display: seat.display,
      chart: seat.chart,
      isHero,
      hasFolded: !isHero && !isOpener && !isCaller && seat.seatIndex < heroSeatIndex,
      actions,
    };
  });

  return deepFreeze({
    seed,
    heroCardCodes: heroCards,
    heroHandKey: handKeyOfCombo(
      comboIndex(heroCards[0] as CardCode, heroCards[1] as CardCode),
    ),
    heroSeatIndex,
    seats,
    facing,
    openerSeatIndex: opener === null ? null : opener.seatIndex,
    callerSeatIndex: spot.callerSeatIndex,
    heroOpened: spot.heroOpened,
    accepted: solved.accepted,
    best: solved.best,
    firedRules: solved.rules,
    ranges: solved.ranges,
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
