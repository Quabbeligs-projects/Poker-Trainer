/**
 * Review: the hands you got wrong, filterable by what went wrong.
 *
 * Chronological order alone is not much use — the value is in seeing every
 * instance of one mistake together, so the filter is the primary control rather
 * than an afterthought.
 *
 * The seed is shown on every row and on the replay, in monospace and selectable,
 * so a spot with a verdict worth arguing about can be quoted exactly.
 */
import { useMemo, useState } from 'react';

import type { HandRecord } from '../../game/history';
import { reviewable } from '../../game/history';
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

function when(playedAt: number): string {
  const minutes = Math.round((Date.now() - playedAt) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ReviewScreen({ records, onBack, onReplay }: {
  records: readonly HandRecord[];
  onBack: () => void;
  onReplay: (record: HandRecord) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<MistakeCategory | 'all'>('all');

  // Only offer filters for mistakes that actually occurred.
  const categories = useMemo(() => {
    const counts = new Map<MistakeCategory, number>();
    for (const record of records) {
      if (record.passed) continue;
      for (const category of new Set(record.mistakes)) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [records]);

  const shown = useMemo(() => reviewable(records, filter), [records, filter]);
  const totalWrong = useMemo(() => reviewable(records, 'all').length, [records]);

  return (
    <div className="review">
      <button type="button" className="link" onClick={onBack}>← settings</button>
      <h1>Review</h1>

      {totalWrong === 0 ? (
        <p className="lede">Nothing to review — no missed hands recorded.</p>
      ) : (
        <>
          <div className="filters" role="group" aria-label="Filter by mistake">
            <button
              type="button"
              className={`chip-button ${filter === 'all' ? 'on' : ''}`}
              onClick={() => setFilter('all')}
            >
              All <em>{totalWrong}</em>
            </button>
            {categories.map(([category, count]) => (
              <button
                key={category}
                type="button"
                className={`chip-button ${filter === category ? 'on' : ''}`}
                onClick={() => setFilter(category)}
              >
                {MISTAKE_LABEL[category] ?? category} <em>{count}</em>
              </button>
            ))}
          </div>

          <p className="hint">
            {shown.length} hand{shown.length === 1 ? '' : 's'}
            {filter === 'all' ? '' : ` with ${(MISTAKE_LABEL[filter] ?? filter).toLowerCase()}`}
          </p>

          <ul className="review-list">
            {shown.map((record) => (
              <li key={record.id}>
                <div className="review-head">
                  <span className="review-cards">{record.truth.heroCards}</span>
                  <span className="review-when">{when(record.playedAt)}</span>
                </div>
                {record.truth.board !== '' && (
                  <div className="review-board">on {record.truth.board}</div>
                )}
                <div className="review-tags">
                  {[...new Set(record.mistakes)].map((category) => (
                    <span className="tag" key={category}>
                      {MISTAKE_LABEL[category] ?? category}
                    </span>
                  ))}
                  <span className="tag muted">{record.mode} · {record.street}</span>
                </div>
                <div className="review-answer">
                  you played <b>{record.input.action ?? '—'}</b>, correct was{' '}
                  <b>{record.truth.acceptedActions.join(' / ')}</b>
                </div>
                <div className="review-foot">
                  <code className="seed-chip">{record.seed}</code>
                  <button
                    type="button"
                    className="chip-button"
                    onClick={() => onReplay(record)}
                  >
                    Replay
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
