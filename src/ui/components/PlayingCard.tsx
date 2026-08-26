/**
 * A playing card, four-colour deck.
 *
 * Suit-reading speed matters more than realism here, so suits are coloured
 * rather than left black-and-red: spades black, hearts red, diamonds blue,
 * clubs green. Card faces stay light on the dark table so a black spade still
 * reads as black.
 *
 * The rank glyph is deliberately the largest thing on the card — at a glance,
 * rank is what you read first.
 */
import type { Card } from '../../engine/deck';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_NAME: Record<string, string> = {
  s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs',
};

export function PlayingCard({ card, size = 'normal' }: {
  card: Card;
  size?: 'normal' | 'small' | 'large';
}): JSX.Element {
  const rank = card.rank === 'T' ? '10' : card.rank;
  return (
    <span
      className={`card card-${size} suit-${card.suit}`}
      role="img"
      aria-label={`${rank} of ${SUIT_NAME[card.suit]}`}
    >
      <span className="card-rank">{rank}</span>
      <span className="card-suit" aria-hidden="true">{SUIT_GLYPH[card.suit]}</span>
    </span>
  );
}

export function CardRow({ cards, size = 'normal', label }: {
  cards: readonly Card[];
  size?: 'normal' | 'small' | 'large';
  label?: string;
}): JSX.Element {
  return (
    <div className="card-row">
      {label !== undefined && <span className="card-row-label">{label}</span>}
      <span className="card-row-cards">
        {cards.map((card) => (
          <PlayingCard key={`${card.rank}${card.suit}`} card={card} size={size} />
        ))}
      </span>
    </div>
  );
}
