/**
 * Stats.
 *
 * Form follows the job of each number. Overall accuracy is a single headline,
 * so it is a hero number rather than a chart. Streaks and counts are stat tiles.
 * Mistakes by category is a magnitude comparison across named categories, so a
 * horizontal bar chart — nominal categories, one series, so every bar takes the
 * same hue: colouring them by value would spend the identity channel
 * re-encoding what bar length already shows.
 *
 * Reading bias is polarity around zero — do you read a field high or low — so it
 * is a diverging chart with a neutral midpoint and one hue per arm.
 *
 * Chart marks use their own gold, one step darker than the UI accent: the
 * accent sits outside the dark-mode lightness band for chart marks. The pair
 * (#BE8A30, #5B8FC7) was checked with the palette validator against this
 * surface and passes lightness band, chroma floor, CVD separation,
 * normal-vision separation and contrast.
 *
 * Every bar carries a direct value label instead of a hover tooltip. The app is
 * touch-first, where hover never fires, so labelling the marks is what actually
 * makes the data readable — and it doubles as the table view.
 */
import { useMemo } from 'react';

import type { HandRecord, Stats } from '../../game/history';
import { computeStats } from '../../game/history';
import type { MistakeCategory } from '../../game/types';

const MISTAKE_LABEL: Record<string, string> = {
  EQUITY_UNDER: 'Read equity low',
  EQUITY_OVER: 'Read equity high',
  POT_ODDS_ARITHMETIC: 'Pot odds',
  HIT_PROBABILITY: 'Hit probability',
  OUTS_MISCOUNT: 'Miscounted outs',
  CLEAN_OUTS: 'Which outs win',
  ACTION_TOO_PASSIVE: 'Too passive',
  ACTION_TOO_AGGRESSIVE: 'Too aggressive',
  ACTION_SHOULD_FOLD: 'Should have folded',
  TIMEOUT: 'Ran out of time',
};

const FIELD_LABEL: Record<string, string> = {
  outs: 'Outs', cleanOuts: 'Outs that win', hitProbability: 'Hit probability',
  equity: 'Where you stand', potOdds: 'Pot odds', action: 'Action',
};

function Tile({ value, label, tone }: {
  value: string; label: string; tone?: 'good' | 'bad';
}): JSX.Element {
  return (
    <div className="tile">
      <span className={`tile-value ${tone ?? ''}`}>{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

/** Magnitude across named categories. One series, one hue, direct labels. */
function MistakeBars({ rows, hands }: {
  rows: Stats['byMistake']; hands: number;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  const worst = Math.max(...rows.map((row) => row.count));
  return (
    <section>
      <h3>Mistakes by kind</h3>
      <p className="hint">Share of the {hands} hands played carrying each mistake.</p>
      <div className="bars">
        {rows.map((row) => (
          <div className="bar-row" key={row.category}>
            <span className="bar-label">
              {MISTAKE_LABEL[row.category] ?? row.category}
            </span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(row.count / worst) * 100}%` }} />
            </span>
            <span className="bar-value">
              {row.count}<em> {(row.rate * 100).toFixed(0)}%</em>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Polarity around zero: which side of the truth each field is read on. */
function BiasChart({ stats }: { stats: Stats }): JSX.Element | null {
  const rows = [
    { field: 'outs', unit: '', bias: stats.outsBias },
    { field: 'cleanOuts', unit: '', bias: stats.cleanOutsBias },
    { field: 'hitProbability', unit: 'pp', bias: stats.hitProbabilityBias },
    { field: 'potOdds', unit: 'pp', bias: stats.potOddsBias },
    { field: 'equity', unit: ' bands', bias: stats.equityBandBias },
  ].filter((row) => row.bias.samples > 0);
  if (rows.length === 0) return null;

  const widest = Math.max(...rows.map((row) => Math.abs(row.bias.meanSignedError)), 0.001);
  return (
    <section>
      <h3>How you read each field</h3>
      <p className="hint">
        Mean signed error. Left of the line you read low, right of it you read
        high — a consistent lean is worth more than any single hand.
      </p>
      <div className="bias">
        <div className="bias-scale">
          <span>reads low</span><span>reads high</span>
        </div>
        {rows.map((row) => {
          const value = row.bias.meanSignedError;
          const width = (Math.abs(value) / widest) * 50;
          return (
            <div className="bar-row" key={row.field}>
              <span className="bar-label">{FIELD_LABEL[row.field] ?? row.field}</span>
              <span className="bias-track">
                <span className="bias-zero" />
                <span
                  className={`bias-fill ${value < 0 ? 'low' : 'high'}`}
                  style={value < 0
                    ? { right: '50%', width: `${width}%` }
                    : { left: '50%', width: `${width}%` }}
                />
              </span>
              <span className="bar-value">
                {value >= 0 ? '+' : ''}{value.toFixed(1)}{row.unit}
                <em> n={row.bias.samples}</em>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function StatsScreen({ records, onBack, onExport, onImport, onClear }: {
  records: readonly HandRecord[];
  onBack: () => void;
  onExport: () => void;
  onImport: () => void;
  onClear: () => void;
}): JSX.Element {
  const stats = useMemo(() => computeStats(records), [records]);

  if (stats.hands === 0) {
    return (
      <div className="stats">
        <button type="button" className="link" onClick={onBack}>← settings</button>
        <h1>Stats</h1>
        <p className="lede">Nothing played yet. Numbers appear after the first hand.</p>
        <button type="button" className="primary secondary" onClick={onImport}>
          Import history
        </button>
      </div>
    );
  }

  return (
    <div className="stats">
      <button type="button" className="link" onClick={onBack}>← settings</button>
      <h1>Stats</h1>

      <div className="hero-number">
        <span className="hero-value">{(stats.accuracy * 100).toFixed(0)}%</span>
        <span className="hero-label">
          {stats.passed} of {stats.hands} decisions correct
        </span>
      </div>

      <div className="tiles">
        {stats.currentStreak > 0
          ? <Tile value={String(stats.currentStreak)} label="current streak" tone="good" />
          : <Tile value={String(stats.currentStreak)} label="current streak" />}
        <Tile value={String(stats.bestStreak)} label="best streak" />
        {stats.byMode.map((row) => (
          <Tile key={row.mode} value={`${(row.accuracy * 100).toFixed(0)}%`}
            label={`${row.mode} · ${row.hands}`} />
        ))}
      </div>

      <MistakeBars rows={stats.byMistake} hands={stats.hands} />
      <BiasChart stats={stats} />

      {stats.medianSecondsPerField.length > 0 && (
        <section>
          <h3>Median time per field</h3>
          <p className="hint">What the time-trial length should be set from.</p>
          <div className="bars">
            {stats.medianSecondsPerField.map((row) => {
              const slowest = stats.medianSecondsPerField[0]?.seconds ?? 1;
              return (
                <div className="bar-row" key={row.field}>
                  <span className="bar-label">{FIELD_LABEL[row.field] ?? row.field}</span>
                  <span className="bar-track">
                    <span className="bar-fill"
                      style={{ width: `${(row.seconds / slowest) * 100}%` }} />
                  </span>
                  <span className="bar-value">{row.seconds.toFixed(1)}s</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h3>History</h3>
        <div className="start-row">
          <button type="button" className="primary secondary" onClick={onExport}>
            Export JSON
          </button>
          <button type="button" className="primary secondary" onClick={onImport}>
            Import JSON
          </button>
        </div>
        <button type="button" className="link danger" onClick={onClear}>
          Delete all {stats.hands} records
        </button>
      </section>
    </div>
  );
}

export type { MistakeCategory };
