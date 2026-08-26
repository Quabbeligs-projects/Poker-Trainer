/**
 * spot.ts — constructing Outs-mode hands from a seed.
 *
 * A spot is always built so hero faces a real price: someone bet into hero and
 * hero has a decision worth grading.
 *
 * HAND MIX
 * --------
 * Hands are drawn at random and then accepted with a probability that depends
 * on what hero flopped, so the rotation leans toward draws without becoming
 * only draws. Pure air is excluded outright — there is nothing to drill in a
 * hand with no pair and no draw facing a bet; the answer is always fold.
 *
 * Made hands ARE kept, deliberately. Once hit probability and equity are
 * separate inputs, a set with zero outs and 89% equity stops being a grading
 * failure and becomes the clearest possible demonstration that counting outs
 * and estimating equity are different questions — which is exactly the error
 * this app exists to correct.
 *
 * Every draw comes from the seeded RNG, so a seed reproduces a hand exactly,
 * including the rejected candidates.
 */

import {
  type CardCode,
  type Rng,
  shuffledDeckCodes,
} from '../engine/deck';
import { classifyCombo, narrowRange, type MadeClass } from '../engine/rangeNarrowing';
import {
  type ChartPosition,
  type Range,
  RangeCharts,
  seatPositions,
} from '../engine/ranges';
import { BIG_BLIND, SMALL_BLIND, type Seat, type SeatAction, type Settings } from './types';

/**
 * Relative frequency of each flop hand type in the rotation.
 *
 * TUNABLE. Zero excludes a class entirely.
 */
export const HAND_MIX_WEIGHTS: Readonly<Record<MadeClass, number>> = Object.freeze({
  strongDraw: 3.0,
  weakDraw: 2.0,
  weakPair: 1.5,
  topPair: 1.2,
  overpair: 1.0,
  strong: 0.8,
  monster: 0.5,
  // Excluded: facing a bet with no pair and no draw is not a decision.
  nothing: 0,
});

const MAX_WEIGHT = Math.max(...Object.values(HAND_MIX_WEIGHTS));

/** Preflop raise size, in big blinds. */
const OPEN_TO = BIG_BLIND * 3;

/** Bet sizes an opponent may choose, as a fraction of the pot. */
const BET_FRACTIONS = [0.33, 0.5, 0.66, 0.75, 1.0] as const;

export interface OutsSpot {
  readonly seed: string;
  readonly heroCards: readonly CardCode[];
  readonly flop: readonly CardCode[];
  readonly turnCard: CardCode;
  readonly heroClass: MadeClass;
  readonly seats: readonly Seat[];
  readonly heroSeatIndex: number;
  readonly opponentSeatIndex: number;
  /** Pot before the opponent's flop bet. */
  readonly potAfterPreflop: number;
  /** Fraction of the pot the opponent bets, each street. */
  readonly betFraction: number;
  /** The opponent's preflop range, before any postflop narrowing. */
  readonly opponentPreflopRange: Range;
  readonly opponentChart: ChartPosition;
}

function describe(street: 'preflop' | 'flop' | 'turn', text: string): SeatAction {
  return { street, description: text };
}

/**
 * Builds an Outs-mode spot.
 *
 * Throws only if the settings make a spot impossible (fewer than two players),
 * which the settings screen prevents.
 */
export function buildOutsSpot(
  seed: string,
  settings: Settings,
  charts: RangeCharts,
  rng: Rng,
): OutsSpot {
  if (settings.playerCount < 2) {
    throw new Error('Outs mode needs at least two players; 1 is for equity drilling only');
  }

  const positions = seatPositions(settings.playerCount);

  // Hero's seat. The big blind cannot be the preflop caller in this
  // construction (someone must open before hero calls), so if hero is fixed to
  // the big blind the opener is simply an earlier seat, which still works.
  const heroSeatIndex = settings.fixedSeatIndex !== null
    ? Math.min(settings.fixedSeatIndex, positions.length - 1)
    : rng.nextInt(positions.length);

  // The opponent opens from a seat before hero where possible; otherwise from
  // the first seat that can open at all.
  const candidateOpeners = positions.filter(
    (seat) => seat.seatIndex !== heroSeatIndex && seat.chart !== 'BB',
  );
  const earlier = candidateOpeners.filter((seat) => seat.seatIndex < heroSeatIndex);
  const pool = earlier.length > 0 ? earlier : candidateOpeners;
  const opener = pool[rng.nextInt(pool.length)];
  if (opener === undefined) {
    throw new Error(`No seat can open at a ${settings.playerCount}-handed table`);
  }

  const betFraction = BET_FRACTIONS[rng.nextInt(BET_FRACTIONS.length)] as number;

  // Deal, rejecting hero hands the rotation does not want.
  let heroCards: CardCode[] = [];
  let flop: CardCode[] = [];
  let turnCard = 0;
  let heroClass: MadeClass = 'nothing';
  const MAX_ATTEMPTS = 400;
  let accepted = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !accepted; attempt++) {
    const deck = shuffledDeckCodes(rng);
    heroCards = deck.slice(0, 2);
    flop = deck.slice(2, 5);
    turnCard = deck[5] as CardCode;
    heroClass = classifyCombo(
      heroCards[0] as CardCode, heroCards[1] as CardCode, flop,
    ).madeClass;
    const weight = HAND_MIX_WEIGHTS[heroClass];
    if (weight <= 0) continue;
    if (rng.next() < weight / MAX_WEIGHT) accepted = true;
  }
  if (!accepted) {
    // Vanishingly unlikely; fall back to the last draw that was not pure air.
    heroClass = classifyCombo(
      heroCards[0] as CardCode, heroCards[1] as CardCode, flop,
    ).madeClass;
  }

  /* --- pot after preflop -------------------------------------------------
   * The opener raises, hero calls, everyone else folds. Blinds that are not
   * involved leave their posts behind as dead money. Kept deliberately simple:
   * the spec fixes stacks at 1000 and does not track money across hands, so the
   * only thing that has to be exact is the price hero is offered.
   */
  const heroPosition = positions[heroSeatIndex];
  if (heroPosition === undefined) throw new Error(`Invalid hero seat ${heroSeatIndex}`);
  let dead = 0;
  for (const seat of positions) {
    if (seat.seatIndex === heroSeatIndex || seat.seatIndex === opener.seatIndex) continue;
    if (seat.chart === 'SB') dead += SMALL_BLIND;
    if (seat.chart === 'BB') dead += BIG_BLIND;
  }
  const potAfterPreflop = OPEN_TO * 2 + dead;

  const seats: Seat[] = positions.map((seat) => {
    const isHero = seat.seatIndex === heroSeatIndex;
    const isOpener = seat.seatIndex === opener.seatIndex;
    const actions: SeatAction[] = [];
    if (isOpener) {
      actions.push(describe('preflop', `raised to ${OPEN_TO}`));
    } else if (isHero) {
      actions.push(describe('preflop', 'called'));
    } else {
      actions.push(describe('preflop', 'folded'));
    }
    return {
      seatIndex: seat.seatIndex,
      display: seat.display,
      chart: seat.chart,
      isHero,
      hasFolded: !isHero && !isOpener,
      actions,
    };
  });

  return {
    seed,
    heroCards,
    flop,
    turnCard,
    heroClass,
    seats,
    heroSeatIndex,
    opponentSeatIndex: opener.seatIndex,
    potAfterPreflop,
    betFraction,
    opponentPreflopRange: charts.rfi(opener.chart).removeCards(heroCards),
    opponentChart: opener.chart,
  };
}

/** The opponent's range on a street, given the bets they have made so far. */
export function opponentRangeOnStreet(
  spot: OutsSpot,
  street: 'flop' | 'turn',
): Range {
  const actions = street === 'flop'
    ? [{ action: 'bet' as const, board: spot.flop, betFraction: spot.betFraction }]
    : [
        { action: 'bet' as const, board: spot.flop, betFraction: spot.betFraction },
        {
          action: 'bet' as const,
          board: [...spot.flop, spot.turnCard],
          betFraction: spot.betFraction,
        },
      ];
  return narrowRange(spot.opponentPreflopRange, actions).range;
}

/** Pot and price hero faces on a street. */
export function priceOnStreet(spot: OutsSpot, street: 'flop' | 'turn'): {
  pot: number;
  toCall: number;
} {
  const flopBet = Math.round(spot.potAfterPreflop * spot.betFraction);
  if (street === 'flop') {
    return { pot: spot.potAfterPreflop + flopBet, toCall: flopBet };
  }
  // Hero called the flop bet, so both players put that in.
  const potOnTurn = spot.potAfterPreflop + flopBet * 2;
  const turnBet = Math.round(potOnTurn * spot.betFraction);
  return { pot: potOnTurn + turnBet, toCall: turnBet };
}

/** Adds the street's betting to the seat display. */
export function withStreetActions(
  seats: readonly Seat[],
  spot: OutsSpot,
  street: 'flop' | 'turn',
): Seat[] {
  const { toCall } = priceOnStreet(spot, street);
  return seats.map((seat) => {
    if (seat.seatIndex !== spot.opponentSeatIndex) {
      if (seat.seatIndex === spot.heroSeatIndex && street === 'turn') {
        return { ...seat, actions: [...seat.actions, describe('flop', 'called')] };
      }
      return seat;
    }
    return { ...seat, actions: [...seat.actions, describe(street, `bet ${toCall}`)] };
  });
}
