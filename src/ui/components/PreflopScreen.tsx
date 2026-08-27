/**
 * Preflop mode: hero's hand, their position, the action in front of them, and
 * one decision. No equity or pot-odds input — the correct action comes straight
 * from the charts, so those numbers would be asking about something the grading
 * does not use.
 */
import { ACTIONS, type ActionKind } from '../../engine/actionSolver';
import { cardFromCode } from '../../engine/deck';
import type { FacingAction, PreflopTruth } from '../../game/session';
import { CardRow } from './PlayingCard';

const FACING_TEXT: Record<FacingAction, string> = {
  foldedToHero: 'Folded to you',
  open: 'Opened in front of you',
  openWithCallers: 'Opened, with callers',
  threeBet: 'You raised, then got 3-bet',
};

export function PreflopScreen({ truth, secondsLeft, onAnswer }: {
  truth: PreflopTruth;
  secondsLeft: number | null;
  onAnswer: (action: ActionKind) => void;
}): JSX.Element {
  const hero = truth.seats[truth.heroSeatIndex];
  // Every seat with an action to its name, in seat order. The opener alone was
  // not enough: an "opened, with callers" spot showed no caller anywhere, and a
  // 3-bet spot did not show hero's own raise.
  const acted = truth.seats.filter(
    (seat) => !seat.isHero && seat.actions.some((a) => a.description !== 'folded'),
  );

  return (
    <div className="hand">
      <header className="hand-head">
        <span className="street">preflop</span>
        {secondsLeft !== null && (
          <span className={`clock ${secondsLeft <= 5 ? 'urgent' : ''}`}>
            {secondsLeft}s
          </span>
        )}
      </header>

      <div className="table-strip">
        <CardRow
          cards={truth.heroCardCodes.map(cardFromCode)}
          label="You"
          size="large"
        />
      </div>

      <ul className="seats">
        <li className="hero">
          <span className="seat-name">{hero?.display} (you)</span>
          <span className="seat-actions">{FACING_TEXT[truth.facing]}</span>
        </li>
        {acted.map((seat) => (
          <li key={seat.seatIndex}>
            <span className="seat-name">{seat.display}</span>
            <span className="seat-actions">
              {seat.actions.map((a) => a.description).join(', ')}
            </span>
          </li>
        ))}
      </ul>

      <section className="ask">
        <h2>Your action?</h2>
        <p className="hint">
          {truth.facing === 'foldedToHero'
            ? 'Nobody has entered the pot. Raise or fold — calling is never right here.'
            : 'Fold, call, or raise.'}
        </p>
        <div className="action-row">
          {ACTIONS.filter((a) => a === 'fold' || a === 'call' || a === 'raise')
            .map((option) => (
              <button
                key={option}
                type="button"
                className="action-button"
                onClick={() => onAnswer(option)}
              >
                {option}
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}
