import { describe, expect, it } from 'vitest';

import rangesJson from '../src/data/ranges.json';
import { RangeCharts, type RangeChartsJson } from '../src/engine/ranges';
import { createRng } from '../src/engine/deck';
import { classifyCombo } from '../src/engine/rangeNarrowing';
import { OutsHand, buildPreflopHand, gradePreflop, solvePreflop } from '../src/game/session';
import { gradeHand } from '../src/game/grading';
import {
  buildOutsSpot,
  HAND_MIX_WEIGHTS,
  MAX_FLOP_OUTS,
  MAX_TURN_OUTS,
  priceOnStreet,
} from '../src/game/spot';
import { countOuts } from '../src/engine/outs';
import {
  DEFAULT_SETTINGS,
  EQUITY_BANDS,
  acceptableBands,
  bandOf,
  HIT_PROBABILITY_TOLERANCE,
  POT_ODDS_TOLERANCE,
  type HandInput,
  type Settings,
  timeTrialChoices,
} from '../src/game/types';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const settings: Settings = { ...DEFAULT_SETTINGS, playerCount: 6 };
/** Fewer iterations keeps the suite fast; accuracy is covered by equity tests. */
const ITER = 20_000;

const perfect = (hand: OutsHand): HandInput => {
  const truth = hand.current.truth!;
  return {
    outs: truth.hitProbability?.outs ?? null,
    discountedSoftOuts: false,
    timings: {},
    hitProbability: truth.hitProbability?.exact ?? null,
    equityBand: bandOf(truth.equity.percent),
    potOdds: truth.potOdds.percent,
    action: truth.action.best,
    timedOut: false,
  };
};

describe('ground truth is frozen before the hand is shown', () => {
  it('deep-freezes every part of the truth object', () => {
    const truth = new OutsHand('freeze-me', settings, charts, ITER).current.truth!;
    expect(Object.isFrozen(truth)).toBe(true);
    expect(Object.isFrozen(truth.equity)).toBe(true);
    expect(Object.isFrozen(truth.action)).toBe(true);
    expect(Object.isFrozen(truth.seats)).toBe(true);
    expect(Object.isFrozen(truth.heroCards)).toBe(true);
    if (truth.equity.breakdown !== null) {
      expect(Object.isFrozen(truth.equity.breakdown)).toBe(true);
    }
  });

  it('throws rather than silently accepting a write', () => {
    const truth = new OutsHand('immutable', settings, charts, ITER).current.truth!;
    // Modules are strict mode, so writing to a frozen object throws.
    expect(() => {
      (truth as unknown as { pot: number }).pot = 999999;
    }).toThrow(TypeError);
    expect(() => {
      (truth.equity as unknown as { percent: number }).percent = 0;
    }).toThrow(TypeError);
  });

  it('is not changed by grading, whatever the input', () => {
    const hand = new OutsHand('unchanged', settings, charts, ITER);
    const truth = hand.current.truth!;
    const before = JSON.stringify(truth);
    for (const equity of [0, 50, 100, -10, 1e9]) {
      gradeHand(truth, {
        outs: equity,
      discountedSoftOuts: false, timings: {},
        hitProbability: equity, equityBand: 'even', potOdds: equity,
        action: 'raise', timedOut: false,
      });
    }
    expect(JSON.stringify(truth)).toBe(before);
  });

  it('grades identically however many times it is called', () => {
    const hand = new OutsHand('pure', settings, charts, ITER);
    const truth = hand.current.truth!;
    const input: HandInput = {
      outs: 9, hitProbability: 30, equityBand: 'even', potOdds: 25, action: 'call', timedOut: false,
      discountedSoftOuts: false, timings: {},
    };
    const first = JSON.stringify(gradeHand(truth, input));
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(gradeHand(truth, input))).toBe(first);
    }
  });
});

describe('a stale render can never be graded', () => {
  it('refuses answers belonging to a different hand', () => {
    // The bug this prevents: a screen rendered hand A while hand B was pending,
    // so answers correct for what was on screen were graded against a hand the
    // player never saw. The same seed appeared to produce two different truths.
    const handA = new OutsHand('stale-a', settings, charts, 2_000);
    const handB = new OutsHand('stale-b', settings, charts, 2_000);
    const staleTruth = handA.current.truth!;
    expect(() => handB.submit({
      outs: 1, discountedSoftOuts: false, timings: {},
      hitProbability: 1, equityBand: 'even', potOdds: 1,
      action: 'fold', timedOut: false,
    }, staleTruth)).toThrow(/different hand|stale/i);
  });

  it('accepts the truth it is currently showing', () => {
    const hand = new OutsHand('fresh', settings, charts, 2_000);
    const truth = hand.current.truth!;
    expect(() => hand.submit(perfect(hand), truth)).not.toThrow();
  });

  it('builds byte-identical truth for a seed, however many times', () => {
    // Determinism is the property the whole app rests on, so it is asserted on
    // the seed the report came from, not only on a synthetic one.
    const build = () => JSON.stringify(
      new OutsHand('J83CK9QYHS', settings, charts, 20_000).current.truth,
    );
    const first = build();
    for (let i = 0; i < 3; i++) expect(build()).toBe(first);
  });
});

describe('Outs mode', () => {
  it('always presents hero with a real price', () => {
    for (let i = 0; i < 25; i++) {
      const truth = new OutsHand(`price-${i}`, settings, charts, 2_000).current.truth!;
      expect(truth.toCall).toBeGreaterThan(0);
      expect(truth.pot).toBeGreaterThan(truth.toCall);
      expect(truth.potOdds.percent).toBeGreaterThan(0);
      expect(truth.potOdds.percent).toBeLessThan(50);
    }
  });

  it('starts on the flop with three board cards', () => {
    const truth = new OutsHand('flop-start', settings, charts, ITER).current.truth!;
    expect(truth.street).toBe('flop');
    expect(truth.board).toHaveLength(3);
    expect(truth.hitProbability).not.toBeNull();
    expect(truth.equity.breakdown).not.toBeNull();
  });

  it('advances to the turn when the flop is answered correctly', () => {
    const hand = new OutsHand('advance', settings, charts, ITER);
    const input = perfect(hand);
    // Force a non-fold so the hand continues.
    const action = hand.current.truth!.action.accepted.find((a) => a !== 'fold')
      ?? hand.current.truth!.action.best;
    const { grade, state } = hand.submit({ ...input, action }, hand.current.truth!);
    if (action === 'fold') return; // covered by the fold test
    expect(grade.passed).toBe(true);
    expect(state.phase).toBe('turn');
    expect(state.truth!.board).toHaveLength(4);
    expect(state.truth!.hitProbability!.cardsToCome).toBe(1);
  });

  it('ends the hand as a win on a correct fold, without dealing the turn', () => {
    // Find a seed where folding is correct.
    for (let i = 0; i < 60; i++) {
      const hand = new OutsHand(`fold-${i}`, settings, charts, 5_000);
      if (hand.current.truth!.action.best !== 'fold') continue;
      const { grade, state } = hand.submit({ ...perfect(hand), action: 'fold' }, hand.current.truth!);
      expect(grade.passed).toBe(true);
      expect(state.phase).toBe('won');
      expect(state.outcome).toBe('won');
      expect(state.outcomeReason).toMatch(/fold/);
      return;
    }
    throw new Error('No seed produced a correct fold; the spot mix may be wrong');
  });

  it('returns the ADVANCED state from submit, not the answered one', () => {
    // The trap that produced a real UI bug: feedback rendered from the returned
    // state described the turn while showing the flop's answers. Callers must
    // capture the truth they are grading BEFORE submitting.
    const hand = new OutsHand('advanced-state', settings, charts, ITER);
    const answered = hand.current.truth!;
    const action = answered.action.accepted.find((a) => a !== 'fold') ?? answered.action.best;
    if (action === 'fold') return;
    const { state } = hand.submit({ ...perfect(hand), action }, hand.current.truth!);
    if (state.phase !== 'turn') return;
    expect(state.truth).not.toBe(answered);
    expect(state.truth!.board).toHaveLength(4);
    expect(answered.board).toHaveLength(3);
  });

  it('ends the hand as a loss on any wrong answer', () => {
    const hand = new OutsHand('lose', settings, charts, ITER);
    const { grade, state } = hand.submit({
      ...perfect(hand), equityBand: 'wayAhead',
    }, hand.current.truth!);
    expect(grade.passed).toBe(false);
    expect(state.phase).toBe('lost');
    expect(state.outcome).toBe('lost');
  });

  it('counts a timeout as a loss regardless of the answers', () => {
    const hand = new OutsHand('timeout', settings, charts, ITER);
    const { grade, state } = hand.submit({ ...perfect(hand), timedOut: true }, hand.current.truth!);
    expect(grade.passed).toBe(false);
    expect(grade.mistakes).toContain('TIMEOUT');
    expect(state.outcome).toBe('lost');
  });

  it('refuses further input once the hand is over', () => {
    const hand = new OutsHand('over', settings, charts, ITER);
    const truthBefore = hand.current.truth!;
    hand.submit({ ...perfect(hand), equityBand: 'wayBehind' }, hand.current.truth!);
    expect(() => hand.submit(perfect(hand), truthBefore)).toThrow(/already over/);
  });

  it('replays a seed exactly', () => {
    const a = new OutsHand('replay-me', settings, charts, ITER).current.truth!;
    const b = new OutsHand('replay-me', settings, charts, ITER).current.truth!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('gives different seeds different hands', () => {
    const a = new OutsHand('seed-a', settings, charts, 2_000).current.truth!;
    const b = new OutsHand('seed-b', settings, charts, 2_000).current.truth!;
    expect(JSON.stringify(a.heroCards)).not.toBe(JSON.stringify(b.heroCards));
  });
});

describe('the hand mix', () => {
  it('never deals pure air, and leans toward draws', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const spot = buildOutsSpot(`mix-${i}`, settings, charts, createRng(`mix-${i}`));
      counts.set(spot.heroClass, (counts.get(spot.heroClass) ?? 0) + 1);
    }
    expect(counts.get('nothing') ?? 0).toBe(0);
    const draws = (counts.get('strongDraw') ?? 0) + (counts.get('weakDraw') ?? 0);
    const made = (counts.get('monster') ?? 0) + (counts.get('strong') ?? 0);
    expect(draws).toBeGreaterThan(made);
    // Made hands are still present: they are the clearest demonstration that
    // counting outs and estimating equity are different questions.
    expect(made).toBeGreaterThan(0);
  });

  it('agrees with the classifier about what it dealt', () => {
    for (let i = 0; i < 30; i++) {
      const spot = buildOutsSpot(`agree-${i}`, settings, charts, createRng(`agree-${i}`));
      expect(classifyCombo(spot.heroCards[0]!, spot.heroCards[1]!, spot.flop).madeClass)
        .toBe(spot.heroClass);
    }
  });

  it('excludes exactly the classes weighted at zero', () => {
    for (const [handClass, weight] of Object.entries(HAND_MIX_WEIGHTS)) {
      if (weight === 0) expect(handClass).toBe('nothing');
    }
  });

  it('prices the turn from a pot that includes the called flop bet', () => {
    const spot = buildOutsSpot('pricing', settings, charts, createRng('pricing'));
    const flop = priceOnStreet(spot, 'flop');
    const turn = priceOnStreet(spot, 'turn');
    expect(turn.pot).toBeGreaterThan(flop.pot);
    expect(turn.pot - turn.toCall).toBe(spot.potAfterPreflop + flop.toCall * 2);
  });
});

describe('out-count caps', () => {
  it('never deals a spot beyond the caps, on either street', () => {
    // Past these counts the adjusted shortcut breaches the +/-3pp band, so a
    // correctly-applied estimate could be graded wrong. They are also poor
    // drills: a 22-out turn count is mostly soft outs.
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const spot = buildOutsSpot(`cap-${i}`, settings, charts, createRng(`cap-${i}`));
      const flopOuts = countOuts(spot.heroCards, spot.flop).total;
      const turnOuts = countOuts(spot.heroCards, [...spot.flop, spot.turnCard]).total;
      expect(flopOuts, `flop outs on spot ${i}`).toBeLessThanOrEqual(MAX_FLOP_OUTS);
      expect(turnOuts, `turn outs on spot ${i}`).toBeLessThanOrEqual(MAX_TURN_OUTS);
      checked++;
    }
    expect(checked).toBe(400);
  });

  it('keeps every dealt spot inside the grading band', () => {
    // The caps exist to make this true, so assert the consequence directly
    // rather than only the mechanism.
    for (let i = 0; i < 120; i++) {
      const hand = new OutsHand(`band-${i}`, settings, charts, 2_000);
      const truth = hand.current.truth!;
      const { exact, ruleOfThumb } = truth.hitProbability!;
      expect(
        Math.abs(ruleOfThumb - exact),
        `${truth.hitProbability!.outs} outs on the ${truth.street}`,
      ).toBeLessThanOrEqual(HIT_PROBABILITY_TOLERANCE);
    }
  });

  it('still deals plenty of draws after capping', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const spot = buildOutsSpot(`post-cap-${i}`, settings, charts, createRng(`post-cap-${i}`));
      counts.set(spot.heroClass, (counts.get(spot.heroClass) ?? 0) + 1);
    }
    const draws = (counts.get('strongDraw') ?? 0) + (counts.get('weakDraw') ?? 0);
    expect(draws / 300).toBeGreaterThan(0.25);
  });
});

describe('counting outs yourself', () => {
  const withOuts = { ...settings, countOutsYourself: true };
  const withoutOuts = { ...settings, countOutsYourself: false };

  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.countOutsYourself).toBe(true);
  });

  it('asks for the count when the setting is on', () => {
    const truth = new OutsHand('asks', withOuts, charts, ITER).current.truth!;
    expect(truth.asksForOuts).toBe(true);
  });

  it('does not ask when the setting is off', () => {
    const truth = new OutsHand('asks-not', withoutOuts, charts, ITER).current.truth!;
    expect(truth.asksForOuts).toBe(false);
    const grade = gradeHand(truth, {
      outs: null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
    expect(grade.outs).toBeNull();
    expect(grade.passed).toBe(true);
  });

  it('grades the count exactly, with no tolerance', () => {
    const truth = new OutsHand('exact-outs', withOuts, charts, ITER).current.truth!;
    const actual = truth.hitProbability!.outs;
    const grade = (given: number) => gradeHand(truth, {
      outs: given,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
    expect(grade(actual).outs!.correct).toBe(true);
    expect(grade(actual + 1).outs!.correct).toBe(false);
    expect(grade(actual - 1).outs!.correct).toBe(false);
  });

  const undercount = (seed: string, discounted: boolean) => {
    const truth = new OutsHand(seed, withOuts, charts, ITER).current.truth!;
    return gradeHand(truth, {
      outs: Math.max(0, truth.hitProbability!.outs - 3),
      discountedSoftOuts: discounted,
      timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
  };

  it('treats a ticked discount as a misplaced judgement, not a miscount', () => {
    const grade = undercount('discount', true);
    expect(grade.mistakes).toContain('OUTS_MISCOUNT');
    expect(grade.diagnosis.join(' ')).toMatch(/soft|equity (estimate|answer|field)/i);
  });

  it('treats an unticked undercount as a miscount and points at the list', () => {
    // Same number entered, opposite lesson. Only hero knows which it was, so
    // the checkbox decides rather than the feedback guessing.
    const grade = undercount('discount', false);
    expect(grade.mistakes).toContain('OUTS_MISCOUNT');
    expect(grade.diagnosis.join(' ')).toMatch(/short|listed below|full list/i);
    expect(grade.diagnosis.join(' ')).not.toMatch(/discount/i);
  });

  it('exposes every out so the feedback can show what was missed', () => {
    // The count alone cannot identify WHICH outs hero missed, so the truth
    // object carries them all and the screen groups them.
    const truth = new OutsHand('outcards', withOuts, charts, ITER).current.truth!;
    expect(truth.hitProbability!.outCards).toHaveLength(truth.hitProbability!.outs);
    for (const out of truth.hitProbability!.outCards) {
      expect(out.card.rank).toBeTruthy();
      expect(out.to).toBeTruthy();
    }
  });

  it('says something different when hero overcounts', () => {
    const truth = new OutsHand('overcount', withOuts, charts, ITER).current.truth!;
    const grade = gradeHand(truth, {
      outs: truth.hitProbability!.outs + 4,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
    expect(grade.mistakes).toContain('OUTS_MISCOUNT');
    expect(grade.diagnosis.join(' ')).toMatch(/too many|over the actual/i);
  });

  it('fails the hand on a wrong count even when everything else is right', () => {
    const hand = new OutsHand('outs-fail', withOuts, charts, ITER);
    const truth = hand.current.truth!;
    const { grade } = hand.submit({
      outs: truth.hitProbability!.outs + 2,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    }, truth);
    expect(grade.passed).toBe(false);
    expect(grade.outs!.correct).toBe(false);
    expect(grade.equity!.correct).toBe(true);
  });
});

describe('grading', () => {
  const truthFor = (seed: string) => new OutsHand(seed, settings, charts, ITER).current.truth!;

  it('accepts an answer inside every tolerance', () => {
    const truth = truthFor('tolerant');
    const grade = gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact + HIT_PROBABILITY_TOLERANCE - 0.01,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent + POT_ODDS_TOLERANCE - 0.01,
      action: truth.action.best,
      timedOut: false,
    });
    expect(grade.passed).toBe(true);
  });

  it('rejects an answer just outside a tolerance', () => {
    const truth = truthFor('intolerant');
    const grade = gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: 'wayAhead',
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
    expect(grade.passed).toBe(false);
    expect(grade.mistakes).toContain('EQUITY_OVER');
  });

  it('grades hit probability against a single band around the exact value', () => {
    const truth = truthFor('anchors');
    const { exact } = truth.hitProbability!;
    const grade = (answer: number) => gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: answer,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    }).hitProbability!;
    expect(grade(exact).correct).toBe(true);
    expect(grade(exact + HIT_PROBABILITY_TOLERANCE - 0.01).correct).toBe(true);
    expect(grade(exact - HIT_PROBABILITY_TOLERANCE + 0.01).correct).toBe(true);
    expect(grade(exact + HIT_PROBABILITY_TOLERANCE + 0.5).correct).toBe(false);
    expect(grade(exact - HIT_PROBABILITY_TOLERANCE - 0.5).correct).toBe(false);
  });

  it('accepts a correctly applied shortcut, which is the point of the band', () => {
    const truth = truthFor('shortcut');
    const grade = gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.ruleOfThumb,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
    // Only guaranteed where the shortcut is defined to be accurate; the turn
    // above 17 outs is a documented exception.
    const { outs, cardsToCome } = truth.hitProbability!;
    if (cardsToCome === 2 || outs <= 15) {
      expect(grade.hitProbability!.correct).toBe(true);
    }
  });

  it('leaves no gap: the accepted set is one contiguous interval', () => {
    // The earlier two-anchor scheme accepted 49-53 and 54-58 at 14 outs, so
    // 53.5 failed while 53 and 54 both passed. A value between two accepted
    // answers must never be graded wrong.
    const truth = truthFor('no-gap');
    const accepted: number[] = [];
    for (let answer = 0; answer <= 100; answer += 0.25) {
      const correct = gradeHand(truth, {
        outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
        hitProbability: answer,
        equityBand: bandOf(truth.equity.percent),
        potOdds: truth.potOdds.percent,
        action: truth.action.best,
        timedOut: false,
      }).hitProbability!.correct;
      if (correct) accepted.push(answer);
    }
    expect(accepted.length).toBeGreaterThan(0);
    for (let i = 1; i < accepted.length; i++) {
      expect(accepted[i]! - accepted[i - 1]!).toBeCloseTo(0.25, 9);
    }
  });

  it('rejects a hit probability well outside the band', () => {
    const truth = truthFor('anchors-miss');
    const grade = gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact + 20,
      equityBand: bandOf(truth.equity.percent),
      potOdds: truth.potOdds.percent,
      action: truth.action.best,
      timedOut: false,
    });
    expect(grade.hitProbability!.correct).toBe(false);
    expect(grade.mistakes).toContain('HIT_PROBABILITY');
  });

  it('names the direction of an equity miss', () => {
    const truth = truthFor('direction');
    const under = gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: 'wayBehind',
      potOdds: truth.potOdds.percent, action: truth.action.best, timedOut: false,
    });
    expect(under.mistakes).toContain('EQUITY_UNDER');
    const over = gradeHand(truth, {
      outs: truth.hitProbability?.outs ?? null,
      discountedSoftOuts: false, timings: {},
      hitProbability: truth.hitProbability!.exact,
      equityBand: 'wayAhead',
      potOdds: truth.potOdds.percent, action: truth.action.best, timedOut: false,
    });
    expect(over.mistakes).toContain('EQUITY_OVER');
  });

  it('produces a populated diagnosis and the solver rules verbatim', () => {
    const truth = truthFor('diagnosis');
    const grade = gradeHand(truth, {
      outs: 0, hitProbability: 0, equityBand: 'even', potOdds: 0, action: 'raise', timedOut: false,
      discountedSoftOuts: false, timings: {},
    });
    expect(grade.diagnosis.length).toBeGreaterThan(0);
    for (const line of grade.diagnosis) {
      expect(line).not.toMatch(/\{|\}/); // every placeholder was filled
      expect(line.length).toBeGreaterThan(10);
    }
    expect(grade.firedRules).toEqual(truth.action.firedRules);
  });

  it('reports every field side by side, answered or not', () => {
    const truth = truthFor('side-by-side');
    const grade = gradeHand(truth, {
      outs: null, hitProbability: null, equityBand: null, potOdds: null, action: null,
      discountedSoftOuts: false, timings: {},
      timedOut: false,
    });
    expect(grade.equity!.given).toBeNull();
    expect(grade.equity!.truthPercent).toBeCloseTo(truth.equity.percent, 9);
    expect(grade.potOdds!.correct).toBe(false);
    expect(grade.action.correct).toBe(false);
  });
});

describe('Preflop mode', () => {
  it('raises a premium hand when folded to hero', () => {
    const result = solvePreflop(
      charts, settings, 0, [51, 47], 'foldedToHero', null,
    ); // As Ah
    expect(result.accepted).toContain('raise');
    expect(result.rules.join(' ')).toMatch(/opening range/);
  });

  it('folds trash when folded to hero, never calls', () => {
    // 7s 2h — the worst hand, not in any opening range.
    const codes = [20 + 0, 0 + 1];
    const result = solvePreflop(charts, settings, 0, codes, 'foldedToHero', null);
    expect(result.accepted).toEqual(['fold']);
    expect(result.accepted).not.toContain('call');
  });

  it('builds a hand whose truth is frozen', () => {
    const truth = buildPreflopHand('pf-frozen', settings, charts);
    expect(Object.isFrozen(truth)).toBe(true);
    expect(() => {
      (truth as unknown as { best: string }).best = 'fold';
    }).toThrow(TypeError);
  });

  it('always offers at least one accepted action', () => {
    for (let i = 0; i < 60; i++) {
      const truth = buildPreflopHand(`pf-${i}`, settings, charts);
      expect(truth.accepted.length).toBeGreaterThan(0);
      expect(truth.accepted).toContain(truth.best);
      expect(truth.firedRules.length).toBeGreaterThan(0);
    }
  });

  it('grades against the accepted set', () => {
    const truth = buildPreflopHand('pf-grade', settings, charts);
    expect(gradePreflop(truth, truth.best, false).passed).toBe(true);
    const wrong = (['fold', 'call', 'raise'] as const)
      .find((a) => !truth.accepted.includes(a));
    if (wrong !== undefined) {
      const grade = gradePreflop(truth, wrong, false);
      expect(grade.passed).toBe(false);
      expect(grade.mistakes.length).toBeGreaterThan(0);
    }
  });

  it('counts a timeout as a loss', () => {
    const truth = buildPreflopHand('pf-timeout', settings, charts);
    const grade = gradePreflop(truth, truth.best, true);
    expect(grade.passed).toBe(false);
    expect(grade.mistakes).toContain('TIMEOUT');
  });

  it('replays a seed exactly', () => {
    const a = buildPreflopHand('pf-replay', settings, charts);
    const b = buildPreflopHand('pf-replay', settings, charts);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('equity bands', () => {
  it('maps a percentage to the band it falls in', () => {
    expect(bandOf(10)).toBe('wayBehind');
    expect(bandOf(24.9)).toBe('wayBehind');
    expect(bandOf(25)).toBe('behind');
    expect(bandOf(39.9)).toBe('behind');
    expect(bandOf(40)).toBe('even');
    expect(bandOf(59.9)).toBe('even');
    expect(bandOf(60)).toBe('ahead');
    expect(bandOf(79.9)).toBe('ahead');
    expect(bandOf(80)).toBe('wayAhead');
    expect(bandOf(100)).toBe('wayAhead');
  });

  it('covers 0 to 100 with no gap and no overlap', () => {
    for (let percent = 0; percent <= 100; percent += 0.1) {
      const band = EQUITY_BANDS.find((b) => b.id === bandOf(percent))!;
      expect(percent).toBeGreaterThanOrEqual(band.min);
      expect(percent).toBeLessThanOrEqual(band.max);
    }
  });

  it('accepts either side at a boundary, so a tenth of a point cannot fail', () => {
    // The knife-edge problem that sank the two-anchor hit-probability scheme,
    // moved to band edges. 40.1% must not fail an answer of "behind".
    expect(acceptableBands(40.1)).toContain('behind');
    expect(acceptableBands(40.1)).toContain('even');
    expect(acceptableBands(59.5)).toContain('even');
    expect(acceptableBands(59.5)).toContain('ahead');
    // Away from a boundary only one band is right.
    expect(acceptableBands(50)).toEqual(['even']);
    expect(acceptableBands(10)).toEqual(['wayBehind']);
  });

  it('grades the judgement, not the number', () => {
    const truth = new OutsHand('band-grade', settings, charts, ITER).current.truth!;
    const right = bandOf(truth.equity.percent);
    const wrong = right === 'wayAhead' ? 'wayBehind' : 'wayAhead';
    const grade = (given: typeof right) => gradeHand(truth, {
      ...perfect(new OutsHand('band-grade', settings, charts, ITER)),
      equityBand: given,
    }).equity!;
    expect(grade(right).correct).toBe(true);
    expect(grade(wrong).correct).toBe(false);
    expect(grade(right).truthPercent).toBeCloseTo(truth.equity.percent, 9);
  });
});

describe('settings', () => {
  it('offers 5:00 down to 0:15 in 15-second steps', () => {
    const choices = timeTrialChoices();
    expect(choices[0]).toBe(300);
    expect(choices[choices.length - 1]).toBe(15);
    for (let i = 1; i < choices.length; i++) {
      expect(choices[i - 1]! - choices[i]!).toBe(15);
    }
  });

  it('defaults to the timer off and a random seat', () => {
    expect(DEFAULT_SETTINGS.timePerHandSeconds).toBeNull();
    expect(DEFAULT_SETTINGS.fixedSeatIndex).toBeNull();
  });

  it('honours a fixed seat and randomises otherwise', () => {
    const fixed: Settings = { ...settings, fixedSeatIndex: 2 };
    for (let i = 0; i < 10; i++) {
      expect(new OutsHand(`fixed-${i}`, fixed, charts, 2_000).current.truth!.heroSeatIndex)
        .toBe(2);
    }
    const seatsSeen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      seatsSeen.add(new OutsHand(`rand-${i}`, settings, charts, 2_000).current.truth!.heroSeatIndex);
    }
    expect(seatsSeen.size).toBeGreaterThan(1);
  });

  it('works at every legal table size', () => {
    for (let players = 2; players <= 10; players++) {
      const truth = new OutsHand(`size-${players}`, { ...settings, playerCount: players },
        charts, 2_000).current.truth!;
      expect(truth.seats).toHaveLength(players);
      expect(truth.toCall).toBeGreaterThan(0);
    }
  });

  it('rejects Outs mode with a single player', () => {
    expect(() => new OutsHand('solo', { ...settings, playerCount: 1 }, charts, 2_000))
      .toThrow(/at least two players/);
  });
});
