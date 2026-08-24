import { describe, expect, it } from 'vitest';
import { cardCodes as pheCardCodes } from 'phe';

import {
  DECK_SIZE,
  RANKS,
  SUITS,
  allDistinct,
  cardFromCode,
  cardFromString,
  cardToCode,
  cardToString,
  codeFromString,
  codeToString,
  createRng,
  generateSeed,
  orderedDeckCodes,
  parseCards,
  shuffledDeckCodes,
  tryCardFromString,
} from '../src/engine/deck';

describe('card representation', () => {
  it('round-trips every card through all three forms', () => {
    for (let code = 0; code < DECK_SIZE; code++) {
      const card = cardFromCode(code);
      expect(cardToCode(card)).toBe(code);
      const text = cardToString(card);
      expect(text).toHaveLength(2);
      expect(codeFromString(text)).toBe(code);
      expect(cardToString(cardFromString(text))).toBe(text);
    }
  });

  it('covers exactly the 52 distinct cards', () => {
    const seen = new Set<string>();
    for (const rank of RANKS) for (const suit of SUITS) seen.add(rank + suit);
    expect(seen.size).toBe(DECK_SIZE);
    const codes = new Set(orderedDeckCodes().map(codeToString));
    expect(codes).toEqual(seen);
  });

  it('uses the same integer encoding as the backing evaluator library', () => {
    // This is what lets card codes be handed to `phe` with zero conversion.
    for (let code = 0; code < DECK_SIZE; code++) {
      expect(pheCardCodes([codeToString(code)])[0]).toBe(code);
    }
  });

  it('rejects malformed card strings instead of guessing', () => {
    for (const bad of ['', 'A', 'As ', 'Xs', 'Ax', '10s', 'as', 'AS']) {
      expect(tryCardFromString(bad)).toBeNull();
      expect(() => cardFromString(bad)).toThrow();
    }
  });

  it('accepts lists of cards separated by spaces or commas', () => {
    expect(parseCards('Ah Kd 7c').map(cardToString)).toEqual(['Ah', 'Kd', '7c']);
    expect(parseCards('Ah,Kd,7c').map(cardToString)).toEqual(['Ah', 'Kd', '7c']);
  });
});

describe('seeded rng', () => {
  it('produces identical streams for identical seeds', () => {
    const a = createRng('hand-42');
    const b = createRng('hand-42');
    let divergences = 0;
    for (let i = 0; i < 1000; i++) if (a.next() !== b.next()) divergences++;
    expect(divergences).toBe(0);
  });

  it('produces different streams for adjacent seeds', () => {
    const a = createRng('hand-42');
    const b = createRng('hand-43');
    const first = Array.from({ length: 20 }, () => a.next());
    const second = Array.from({ length: 20 }, () => b.next());
    expect(first).not.toEqual(second);
  });

  it('stays within [0, 1)', () => {
    const rng = createRng('bounds');
    let outOfRange = 0;
    for (let i = 0; i < 200_000; i++) {
      const value = rng.next();
      if (!(value >= 0 && value < 1)) outOfRange++;
    }
    expect(outOfRange).toBe(0);
  });

  it('nextInt is uniform enough and never out of bounds', () => {
    const rng = createRng('uniform');
    const buckets = new Array(52).fill(0) as number[];
    const draws = 520_000;
    let outOfRange = 0;
    for (let i = 0; i < draws; i++) {
      const value = rng.nextInt(52);
      if (!(value >= 0 && value < 52)) outOfRange++;
      buckets[value] = (buckets[value] as number) + 1;
    }
    expect(outOfRange).toBe(0);
    const expected = draws / 52;
    for (const count of buckets) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('rejects invalid bounds rather than returning NaN', () => {
    const rng = createRng('bounds');
    expect(() => rng.nextInt(0)).toThrow();
    expect(() => rng.nextInt(-1)).toThrow();
    expect(() => rng.nextInt(2.5)).toThrow();
  });

  it('generates replayable seeds', () => {
    const seed = generateSeed(createRng('meta'));
    expect(seed).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    expect(generateSeed(createRng('meta'))).toBe(seed);
  });
});

describe('shuffling and dealing', () => {
  it('is a permutation of the full deck', () => {
    const deck = shuffledDeckCodes(createRng('shuffle-1'));
    expect(deck).toHaveLength(DECK_SIZE);
    expect(allDistinct(deck)).toBe(true);
    expect([...deck].sort((a, b) => a - b)).toEqual(orderedDeckCodes());
  });

  it('is deterministic for a given seed and excludes what it is told to', () => {
    const first = shuffledDeckCodes(createRng('shuffle-2'));
    const second = shuffledDeckCodes(createRng('shuffle-2'));
    expect(first).toEqual(second);

    const excluded = [codeFromString('As'), codeFromString('Kd')];
    const trimmed = shuffledDeckCodes(createRng('shuffle-3'), excluded);
    expect(trimmed).toHaveLength(DECK_SIZE - 2);
    for (const code of excluded) expect(trimmed).not.toContain(code);
  });

  it('deals every card to a roughly uniform position', () => {
    // A biased Fisher-Yates would show up here as a card that disproportionately
    // lands in one slot.
    const trials = 20_000;
    const topCardCounts = new Array(DECK_SIZE).fill(0) as number[];
    const rng = createRng('uniformity');
    for (let i = 0; i < trials; i++) {
      const deck = shuffledDeckCodes(rng);
      const top = deck[0] as number;
      topCardCounts[top] = (topCardCounts[top] as number) + 1;
    }
    const expected = trials / DECK_SIZE;
    for (const count of topCardCounts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.25);
    }
  });

  it('detects duplicate cards', () => {
    expect(allDistinct([0, 1, 2, 3])).toBe(true);
    expect(allDistinct([0, 1, 2, 1])).toBe(false);
  });
});
