/**
 * The Outs-mode decision screen.
 *
 * Fields are asked ONE AT A TIME rather than as a form. Three reasons: it keeps
 * the tap target and the number pad in the same place on a phone, it stops a
 * later field's answer being revised after seeing an earlier one, and it makes
 * the per-field timing exact rather than inferred.
 *
 * Touch first throughout: numeric fields use inputMode="numeric" so iOS shows
 * the number pad, every step has a visible Next button rather than relying on
 * Enter, and the action buttons are a row of large targets.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ACTIONS, type ActionKind } from '../../engine/actionSolver';
import type { FieldTimings, HandInput, HandTruth, InputField } from '../../game/types';
import { CardRow } from './PlayingCard';

interface Step {
  readonly field: InputField;
  readonly question: string;
  readonly hint: string;
  readonly suffix: string;
}

function stepsFor(truth: HandTruth): Step[] {
  const steps: Step[] = [];
  if (truth.asksForOuts) {
    steps.push({
      field: 'outs',
      question: 'How many outs do you have?',
      hint: 'Every card that improves YOUR hand — not cards that improve the board.',
      suffix: '',
    });
  }
  if (truth.hitProbability !== null) {
    steps.push({
      field: 'hitProbability',
      question: `Chance of hitting, with ${truth.hitProbability.cardsToCome} card${
        truth.hitProbability.cardsToCome === 1 ? '' : 's'} to come?`,
      hint: 'Rule of 4 and 2, minus the excess over eight outs on the flop.',
      suffix: '%',
    });
  }
  steps.push({
    field: 'equity',
    question: 'Your equity against his range?',
    hint: 'How often you actually win — not how often you improve.',
    suffix: '%',
  });
  steps.push({
    field: 'potOdds',
    question: 'Pot odds?',
    hint: `${truth.toCall} to call into ${truth.pot}.`,
    suffix: '%',
  });
  steps.push({
    field: 'action',
    question: 'Your action?',
    hint: '',
    suffix: '',
  });
  return steps;
}

/** Which actions are legal given whether hero faces a bet. */
function legalActions(truth: HandTruth): ActionKind[] {
  return truth.toCall > 0
    ? ACTIONS.filter((a) => a === 'fold' || a === 'call' || a === 'raise')
    : ACTIONS.filter((a) => a === 'check' || a === 'bet' || a === 'fold');
}

export function OutsHandScreen({ truth, onSubmit }: {
  truth: HandTruth;
  onSubmit: (input: HandInput) => void;
}): JSX.Element {
  const steps = stepsFor(truth);
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Partial<Record<InputField, number>>>({});
  const [action, setAction] = useState<ActionKind | null>(null);
  const [discounted, setDiscounted] = useState(false);
  const [draft, setDraft] = useState('');
  const timings = useRef<FieldTimings>({});
  const stepStarted = useRef<number>(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const step = steps[stepIndex] as Step;

  useEffect(() => {
    stepStarted.current = Date.now();
    setDraft('');
    // Autofocus in sequence, but never steal focus for the action row, where
    // there is nothing to type.
    if (step.field !== 'action') inputRef.current?.focus();
  }, [stepIndex, step.field]);

  const recordTime = useCallback((field: InputField) => {
    timings.current = { ...timings.current, [field]: Date.now() - stepStarted.current };
  }, []);

  const advance = useCallback((collected: Partial<Record<InputField, number>>,
    chosen: ActionKind | null) => {
    if (stepIndex + 1 < steps.length) {
      setStepIndex(stepIndex + 1);
      return;
    }
    onSubmit({
      outs: collected.outs ?? null,
      discountedSoftOuts: discounted,
      timings: timings.current,
      hitProbability: collected.hitProbability ?? null,
      equity: collected.equity ?? null,
      potOdds: collected.potOdds ?? null,
      action: chosen,
      timedOut: false,
    });
  }, [stepIndex, steps.length, onSubmit, discounted]);

  const submitNumber = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) return;
    recordTime(step.field);
    const next = { ...values, [step.field]: parsed };
    setValues(next);
    advance(next, action);
  }, [draft, step.field, values, action, advance, recordTime]);

  const chooseAction = useCallback((chosen: ActionKind) => {
    recordTime('action');
    setAction(chosen);
    advance(values, chosen);
  }, [values, advance, recordTime]);

  return (
    <div className="hand">
      <header className="hand-head">
        <span className="street">{truth.street}</span>
        <span className="pot">pot {truth.pot} · {truth.toCall} to call</span>
      </header>

      <div className="table-strip">
        <CardRow cards={truth.board} label="Board" size="large" />
        <CardRow cards={truth.heroCards} label="You" size="large" />
      </div>

      <ul className="seats">
        {truth.seats.filter((seat) => !seat.hasFolded).map((seat) => (
          <li key={seat.seatIndex} className={seat.isHero ? 'hero' : ''}>
            <span className="seat-name">{seat.display}{seat.isHero ? ' (you)' : ''}</span>
            <span className="seat-actions">
              {seat.actions.map((a) => a.description).join(', ')}
            </span>
          </li>
        ))}
      </ul>

      <div className="progress" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
        {steps.map((s, i) => (
          <span key={s.field} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''} />
        ))}
      </div>

      <section className="ask">
        <h2>{step.question}</h2>
        {step.hint !== '' && <p className="hint">{step.hint}</p>}

        {step.field === 'action' ? (
          <div className="action-row">
            {legalActions(truth).map((option) => (
              <button
                key={option}
                type="button"
                className="action-button"
                onClick={() => chooseAction(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="number-field">
              <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={draft}
                onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(event) => { if (event.key === 'Enter') submitNumber(); }}
                aria-label={step.question}
              />
              {step.suffix !== '' && <span className="suffix">{step.suffix}</span>}
            </div>

            {step.field === 'outs' && (
              // Only hero knows whether a low count was a deliberate discount
              // or a miscount, and they are opposite lessons from the same
              // number. Asking is the only honest way to tell them apart.
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={discounted}
                  onChange={(event) => setDiscounted(event.target.checked)}
                />
                <span>I discounted soft outs</span>
              </label>
            )}

            <button
              type="button"
              className="primary"
              onClick={submitNumber}
              disabled={draft === ''}
            >
              {stepIndex + 1 === steps.length ? 'Submit' : 'Next'}
            </button>
          </>
        )}
      </section>

      {stepIndex > 0 && (
        <ul className="answered">
          {steps.slice(0, stepIndex).map((s) => (
            <li key={s.field}>
              {s.field}: <b>{values[s.field] ?? action}{s.suffix}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
