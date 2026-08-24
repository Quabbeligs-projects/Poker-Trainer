/**
 * deck.ts — card representation, seeded PRNG, shuffling and dealing.
 *
 * Card representation notes
 * -------------------------
 * A card has three interchangeable forms:
 *
 *   1. `Card`       — structured `{ rank, suit }`, used at API boundaries and in the UI.
 *   2. `CardString` — compact form, e.g. `"As"`, `"Th"`, `"2c"`. Used in JSON data and tests.
 *   3. `CardCode`   — an integer `0..51`, used in every hot loop.
 *
 * The integer encoding is `rankIndex * 4 + suitIndex` with
 * `rankIndex: 2 => 0 ... A => 12` and `suitIndex: s => 0, h => 1, d => 2, c => 3`.
 * This is deliberately bit-identical to the encoding used by the `phe` evaluator
 * library, so codes can be handed straight to the evaluator with zero conversion.
 * `evaluator.ts` asserts this equivalence for all 52 cards at test time.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['s', 'h', 'd', 'c'] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

/** Compact string form of a card, e.g. `"As"`. */
export type CardString = string;

/** Integer form of a card, `0..51`. */
export type CardCode = number;

export const DECK_SIZE = 52;

const RANK_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(RANKS.map((r, i) => [r, i])),
);
const SUIT_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(SUITS.map((s, i) => [s, i])),
);

export function isRank(value: string): value is Rank {
  return Object.prototype.hasOwnProperty.call(RANK_INDEX, value);
}

export function isSuit(value: string): value is Suit {
  return Object.prototype.hasOwnProperty.call(SUIT_INDEX, value);
}

/** `'2' => 0 ... 'A' => 12`. */
export function rankIndex(rank: Rank): number {
  return RANK_INDEX[rank] as number;
}

/** `'s' => 0, 'h' => 1, 'd' => 2, 'c' => 3`. */
export function suitIndex(suit: Suit): number {
  return SUIT_INDEX[suit] as number;
}

export function rankFromIndex(index: number): Rank {
  const rank = RANKS[index];
  if (rank === undefined) throw new Error(`Invalid rank index: ${index}`);
  return rank;
}

export function suitFromIndex(index: number): Suit {
  const suit = SUITS[index];
  if (suit === undefined) throw new Error(`Invalid suit index: ${index}`);
  return suit;
}

/* -------------------------------------------------------------------------- */
/* Conversions                                                                 */
/* -------------------------------------------------------------------------- */

export function makeCard(rank: Rank, suit: Suit): Card {
  return { rank, suit };
}

export function cardToString(card: Card): CardString {
  return card.rank + card.suit;
}

export function cardFromString(text: CardString): Card {
  const card = tryCardFromString(text);
  if (card === null) throw new Error(`Invalid card string: ${JSON.stringify(text)}`);
  return card;
}

/** Non-throwing variant; returns `null` for anything that is not a valid card. */
export function tryCardFromString(text: CardString): Card | null {
  if (typeof text !== 'string' || text.length !== 2) return null;
  const rank = text[0] as string;
  const suit = text[1] as string;
  if (!isRank(rank) || !isSuit(suit)) return null;
  return { rank, suit };
}

export function cardToCode(card: Card): CardCode {
  return rankIndex(card.rank) * 4 + suitIndex(card.suit);
}

export function cardFromCode(code: CardCode): Card {
  if (!Number.isInteger(code) || code < 0 || code >= DECK_SIZE) {
    throw new Error(`Invalid card code: ${code}`);
  }
  return { rank: rankFromIndex(code >> 2), suit: suitFromIndex(code & 3) };
}

export function codeToString(code: CardCode): CardString {
  return cardToString(cardFromCode(code));
}

export function codeFromString(text: CardString): CardCode {
  return cardToCode(cardFromString(text));
}

export function rankOfCode(code: CardCode): number {
  return code >> 2;
}

export function suitOfCode(code: CardCode): number {
  return code & 3;
}

export function cardsToStrings(cards: readonly Card[]): CardString[] {
  return cards.map(cardToString);
}

export function cardsFromStrings(texts: readonly CardString[]): Card[] {
  return texts.map(cardFromString);
}

export function codesFromStrings(texts: readonly CardString[]): CardCode[] {
  return texts.map(codeFromString);
}

export function codesToStrings(codes: readonly CardCode[]): CardString[] {
  return Array.from(codes, codeToString);
}

/** Parses a whitespace- or comma-separated list, e.g. `"Ah Kd 7c"`. */
export function parseCards(text: string): Card[] {
  const tokens = text.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  return tokens.map(cardFromString);
}

/* -------------------------------------------------------------------------- */
/* Seeded PRNG                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A seeded, deterministic random source.
 *
 * `Math.random` is deliberately never used anywhere in the engine: every hand
 * must be exactly reproducible from its seed alone.
 */
export interface Rng {
  /** The seed this generator was constructed from. */
  readonly seed: string;
  /** Uniform float in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[0, bound)`. `bound` must be a positive integer. */
  nextInt(bound: number): number;
}

/**
 * cyrb128 — hashes an arbitrary string seed into four 32-bit words.
 * Public-domain algorithm by bryc; used only to spread a human-readable seed
 * across the generator's state.
 */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/**
 * sfc32 — Small Fast Counter, a 32-bit PRNG with a ~2^128 period.
 * Chosen over mulberry32 for its longer period: a 100k-iteration Monte Carlo
 * run consumes millions of draws per hand.
 */
export function createRng(seed: string | number): Rng {
  const seedText = String(seed);
  const [s0, s1, s2, s3] = cyrb128(seedText);
  let a = s0;
  let b = s1;
  let c = s2;
  let d = s3;

  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  // Discard the first few outputs so that similar seeds diverge immediately.
  for (let i = 0; i < 16; i++) next();

  return {
    seed: seedText,
    next,
    nextInt(bound: number): number {
      if (!Number.isInteger(bound) || bound <= 0) {
        throw new Error(`nextInt bound must be a positive integer, got ${bound}`);
      }
      return Math.floor(next() * bound) % bound;
    },
  };
}

/** Generates a fresh, human-typeable seed from an existing random source. */
export function generateSeed(rng: Rng): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[rng.nextInt(alphabet.length)];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Deck                                                                        */
/* -------------------------------------------------------------------------- */

/** A fresh, ordered 52-card deck as card codes. */
export function orderedDeckCodes(): CardCode[] {
  const deck: CardCode[] = new Array(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) deck[i] = i;
  return deck;
}

/** A fresh, ordered 52-card deck as `Card` objects. */
export function orderedDeck(): Card[] {
  return orderedDeckCodes().map(cardFromCode);
}

/** In-place unbiased Fisher-Yates shuffle driven by the supplied `Rng`. */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

/** Returns a new shuffled deck of card codes. */
export function shuffledDeckCodes(rng: Rng, excluded: readonly CardCode[] = []): CardCode[] {
  const blocked = new Set(excluded);
  const deck = orderedDeckCodes().filter((code) => !blocked.has(code));
  return shuffleInPlace(deck, rng);
}

/**
 * A simple stateful dealer over a pre-shuffled deck.
 * Deals from the top; throws rather than silently running out of cards.
 */
export class Dealer {
  private index = 0;

  constructor(private readonly deck: readonly CardCode[]) {}

  get remaining(): number {
    return this.deck.length - this.index;
  }

  dealCode(): CardCode {
    if (this.index >= this.deck.length) throw new Error('Deck exhausted');
    return this.deck[this.index++] as CardCode;
  }

  dealCodes(count: number): CardCode[] {
    const out: CardCode[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.dealCode();
    return out;
  }

  dealCards(count: number): Card[] {
    return this.dealCodes(count).map(cardFromCode);
  }
}

/** True when the collection contains no duplicate card codes. */
export function allDistinct(codes: readonly CardCode[]): boolean {
  let mask = 0n;
  for (const code of codes) {
    const bit = 1n << BigInt(code);
    if ((mask & bit) !== 0n) return false;
    mask |= bit;
  }
  return true;
}
