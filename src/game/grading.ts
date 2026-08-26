/**
 * grading.ts — comparing hero's answers against frozen ground truth.
 *
 * `gradeHand` is a PURE function of `(truth, input)`. It reads the truth object
 * and the input and returns a verdict; it never computes equity, never touches
 * the RNG, and never mutates either argument. That is the guarantee the whole
 * app rests on: nothing hero types can influence what the correct answer was.
 *
 * The truth object is frozen before it ever reaches here (see `truth.ts`), so
 * an attempt to write to it is a TypeScript error at compile time and a no-op
 * or a throw at runtime.
 */

import feedbackTemplates from '../data/feedback.json';
import {
  EQUITY_TOLERANCE,
  HIT_PROBABILITY_TOLERANCE,
  OUTS_TOLERANCE,
  POT_ODDS_TOLERANCE,
  type ActionGrade,
  type FieldGrade,
  type HandGrade,
  type HandInput,
  type HandTruth,
  type MistakeCategory,
} from './types';

type TemplateBag = Record<string, string[]>;
const TEMPLATES = feedbackTemplates as unknown as TemplateBag;

/** Fills `{placeholders}` in a template with computed values. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}

/** Picks a template deterministically, so replaying a seed reads identically. */
function template(key: string, seed: string, values: Record<string, string | number>): string {
  const options = TEMPLATES[key];
  if (options === undefined || options.length === 0) return '';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return fill(options[hash % options.length] as string, values);
}

const round = (value: number, places = 1): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function gradeNumeric(
  given: number | null,
  truth: number,
  tolerance: number,
): FieldGrade {
  if (given === null) {
    return { correct: false, given: null, truth, error: null, tolerance };
  }
  const error = given - truth;
  return {
    correct: Math.abs(error) <= tolerance + 1e-9,
    given,
    truth,
    error,
    tolerance,
  };
}

/**
 * Grades the out count, which must be exactly right.
 *
 * Returns null when hero was not asked — either the board has no cards to come,
 * or the "count outs yourself" setting is off and the number was shown.
 */
function gradeOuts(truth: HandTruth, given: number | null): FieldGrade | null {
  if (!truth.asksForOuts || truth.hitProbability === null) return null;
  return gradeNumeric(given, truth.hitProbability.outs, OUTS_TOLERANCE);
}

/**
 * Grades the hit-probability answer against the exact probability.
 *
 * A single anchor and a single band. The adjusted rule of 4 and 2 that players
 * actually apply lands within 1.2pp of exact across 1-15 outs, so a 3pp band
 * accepts a correctly-applied shortcut without needing a second anchor — and
 * without the gap two narrow bands would leave between them.
 */
function gradeHitProbability(truth: HandTruth, given: number | null): FieldGrade | null {
  if (truth.hitProbability === null) return null;
  return gradeNumeric(given, truth.hitProbability.exact, HIT_PROBABILITY_TOLERANCE);
}

function gradeAction(truth: HandTruth, given: HandInput['action']): ActionGrade {
  return {
    correct: given !== null && truth.action.accepted.includes(given),
    given,
    best: truth.action.best,
    accepted: truth.action.accepted,
  };
}

/** How aggressive an action is, for classifying the direction of a mistake. */
const AGGRESSION: Record<string, number> = {
  fold: 0, check: 1, call: 2, bet: 3, raise: 4,
};

/**
 * Grades one decision point.
 *
 * Pure: same arguments always produce the same verdict, and neither argument is
 * modified.
 */
export function gradeHand(truth: HandTruth, input: HandInput): HandGrade {
  const mistakes: MistakeCategory[] = [];
  const diagnosis: string[] = [];

  if (input.timedOut) {
    mistakes.push('TIMEOUT');
    diagnosis.push(template('TIMEOUT', truth.seed, {}));
  }

  const outs = gradeOuts(truth, input.outs);
  const hitProbability = gradeHitProbability(truth, input.hitProbability);
  const equity = truth.street === 'preflop'
    ? null
    : gradeNumeric(input.equity, truth.equity.percent, EQUITY_TOLERANCE);
  const potOdds = truth.street === 'preflop'
    ? null
    : gradeNumeric(input.potOdds, truth.potOdds.percent, POT_ODDS_TOLERANCE);
  const action = gradeAction(truth, input.action);

  /* --- outs -------------------------------------------------------------- */
  if (outs !== null && !outs.correct && truth.hitProbability !== null) {
    mistakes.push('OUTS_MISCOUNT');
    const undercounted = outs.error !== null && outs.error < 0;
    // Whether a low count was a deliberate discount or a miscount is something
    // only hero knows, and the two are opposite lessons. The checkbox answers
    // it rather than the feedback guessing.
    const key = undercounted && input.discountedSoftOuts
      ? 'OUTS_DISCOUNTED'
      : undercounted
        ? 'OUTS_UNDERCOUNT'
        : 'OUTS_MISCOUNT';
    diagnosis.push(template(key, truth.seed, {
      given: outs.given === null ? '—' : outs.given,
      truth: truth.hitProbability.outs,
      difference: outs.error === null ? '—' : Math.abs(outs.error),
    }));
  }

  /* --- hit probability --------------------------------------------------- */
  if (hitProbability !== null && !hitProbability.correct && truth.hitProbability !== null) {
    mistakes.push('HIT_PROBABILITY');
    diagnosis.push(template('HIT_PROBABILITY', truth.seed, {
      given: hitProbability.given === null ? '—' : round(hitProbability.given),
      outs: truth.hitProbability.outs,
      exact: round(truth.hitProbability.exact),
      rule: round(truth.hitProbability.ruleOfThumb),
      street: truth.hitProbability.cardsToCome === 1
        ? 'one card to come'
        : 'two cards to come',
    }));
  }

  /* --- equity ------------------------------------------------------------ */
  if (equity !== null && !equity.correct) {
    const under = equity.error !== null && equity.error < 0;
    mistakes.push(under ? 'EQUITY_UNDER' : 'EQUITY_OVER');
    const breakdown = truth.equity.breakdown;
    diagnosis.push(template(under ? 'EQUITY_UNDER' : 'EQUITY_OVER', truth.seed, {
      given: equity.given === null ? '—' : round(equity.given),
      truth: round(equity.truth),
      gap: equity.error === null ? '—' : round(Math.abs(equity.error)),
      asIs: breakdown === null ? '0' : round(breakdown.asIs),
      improved: breakdown === null ? '0' : round(breakdown.improved),
      category: breakdown === null ? 'nothing' : breakdown.currentCategory,
    }));
    // The decomposition is the actual lesson: say where the equity came from.
    if (breakdown !== null) {
      diagnosis.push(template('EQUITY_SOURCE', truth.seed, {
        asIs: round(breakdown.asIs),
        improved: round(breakdown.improved),
        category: breakdown.currentCategory,
        improveRate: round(breakdown.improvementRate * 100),
      }));
    }
  }

  /* --- pot odds ---------------------------------------------------------- */
  if (potOdds !== null && !potOdds.correct) {
    mistakes.push('POT_ODDS_ARITHMETIC');
    diagnosis.push(template('POT_ODDS_ARITHMETIC', truth.seed, {
      given: potOdds.given === null ? '—' : round(potOdds.given),
      truth: round(potOdds.truth),
      call: truth.potOdds.callAmount,
      pot: truth.potOdds.potBeforeCall,
      total: truth.potOdds.callAmount + truth.potOdds.potBeforeCall,
    }));
  }

  /* --- action ------------------------------------------------------------ */
  if (!action.correct) {
    const given = action.given;
    const bestAggression = AGGRESSION[truth.action.best] ?? 0;
    const givenAggression = given === null ? -1 : (AGGRESSION[given] ?? 0);
    if (truth.action.best === 'fold' && given !== 'fold') {
      mistakes.push('ACTION_SHOULD_FOLD');
      diagnosis.push(template('ACTION_SHOULD_FOLD', truth.seed, {
        given: given ?? '—',
        equity: round(truth.equity.percent),
        potOdds: round(truth.potOdds.percent),
      }));
    } else if (givenAggression < bestAggression) {
      mistakes.push('ACTION_TOO_PASSIVE');
      diagnosis.push(template('ACTION_TOO_PASSIVE', truth.seed, {
        given: given ?? '—',
        best: truth.action.best,
        equity: round(truth.equity.percent),
        foldEquity: round(truth.action.foldEquity * 100),
      }));
    } else {
      mistakes.push('ACTION_TOO_AGGRESSIVE');
      diagnosis.push(template('ACTION_TOO_AGGRESSIVE', truth.seed, {
        given: given ?? '—',
        best: truth.action.best,
        equity: round(truth.equity.percent),
        foldEquity: round(truth.action.foldEquity * 100),
      }));
    }
  }

  const passed = !input.timedOut
    && (outs === null || outs.correct)
    && (hitProbability === null || hitProbability.correct)
    && (equity === null || equity.correct)
    && (potOdds === null || potOdds.correct)
    && action.correct;

  if (passed) diagnosis.push(template('CORRECT', truth.seed, {
    equity: round(truth.equity.percent),
    action: truth.action.best,
  }));

  return {
    passed,
    outs,
    hitProbability,
    equity,
    potOdds,
    action,
    mistakes,
    diagnosis: diagnosis.filter((line) => line.length > 0),
    firedRules: truth.action.firedRules,
    timings: input.timings,
  };
}
