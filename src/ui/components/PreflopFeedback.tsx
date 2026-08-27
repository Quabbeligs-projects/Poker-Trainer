/**
 * Preflop feedback.
 *
 * The chart carries the lesson: a verdict alone says nothing about the next
 * hand, whereas seeing where this hand sits on the range you are being graded
 * against transfers directly. Hero's hand is ringed on every chart shown.
 */
import { cardFromCode } from '../../engine/deck';
import type { PreflopGrade, PreflopTruth } from '../../game/session';
import { CardRow } from './PlayingCard';
import { RangeGrid } from './RangeGrid';

export function PreflopFeedback({ truth, grade, onNext }: {
  truth: PreflopTruth;
  grade: PreflopGrade;
  onNext: () => void;
}): JSX.Element {
  const hero = truth.seats[truth.heroSeatIndex];
  return (
    <div className="feedback">
      <header className={`verdict ${grade.passed ? 'ok' : 'miss'}`}>
        <span className="verdict-mark" aria-hidden="true">{grade.passed ? '✓' : '✗'}</span>
        <span className="verdict-text">
          {grade.passed ? 'Correct' : 'Missed'}
          <small>preflop · {hero?.display} · {truth.heroHandKey}</small>
        </span>
      </header>

      <div className="hand-strip">
        <CardRow cards={truth.heroCardCodes.map(cardFromCode)} label="You" />
      </div>

      <section className="answers">
        <h3>Your answer</h3>
        <div className={`answer ${grade.passed ? 'ok' : 'miss'}`}>
          <span className="answer-label">Action</span>
          <span className="answer-values">
            <span className="answer-given">{grade.given ?? '—'}</span>
            <span className="answer-arrow" aria-hidden="true">→</span>
            <span className="answer-truth">{grade.accepted.join(' / ')}</span>
          </span>
          <span className="answer-verdict">{grade.passed ? '✓' : '✗'}</span>
        </div>
      </section>

      <section className="rules">
        <h3>Why</h3>
        <ul>
          {grade.firedRules.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </section>

      {truth.ranges.filter((range) => range.percentOfHands > 0).map((range) => (
        <section className="range-section" key={`${range.action}:${range.label}`}>
          <h3>{range.label}</h3>
          <p className="hint">
            {range.percentOfHands.toFixed(1)}% of hands · your {truth.heroHandKey} is
            ringed
          </p>
          <RangeGrid
            weights={new Map(range.handKeyWeights)}
            highlight={truth.heroHandKey}
          />
        </section>
      ))}

      <button type="button" className="primary" onClick={onNext}>Next hand</button>
      <p className="seed">seed {truth.seed}</p>
    </div>
  );
}
