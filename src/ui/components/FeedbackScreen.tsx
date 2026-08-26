/**
 * The post-hand feedback screen.
 *
 * This is where the learning happens, so it is designed first and the table
 * layout follows it. Order is deliberate: the verdict, then the three answers
 * against truth side by side, then WHY the equity was what it was, then the
 * evidence (outs, the solver's rules, the opponent's actual range).
 *
 * Everything must read on an iPhone with no horizontal scrolling and no
 * pinching, which rules out wide tables — each answer is a row that wraps, and
 * the 13x13 grid sizes itself off the container rather than a fixed cell size.
 */
import type { Card } from '../../engine/deck';
import type { FieldGrade, HandGrade, HandTruth, InputField } from '../../game/types';
import { CardRow } from './PlayingCard';
import { RangeGrid } from './RangeGrid';

const FIELD_LABEL: Record<InputField, string> = {
  outs: 'Outs',
  hitProbability: 'Hit probability',
  equity: 'Equity',
  potOdds: 'Pot odds',
  action: 'Action',
};

function fmt(value: number | null, suffix: string): string {
  if (value === null) return '—';
  return `${Math.round(value * 10) / 10}${suffix}`;
}

/** One answered field: what you said, what it was, and by how much you missed. */
function AnswerRow({ label, grade, suffix }: {
  label: string;
  grade: FieldGrade;
  suffix: string;
}): JSX.Element {
  return (
    <div className={`answer ${grade.correct ? 'ok' : 'miss'}`}>
      <span className="answer-label">{label}</span>
      <span className="answer-values">
        <span className="answer-given">{fmt(grade.given, suffix)}</span>
        <span className="answer-arrow" aria-hidden="true">→</span>
        <span className="answer-truth">{fmt(grade.truth, suffix)}</span>
      </span>
      <span className="answer-verdict">
        {grade.correct ? '✓' : grade.error === null ? '✗' : (
          `${grade.error > 0 ? '+' : ''}${Math.round(grade.error * 10) / 10}`
        )}
      </span>
    </div>
  );
}

/** Where hero's equity came from: already ahead, versus improving. */
function EquitySplit({ truth }: { truth: HandTruth }): JSX.Element | null {
  const breakdown = truth.equity.breakdown;
  if (breakdown === null) return null;
  const total = Math.max(breakdown.asIs + breakdown.improved, 0.001);
  const asIsShare = (breakdown.asIs / total) * 100;
  return (
    <section className="split">
      <h3>Where the equity comes from</h3>
      <div className="split-bar" role="img" aria-label={
        `${Math.round(breakdown.asIs)}% already ahead, `
        + `${Math.round(breakdown.improved)}% from improving`
      }>
        <span className="split-asis" style={{ width: `${asIsShare}%` }} />
        <span className="split-improved" style={{ width: `${100 - asIsShare}%` }} />
      </div>
      <div className="split-legend">
        <span><i className="swatch asis" /> {fmt(breakdown.asIs, '%')} already ahead
          with {breakdown.currentCategory.toLowerCase()}</span>
        <span><i className="swatch improved" /> {fmt(breakdown.improved, '%')} from
          improving, which happens {Math.round(breakdown.improvementRate * 100)}% of the time</span>
      </div>
    </section>
  );
}

/** Every out, grouped by what it makes. */
function OutsList({ truth, missedCount }: {
  truth: HandTruth;
  missedCount: boolean;
}): JSX.Element | null {
  const hit = truth.hitProbability;
  if (hit === null || hit.outCards.length === 0) return null;
  const groups = new Map<string, Card[]>();
  for (const out of hit.outCards) {
    const list = groups.get(out.to);
    if (list) list.push(out.card);
    else groups.set(out.to, [out.card]);
  }
  return (
    <section className="outs-list">
      <h3>Your {hit.outs} outs</h3>
      <p className="hint">
        {missedCount
          ? 'Grouped by what each card makes. The count alone cannot say which '
            + 'ones you missed, so they are all here.'
          : 'Grouped by what each card makes.'}
      </p>
      {[...groups.entries()].map(([category, cards]) => (
        <div className="outs-group" key={category}>
          <span className="outs-group-label">{cards.length} to {category.toLowerCase()}</span>
          <CardRow cards={cards} size="small" />
        </div>
      ))}
    </section>
  );
}

/** How long each field took, so the time-trial range can be set from evidence. */
function Timings({ timings }: { timings: Partial<Record<InputField, number>> }): JSX.Element | null {
  const entries = (Object.keys(FIELD_LABEL) as InputField[])
    .filter((field) => timings[field] !== undefined)
    .map((field) => [field, timings[field] as number] as const);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  const slowest = Math.max(...entries.map(([, ms]) => ms));
  return (
    <section className="timings">
      <h3>Time per field</h3>
      <p className="hint">
        {(total / 1000).toFixed(1)}s total. The time trial was specced for three
        fields and there are now five — this is where the seconds actually go.
      </p>
      {entries.map(([field, ms]) => (
        <div className="timing-row" key={field}>
          <span className="timing-label">{FIELD_LABEL[field]}</span>
          <span className="timing-bar">
            <span style={{ width: `${(ms / slowest) * 100}%` }} />
          </span>
          <span className="timing-value">{(ms / 1000).toFixed(1)}s</span>
        </div>
      ))}
    </section>
  );
}

export function FeedbackScreen({ truth, grade, onNext, nextLabel }: {
  truth: HandTruth;
  grade: HandGrade;
  onNext: () => void;
  nextLabel: string;
}): JSX.Element {
  const opponent = truth.opponents[0];
  const weights = new Map(opponent?.handKeyWeights ?? []);

  return (
    <div className="feedback">
      <header className={`verdict ${grade.passed ? 'ok' : 'miss'}`}>
        <span className="verdict-mark" aria-hidden="true">{grade.passed ? '✓' : '✗'}</span>
        <span className="verdict-text">
          {grade.passed ? 'Correct' : 'Missed'}
          <small>{truth.street} · {truth.heroCategory}</small>
        </span>
      </header>

      <div className="hand-strip">
        <CardRow cards={truth.heroCards} label="You" />
        <CardRow cards={truth.board} label="Board" />
      </div>

      <section className="answers">
        <h3>Your answers</h3>
        {grade.outs !== null && (
          <AnswerRow label={FIELD_LABEL.outs} grade={grade.outs} suffix="" />
        )}
        {grade.hitProbability !== null && (
          <AnswerRow label={FIELD_LABEL.hitProbability} grade={grade.hitProbability} suffix="%" />
        )}
        {grade.equity !== null && (
          <AnswerRow label={FIELD_LABEL.equity} grade={grade.equity} suffix="%" />
        )}
        {grade.potOdds !== null && (
          <AnswerRow label={FIELD_LABEL.potOdds} grade={grade.potOdds} suffix="%" />
        )}
        <div className={`answer ${grade.action.correct ? 'ok' : 'miss'}`}>
          <span className="answer-label">{FIELD_LABEL.action}</span>
          <span className="answer-values">
            <span className="answer-given">{grade.action.given ?? '—'}</span>
            <span className="answer-arrow" aria-hidden="true">→</span>
            <span className="answer-truth">{grade.action.accepted.join(' / ')}</span>
          </span>
          <span className="answer-verdict">{grade.action.correct ? '✓' : '✗'}</span>
        </div>
      </section>

      {grade.diagnosis.length > 0 && (
        <section className="diagnosis">
          <h3>{grade.passed ? 'What you got right' : 'What went wrong'}</h3>
          {grade.diagnosis.map((line) => <p key={line}>{line}</p>)}
        </section>
      )}

      <EquitySplit truth={truth} />
      <OutsList truth={truth} missedCount={grade.outs !== null && !grade.outs.correct} />

      <section className="rules">
        <h3>Why {truth.action.best} is correct</h3>
        <ul>
          {truth.action.firedRules.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
        <p className="hint">
          Equity {fmt(truth.equity.percent, '%')} against the range below
          (±{truth.equity.standardError.toFixed(2)}pp over{' '}
          {truth.equity.iterations.toLocaleString()} runouts).
        </p>
      </section>

      <section className="range-section">
        <h3>What that equity was computed against</h3>
        <p className="hint">
          {opponent?.display} · {opponent?.label} · {opponent?.comboCount} combos,{' '}
          {opponent?.percentOfHands.toFixed(1)}% of hands. Partly-filled cells are
          hands the opponent holds only some of the time.
        </p>
        <RangeGrid weights={weights} />
      </section>

      <Timings timings={grade.timings} />

      <button type="button" className="primary" onClick={onNext}>{nextLabel}</button>
      <p className="seed">seed {truth.seed}</p>
    </div>
  );
}
