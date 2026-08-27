/**
 * The settings screen, shown before entering either mode.
 *
 * Options that only matter when something else is on stay hidden until it is —
 * the time-trial length and the fixed seat both appear on demand — so the
 * default screen stays short enough to read on a phone without scrolling past
 * things that do not apply.
 */
import { useState } from 'react';

import { seatPositions } from '../../engine/ranges';
import {
  DEFAULT_SETTINGS,
  STARTING_STACK,
  type Settings,
  timeTrialChoices,
} from '../../game/types';

export type Mode = 'outs' | 'preflop';

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function SettingsScreen({ initial, onStart }: {
  initial?: Settings;
  onStart: (settings: Settings, mode: Mode) => void;
}): JSX.Element {
  const [settings, setSettings] = useState<Settings>(initial ?? DEFAULT_SETTINGS);
  const patch = (change: Partial<Settings>) =>
    setSettings((current) => ({ ...current, ...change }));

  const seats = seatPositions(settings.playerCount);
  const timerOn = settings.timePerHandSeconds !== null;
  const seatFixed = settings.fixedSeatIndex !== null;

  return (
    <div className="settings">
      <header>
        <h1>Poker Equity Trainer</h1>
        <p className="lede">Offline. Every hand replayable from its seed.</p>
      </header>

      <section>
        <h2>Time trial</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={timerOn}
            onChange={(event) =>
              patch({ timePerHandSeconds: event.target.checked ? 60 : null })}
          />
          <span>Limit time per hand</span>
        </label>
        {timerOn && (
          <label className="field">
            <span className="field-label">Seconds per hand</span>
            <select
              value={settings.timePerHandSeconds ?? 60}
              onChange={(event) =>
                patch({ timePerHandSeconds: Number(event.target.value) })}
            >
              {timeTrialChoices().map((seconds) => (
                <option key={seconds} value={seconds}>{formatSeconds(seconds)}</option>
              ))}
            </select>
            <span className="hint">Running out counts the hand as a loss.</span>
          </label>
        )}
      </section>

      <section>
        <h2>Table</h2>
        <label className="field">
          <span className="field-label">
            Players <b>{settings.playerCount}</b>
          </span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={settings.playerCount}
            onChange={(event) => {
              const playerCount = Number(event.target.value);
              // A fixed seat that no longer exists would silently clamp, so
              // clear it rather than quietly moving hero somewhere else.
              const stillValid = settings.fixedSeatIndex !== null
                && settings.fixedSeatIndex < playerCount;
              patch({
                playerCount,
                fixedSeatIndex: stillValid ? settings.fixedSeatIndex : null,
              });
            }}
          />
          <span className="hint">
            {settings.playerCount === 1
              ? 'You alone — equity drilling only, no Outs mode.'
              : seats.map((seat) => seat.display).join(' · ')}
          </span>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={seatFixed}
            onChange={(event) =>
              patch({ fixedSeatIndex: event.target.checked ? 0 : null })}
          />
          <span>Always play the same seat</span>
        </label>
        {seatFixed && (
          <label className="field">
            <span className="field-label">Your seat</span>
            <select
              value={settings.fixedSeatIndex ?? 0}
              onChange={(event) => patch({ fixedSeatIndex: Number(event.target.value) })}
            >
              {seats.map((seat) => (
                <option key={seat.seatIndex} value={seat.seatIndex}>
                  {seat.display}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section>
        <h2>Outs mode</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.countOutsYourself}
            onChange={(event) => patch({ countOutsYourself: event.target.checked })}
          />
          <span>Count the outs yourself</span>
        </label>
        <p className="hint">
          On, you are asked for the count and how many of them actually win. Off,
          the count is shown and those two questions are skipped — three fields
          per hand instead of five.
        </p>
      </section>

      <section>
        <h2>Stacks</h2>
        <p className="hint">
          Every player starts with {STARTING_STACK}, every hand. Not configurable
          and not tracked between hands: money is not the point.
        </p>
      </section>

      <div className="start-row">
        <button
          type="button"
          className="primary"
          disabled={settings.playerCount < 2}
          onClick={() => onStart(settings, 'outs')}
        >
          Start Outs
        </button>
        <button
          type="button"
          className="primary secondary"
          onClick={() => onStart(settings, 'preflop')}
        >
          Start Preflop
        </button>
      </div>
      {settings.playerCount < 2 && (
        <p className="hint">Outs mode needs at least two players.</p>
      )}
    </div>
  );
}
