/**
 * The opponent's narrowed range as a 13x13 grid.
 *
 * This is what the equity was actually computed against, so it belongs on the
 * feedback screen: without it, a surprising equity number is unexplainable.
 *
 * Weight is shown as a partial vertical fill rather than opacity, so a hand
 * kept at 40% weight is visibly different from one kept whole — the narrowing
 * rules produce fractional weights routinely and flattening them would hide
 * what the engine actually did.
 */
import { HAND_GRID } from '../../engine/ranges';

export function RangeGrid({ weights, caption, highlight }: {
  /** Hand key to weight in [0, 1]. */
  weights: ReadonlyMap<string, number>;
  caption?: string;
  /** A hand key to ring, so hero can find their own hand on the chart. */
  highlight?: string;
}): JSX.Element {
  return (
    <figure className="range-grid-figure">
      <div className="range-grid" role="img" aria-label={caption ?? "Opponent's range"}>
        {HAND_GRID.map((row) => row.map((key) => {
          const weight = weights.get(key) ?? 0;
          const kind = key.length === 2 ? 'pair' : key.endsWith('s') ? 'suited' : 'offsuit';
          const mine = key === highlight;
          return (
            <span
              key={key}
              className={`rg-cell ${kind} ${weight > 0 ? 'in' : 'out'}${mine ? ' mine' : ''}`}
              style={{ '--w': `${(weight * 100).toFixed(1)}%` } as React.CSSProperties}
              title={`${key} — ${Math.round(weight * 100)}%`}
            >
              <span className="rg-label">{key}</span>
            </span>
          );
        }))}
      </div>
      {caption !== undefined && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
