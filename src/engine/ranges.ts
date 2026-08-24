/**
 * ranges.ts — preflop ranges as weighted sets of individual combos.
 *
 * Every range is expanded into the full 1326 two-card combinations, each with a
 * weight in [0, 1]. Sampling from a range is therefore exact: there is no
 * approximation from working at the 169-hand level.
 *
 * Notation (PokerStove convention)
 * --------------------------------
 *   `77`          the pair, 6 combos
 *   `77+`         77, 88, ... AA
 *   `77-TT`       77, 88, 99, TT (either order accepted)
 *   `AJs`         suited AJ, 4 combos
 *   `AJo`         offsuit AJ, 12 combos
 *   `AJ`          both, 16 combos
 *   `AJs+`        the HIGH card is fixed and the LOW card walks up: AJs, AQs, AKs
 *   `A5s-A2s`     same high card, low card walks: A5s, A4s, A3s, A2s
 *   `T9s-54s`     same gap, both cards walk: T9s, 98s, 87s, 76s, 65s, 54s
 *   `AsKh`        one explicit combo
 *   `random`      all 1326 combos
 *
 * Note on `+` for non-pairs: it always increments the LOWER card toward the
 * higher one, so `76s+` means only `76s`. Runs of connectors must be written as
 * an explicit dash range (`T9s-54s`), which removes the ambiguity that bites
 * people using `65s+` to mean a diagonal. The bundled `ranges.json` never
 * relies on the ambiguous form.
 *
 * Weights: a range spec entry is either a plain notation string (weight 1.0) or
 * `{ "hand": "AJs+", "weight": 0.5 }`. When several entries touch the same
 * combo the HIGHEST weight wins, so a broad low-weight entry can be overridden
 * by a narrow full-weight one regardless of ordering.
 */

import {
  type CardCode,
  DECK_SIZE,
  RANKS,
  type Rank,
  type Suit,
  isRank,
  rankFromIndex,
  rankIndex,
  suitIndex,
  tryCardFromString,
} from './deck';

/** Number of distinct two-card combinations in a 52-card deck. */
export const COMBO_COUNT = 1326;

/* -------------------------------------------------------------------------- */
/* Combo indexing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Maps an unordered pair of card codes to a dense index `0..1325`.
 * With `hi > lo`, `index = hi * (hi - 1) / 2 + lo` enumerates every pair exactly
 * once, which lets a whole range live in a single `Float64Array(1326)`.
 */
export function comboIndex(a: CardCode, b: CardCode): number {
  if (a === b) throw new Error(`A combo needs two distinct cards (got ${a} twice)`);
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  return (hi * (hi - 1)) / 2 + lo;
}

const COMBO_HI = new Int32Array(COMBO_COUNT);
const COMBO_LO = new Int32Array(COMBO_COUNT);
(() => {
  for (let hi = 1; hi < DECK_SIZE; hi++) {
    for (let lo = 0; lo < hi; lo++) {
      const idx = (hi * (hi - 1)) / 2 + lo;
      COMBO_HI[idx] = hi;
      COMBO_LO[idx] = lo;
    }
  }
})();

/** The higher card code of a combo index. */
export function comboHigh(index: number): CardCode {
  return COMBO_HI[index] as number;
}

/** The lower card code of a combo index. */
export function comboLow(index: number): CardCode {
  return COMBO_LO[index] as number;
}

export function comboCards(index: number): [CardCode, CardCode] {
  return [COMBO_HI[index] as number, COMBO_LO[index] as number];
}

/* -------------------------------------------------------------------------- */
/* 169 hand keys (the 13x13 grid)                                              */
/* -------------------------------------------------------------------------- */

/** `"AA"`, `"AKs"`, `"AKo"` — the 169 strategically distinct starting hands. */
export type HandKey = string;

/** The hand key for a combo index, e.g. combo `As Kh` -> `"AKo"`. */
export function handKeyOfCombo(index: number): HandKey {
  const hi = COMBO_HI[index] as number;
  const lo = COMBO_LO[index] as number;
  const hiRank = hi >> 2;
  const loRank = lo >> 2;
  const suited = (hi & 3) === (lo & 3);
  if (hiRank === loRank) return `${rankFromIndex(hiRank)}${rankFromIndex(loRank)}`;
  const high = rankFromIndex(Math.max(hiRank, loRank));
  const low = rankFromIndex(Math.min(hiRank, loRank));
  return `${high}${low}${suited ? 's' : 'o'}`;
}

/**
 * The 169 hand keys in grid order: row = higher rank, column = lower rank,
 * both descending from A. Suited hands sit above the diagonal, offsuit below —
 * the standard layout of a poker range chart.
 */
export const HAND_GRID: readonly (readonly HandKey[])[] = (() => {
  const grid: HandKey[][] = [];
  for (let r = RANKS.length - 1; r >= 0; r--) {
    const row: HandKey[] = [];
    for (let c = RANKS.length - 1; c >= 0; c--) {
      const rowRank = rankFromIndex(r);
      const colRank = rankFromIndex(c);
      if (r === c) row.push(`${rowRank}${colRank}`);
      else if (r > c) row.push(`${rowRank}${colRank}s`);
      else row.push(`${colRank}${rowRank}o`);
    }
    grid.push(row);
  }
  return grid;
})();

/** Every combo index belonging to a given hand key. */
const COMBOS_BY_HAND_KEY: ReadonlyMap<HandKey, readonly number[]> = (() => {
  const map = new Map<HandKey, number[]>();
  for (let i = 0; i < COMBO_COUNT; i++) {
    const key = handKeyOfCombo(i);
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  }
  return map;
})();

export function combosOfHandKey(key: HandKey): readonly number[] {
  return COMBOS_BY_HAND_KEY.get(key) ?? [];
}

/* -------------------------------------------------------------------------- */
/* Notation parsing                                                            */
/* -------------------------------------------------------------------------- */

function pairCombos(rank: Rank, out: Set<number>): void {
  const r = rankIndex(rank);
  for (let s1 = 0; s1 < 4; s1++) {
    for (let s2 = s1 + 1; s2 < 4; s2++) {
      out.add(comboIndex(r * 4 + s1, r * 4 + s2));
    }
  }
}

function suitedCombos(high: Rank, low: Rank, out: Set<number>): void {
  const hr = rankIndex(high);
  const lr = rankIndex(low);
  for (let s = 0; s < 4; s++) out.add(comboIndex(hr * 4 + s, lr * 4 + s));
}

function offsuitCombos(high: Rank, low: Rank, out: Set<number>): void {
  const hr = rankIndex(high);
  const lr = rankIndex(low);
  for (let s1 = 0; s1 < 4; s1++) {
    for (let s2 = 0; s2 < 4; s2++) {
      if (s1 === s2) continue;
      out.add(comboIndex(hr * 4 + s1, lr * 4 + s2));
    }
  }
}

interface ParsedHand {
  kind: 'pair' | 'suited' | 'offsuit' | 'both';
  high: Rank;
  low: Rank;
}

/** Parses a bare hand token such as `"AJs"`, `"77"` or `"AJ"` (no `+`/`-`). */
function parseBareHand(token: string): ParsedHand | null {
  if (token.length < 2 || token.length > 3) return null;
  const a = token[0] as string;
  const b = token[1] as string;
  if (!isRank(a) || !isRank(b)) return null;
  const suffix = token.length === 3 ? (token[2] as string).toLowerCase() : '';
  const ai = rankIndex(a);
  const bi = rankIndex(b);
  const high = ai >= bi ? a : b;
  const low = ai >= bi ? b : a;

  if (ai === bi) {
    if (suffix !== '') return null; // "77s" is meaningless
    return { kind: 'pair', high, low };
  }
  if (suffix === 's') return { kind: 'suited', high, low };
  if (suffix === 'o') return { kind: 'offsuit', high, low };
  if (suffix === '') return { kind: 'both', high, low };
  return null;
}

function emitHand(hand: ParsedHand, out: Set<number>): void {
  switch (hand.kind) {
    case 'pair':
      pairCombos(hand.high, out);
      break;
    case 'suited':
      suitedCombos(hand.high, hand.low, out);
      break;
    case 'offsuit':
      offsuitCombos(hand.high, hand.low, out);
      break;
    case 'both':
      suitedCombos(hand.high, hand.low, out);
      offsuitCombos(hand.high, hand.low, out);
      break;
  }
}

/** Parses an explicit two-card combo such as `"AsKh"`. */
function parseExplicitCombo(token: string): number | null {
  if (token.length !== 4) return null;
  const first = tryCardFromString(token.slice(0, 2));
  const second = tryCardFromString(token.slice(2, 4));
  if (first === null || second === null) return null;
  const a = rankIndex(first.rank) * 4 + suitIndex(first.suit);
  const b = rankIndex(second.rank) * 4 + suitIndex(second.suit);
  if (a === b) return null;
  return comboIndex(a, b);
}

/**
 * Expands a single notation token into combo indices.
 * Throws on anything it cannot parse — silently dropping a malformed entry
 * would corrupt a range without any visible symptom.
 */
export function expandNotation(rawToken: string): number[] {
  const token = rawToken.trim();
  if (token.length === 0) throw new Error('Empty range token');
  const out = new Set<number>();

  const lowered = token.toLowerCase();
  if (lowered === 'random' || lowered === 'any2' || lowered === '100%') {
    for (let i = 0; i < COMBO_COUNT; i++) out.add(i);
    return [...out];
  }

  // Explicit single combo, e.g. "AsKh".
  const explicit = parseExplicitCombo(token);
  if (explicit !== null) return [explicit];

  // Dash range, e.g. "77-TT", "A5s-A2s", "T9s-54s".
  const dash = token.indexOf('-');
  if (dash > 0) {
    const left = parseBareHand(token.slice(0, dash).trim());
    const right = parseBareHand(token.slice(dash + 1).trim());
    if (left === null || right === null) {
      throw new Error(`Unparseable range token: ${JSON.stringify(rawToken)}`);
    }
    if (left.kind !== right.kind) {
      throw new Error(
        `Range endpoints must be the same kind of hand: ${JSON.stringify(rawToken)}`,
      );
    }
    expandDashRange(left, right, rawToken, out);
    return [...out];
  }

  // Plus range, e.g. "77+", "AJs+".
  if (token.endsWith('+')) {
    const base = parseBareHand(token.slice(0, -1).trim());
    if (base === null) throw new Error(`Unparseable range token: ${JSON.stringify(rawToken)}`);
    expandPlusRange(base, out);
    return [...out];
  }

  const bare = parseBareHand(token);
  if (bare === null) throw new Error(`Unparseable range token: ${JSON.stringify(rawToken)}`);
  emitHand(bare, out);
  return [...out];
}

function expandPlusRange(base: ParsedHand, out: Set<number>): void {
  if (base.kind === 'pair') {
    for (let r = rankIndex(base.high); r < RANKS.length; r++) {
      pairCombos(rankFromIndex(r), out);
    }
    return;
  }
  // Non-pair: the high card is fixed, the low card walks up to just below it.
  const hi = rankIndex(base.high);
  for (let lo = rankIndex(base.low); lo < hi; lo++) {
    emitHand({ kind: base.kind, high: base.high, low: rankFromIndex(lo) }, out);
  }
}

function expandDashRange(
  left: ParsedHand,
  right: ParsedHand,
  rawToken: string,
  out: Set<number>,
): void {
  if (left.kind === 'pair') {
    const a = rankIndex(left.high);
    const b = rankIndex(right.high);
    for (let r = Math.min(a, b); r <= Math.max(a, b); r++) pairCombos(rankFromIndex(r), out);
    return;
  }

  const lh = rankIndex(left.high);
  const ll = rankIndex(left.low);
  const rh = rankIndex(right.high);
  const rl = rankIndex(right.low);

  // Same high card: the low card walks, e.g. "A5s-A2s".
  if (lh === rh) {
    for (let lo = Math.min(ll, rl); lo <= Math.max(ll, rl); lo++) {
      emitHand({ kind: left.kind, high: left.high, low: rankFromIndex(lo) }, out);
    }
    return;
  }

  // Same gap: both cards walk down the diagonal, e.g. "T9s-54s".
  if (lh - ll === rh - rl) {
    const gap = lh - ll;
    for (let high = Math.min(lh, rh); high <= Math.max(lh, rh); high++) {
      emitHand({
        kind: left.kind,
        high: rankFromIndex(high),
        low: rankFromIndex(high - gap),
      }, out);
    }
    return;
  }

  throw new Error(
    `Range endpoints must share a high card or a gap: ${JSON.stringify(rawToken)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Range                                                                       */
/* -------------------------------------------------------------------------- */

/** A raw range definition as it appears in JSON. */
export type RangeEntry = string | { hand: string; weight: number };
export type RangeSpec = readonly RangeEntry[] | string;

/**
 * A weighted set of the 1326 combos.
 *
 * Instances are immutable: every transformation returns a new `Range`. This
 * matters because narrowed ranges are stored inside frozen ground-truth objects
 * and must not be mutable after the fact.
 */
export class Range {
  /** Weight per combo index, each in `[0, 1]`. */
  readonly weights: Float64Array;
  /** Free-text label, used in feedback ("BTN opening range"). */
  readonly label: string;

  private cachedNonZero: Int32Array | null = null;
  private cachedTotalWeight: number | null = null;

  private constructor(weights: Float64Array, label: string) {
    this.weights = weights;
    this.label = label;
  }

  static empty(label = ''): Range {
    return new Range(new Float64Array(COMBO_COUNT), label);
  }

  static full(label = 'random'): Range {
    const w = new Float64Array(COMBO_COUNT);
    w.fill(1);
    return new Range(w, label);
  }

  /** Builds a range from raw weights; the array is copied. */
  static fromWeights(weights: ArrayLike<number>, label = ''): Range {
    if (weights.length !== COMBO_COUNT) {
      throw new Error(`Expected ${COMBO_COUNT} weights, received ${weights.length}`);
    }
    const copy = new Float64Array(COMBO_COUNT);
    for (let i = 0; i < COMBO_COUNT; i++) {
      const value = weights[i] as number;
      if (!(value >= 0) || value > 1) {
        throw new Error(`Combo weight must be within [0, 1], got ${value} at index ${i}`);
      }
      copy[i] = value;
    }
    return new Range(copy, label);
  }

  /**
   * Parses a range spec. Accepts an array of entries or a comma-separated
   * string. When entries overlap, the highest weight for a combo wins.
   */
  static parse(spec: RangeSpec, label = ''): Range {
    const entries: RangeEntry[] = typeof spec === 'string'
      ? spec.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [...spec];
    const weights = new Float64Array(COMBO_COUNT);
    for (const entry of entries) {
      const notation = typeof entry === 'string' ? entry : entry.hand;
      const weight = typeof entry === 'string' ? 1 : entry.weight;
      if (typeof notation !== 'string') {
        throw new Error(`Range entry is missing a hand: ${JSON.stringify(entry)}`);
      }
      if (!(weight >= 0) || weight > 1) {
        throw new Error(
          `Range weight must be within [0, 1] for ${notation}, got ${String(weight)}`,
        );
      }
      for (const index of expandNotation(notation)) {
        if (weight > (weights[index] as number)) weights[index] = weight;
      }
    }
    return new Range(weights, label);
  }

  withLabel(label: string): Range {
    return new Range(this.weights, label);
  }

  weightOf(index: number): number {
    return this.weights[index] as number;
  }

  weightOfCards(a: CardCode, b: CardCode): number {
    return this.weights[comboIndex(a, b)] as number;
  }

  /** Sum of all combo weights. A full range totals 1326. */
  get totalWeight(): number {
    if (this.cachedTotalWeight === null) {
      let sum = 0;
      for (let i = 0; i < COMBO_COUNT; i++) sum += this.weights[i] as number;
      this.cachedTotalWeight = sum;
    }
    return this.cachedTotalWeight;
  }

  /** Number of combos with any weight at all. */
  get comboCount(): number {
    return this.nonZeroIndices.length;
  }

  /** Fraction of all possible hands this range represents, weighted. */
  get percentOfHands(): number {
    return (this.totalWeight / COMBO_COUNT) * 100;
  }

  get isEmpty(): boolean {
    return this.totalWeight <= 0;
  }

  /** Indices of every combo with non-zero weight. */
  get nonZeroIndices(): Int32Array {
    if (this.cachedNonZero === null) {
      const list: number[] = [];
      for (let i = 0; i < COMBO_COUNT; i++) {
        if ((this.weights[i] as number) > 0) list.push(i);
      }
      this.cachedNonZero = Int32Array.from(list);
    }
    return this.cachedNonZero;
  }

  /** Applies a per-combo multiplier, returning a new range. */
  map(fn: (weight: number, index: number) => number, label = this.label): Range {
    const out = new Float64Array(COMBO_COUNT);
    for (let i = 0; i < COMBO_COUNT; i++) {
      const current = this.weights[i] as number;
      if (current <= 0) continue;
      const next = fn(current, i);
      out[i] = next <= 0 ? 0 : next > 1 ? 1 : next;
    }
    return new Range(out, label);
  }

  /** Zeroes every combo using any of the given cards (board or hero cards). */
  removeCards(cards: readonly CardCode[]): Range {
    if (cards.length === 0) return this;
    const blocked = new Uint8Array(DECK_SIZE);
    for (const card of cards) blocked[card] = 1;
    return this.map((w, i) => (
      blocked[COMBO_HI[i] as number] || blocked[COMBO_LO[i] as number] ? 0 : w
    ));
  }

  /** Union, taking the higher weight for each combo. */
  union(other: Range, label = this.label): Range {
    const out = new Float64Array(COMBO_COUNT);
    for (let i = 0; i < COMBO_COUNT; i++) {
      const a = this.weights[i] as number;
      const b = other.weights[i] as number;
      out[i] = a > b ? a : b;
    }
    return new Range(out, label);
  }

  /** Rescales so the heaviest combo sits at weight 1; empty ranges pass through. */
  normalised(label = this.label): Range {
    let max = 0;
    for (let i = 0; i < COMBO_COUNT; i++) {
      const w = this.weights[i] as number;
      if (w > max) max = w;
    }
    if (max <= 0 || max === 1) return new Range(this.weights, label);
    return this.map((w) => w / max, label);
  }

  /** Weight totals per hand key, for rendering the 13x13 grid. */
  handKeyWeights(): Map<HandKey, { weight: number; combos: number; maxWeight: number }> {
    const out = new Map<HandKey, { weight: number; combos: number; maxWeight: number }>();
    for (let i = 0; i < COMBO_COUNT; i++) {
      const w = this.weights[i] as number;
      if (w <= 0) continue;
      const key = handKeyOfCombo(i);
      const bucket = out.get(key);
      if (bucket) {
        bucket.weight += w;
        bucket.combos += 1;
        if (w > bucket.maxWeight) bucket.maxWeight = w;
      } else {
        out.set(key, { weight: w, combos: 1, maxWeight: w });
      }
    }
    return out;
  }

  /** Compact notation-ish description, for debugging and feedback text. */
  describe(limit = 12): string {
    const keys = [...this.handKeyWeights().keys()];
    if (keys.length === 0) return '(empty)';
    const shown = keys.slice(0, limit).join(', ');
    return keys.length > limit ? `${shown}, +${keys.length - limit} more` : shown;
  }
}

/**
 * A sampler over a range, used by the Monte Carlo loop.
 *
 * Construction is O(1326); sampling is O(log n) per draw via binary search over
 * the cumulative weights. Blocked combos are rejected by the caller, which is
 * why `sample` returns a combo index rather than resolving conflicts itself.
 */
export class RangeSampler {
  private readonly indices: Int32Array;
  private readonly cumulative: Float64Array;
  readonly total: number;

  constructor(range: Range) {
    const nz = range.nonZeroIndices;
    this.indices = nz;
    this.cumulative = new Float64Array(nz.length);
    let running = 0;
    for (let i = 0; i < nz.length; i++) {
      running += range.weightOf(nz[i] as number);
      this.cumulative[i] = running;
    }
    this.total = running;
  }

  get size(): number {
    return this.indices.length;
  }

  /** Draws a combo index. `u` must be a uniform draw in `[0, 1)`. */
  sample(u: number): number {
    const target = u * this.total;
    let lo = 0;
    let hi = this.indices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cumulative[mid] as number) <= target) lo = mid + 1;
      else hi = mid;
    }
    return this.indices[lo] as number;
  }
}

/* -------------------------------------------------------------------------- */
/* Positions and table-size mapping                                            */
/* -------------------------------------------------------------------------- */

/** The six positions the bundled charts are defined for. */
export const CHART_POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'] as const;
export type ChartPosition = (typeof CHART_POSITIONS)[number];

/** What a seat is called on screen; several may map to one chart position. */
export type DisplayPosition = string;

export interface SeatPosition {
  /** Seat order, 0 = first to act preflop. */
  readonly seatIndex: number;
  /** Label shown in the UI, e.g. `"UTG+1"`. */
  readonly display: DisplayPosition;
  /** Which 6-max chart this seat uses. */
  readonly chart: ChartPosition;
}

/**
 * Chart position by number of players left to act behind hero.
 *
 * This is the whole seat mapping: a seat's correct chart is decided by how many
 * players act after it, not by the size of the table. A seat with three players
 * behind plays the cutoff chart whether the table is 4-handed or 10-handed,
 * which is what published 6-max and full-ring charts actually show.
 *
 * Beyond five players behind there is no 6-max chart to map onto, so the seat
 * uses the UTG chart and `tableScaling.ts` tightens it. See that file for the
 * width rule and its validation against published full-ring ranges.
 */
const CHART_BY_PLAYERS_BEHIND: readonly ChartPosition[] = [
  'BB',  // 0 behind — closes the preflop action
  'SB',  // 1
  'BTN', // 2
  'CO',  // 3
  'MP',  // 4
  'UTG', // 5 and above
];

/**
 * Maps an N-handed table onto the 6-max chart positions.
 *
 * Seats are assigned by players-left-to-act (see `CHART_BY_PLAYERS_BEHIND`), so
 * the blinds, button and cutoff land correctly at every table size and only the
 * early seats pile up on the UTG chart. Two special cases:
 *
 *   - 2 players is heads-up: the button posts the small blind and plays button
 *     ranges, so the seats are BTN and BB rather than SB and BB. Heads-up uses
 *     its own authored charts entirely (see `headsUp` in ranges.json).
 *   - 1 player is hero alone for pure equity drilling, nominally the button.
 *
 * Display labels disambiguate seats sharing a chart as UTG, UTG+1, UTG+2 and so
 * on, earliest seat first, so a 9-handed table still reads correctly on screen.
 */
export function seatPositions(playerCount: number): SeatPosition[] {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 10) {
    throw new Error(`Player count must be an integer within 1..10, got ${playerCount}`);
  }
  if (playerCount === 1) {
    return [{ seatIndex: 0, display: 'BTN', chart: 'BTN' }];
  }
  if (playerCount === 2) {
    return [
      { seatIndex: 0, display: 'BTN', chart: 'BTN' },
      { seatIndex: 1, display: 'BB', chart: 'BB' },
    ];
  }

  const charts: ChartPosition[] = [];
  for (let seatIndex = 0; seatIndex < playerCount; seatIndex++) {
    const behind = playerCount - 1 - seatIndex;
    const chart = behind >= CHART_BY_PLAYERS_BEHIND.length
      ? 'UTG'
      : (CHART_BY_PLAYERS_BEHIND[behind] as ChartPosition);
    charts.push(chart);
  }

  const counters = new Map<ChartPosition, number>();
  const totals = new Map<ChartPosition, number>();
  for (const chart of charts) totals.set(chart, (totals.get(chart) ?? 0) + 1);

  return charts.map((chart, seatIndex) => {
    const seen = counters.get(chart) ?? 0;
    counters.set(chart, seen + 1);
    const display = (totals.get(chart) as number) > 1 && seen > 0
      ? `${chart}+${seen}`
      : chart;
    return { seatIndex, display, chart };
  });
}

/* -------------------------------------------------------------------------- */
/* Chart lookup                                                                */
/* -------------------------------------------------------------------------- */

/** How the opener's position is bucketed when looking up a response range. */
export const OPENER_BUCKETS = ['early', 'middle', 'late', 'sb'] as const;
export type OpenerBucket = (typeof OPENER_BUCKETS)[number];

/** UTG/MP are `early`, CO is `middle`, BTN is `late`, SB is its own bucket. */
export function openerBucket(position: ChartPosition): OpenerBucket {
  switch (position) {
    case 'UTG':
    case 'MP':
      return 'early';
    case 'CO':
      return 'middle';
    case 'BTN':
      return 'late';
    case 'SB':
      return 'sb';
    case 'BB':
      throw new Error('The big blind cannot be the preflop opener');
  }
}

export interface ResponseSpec {
  readonly call?: RangeSpec;
  readonly threeBet?: RangeSpec;
  readonly fourBet?: RangeSpec;
  readonly squeeze?: RangeSpec;
}

export interface HeadsUpJson {
  readonly rfi: Partial<Record<ChartPosition, RangeSpec>>;
  readonly vsOpen: Partial<Record<ChartPosition, ResponseSpec>>;
}

export interface RangeChartsJson {
  readonly meta?: unknown;
  readonly rfi: Partial<Record<ChartPosition, RangeSpec>>;
  readonly vsOpen: Partial<Record<ChartPosition, Partial<Record<OpenerBucket, ResponseSpec>>>>;
  readonly vsOpenWithCallers: Partial<Record<ChartPosition, ResponseSpec>>;
  readonly vsThreeBet: Partial<Record<ChartPosition | 'default', ResponseSpec>>;
  /** Heads-up charts, used verbatim at 2 players. See `headsUp` in ranges.json. */
  readonly headsUp?: HeadsUpJson;
}

export interface ParsedResponse {
  readonly call: Range;
  readonly threeBet: Range;
  readonly fourBet: Range;
  readonly squeeze: Range;
}

/**
 * Parsed, validated charts. Construct once at startup; every lookup is cached,
 * so the notation parser never runs inside a hand.
 */
export class RangeCharts {
  private readonly rfiCache = new Map<ChartPosition, Range>();
  private readonly responseCache = new Map<string, ParsedResponse>();

  constructor(private readonly json: RangeChartsJson) {
    // Parse everything eagerly so a typo in the JSON fails loudly at startup
    // rather than silently mid-session.
    for (const position of CHART_POSITIONS) this.rfi(position);
    for (const position of CHART_POSITIONS) {
      for (const bucket of OPENER_BUCKETS) this.vsOpen(position, bucket);
      this.vsOpenWithCallers(position);
      this.vsThreeBet(position);
    }
    this.headsUpRfi();
    this.headsUpVsOpen();
  }

  /** True when the JSON supplies dedicated heads-up charts. */
  get hasHeadsUpCharts(): boolean {
    return this.json.headsUp !== undefined;
  }

  /** The button's heads-up opening range. Empty when no heads-up charts exist. */
  headsUpRfi(): Range {
    const cached = this.rfiCache.get('__hu_btn__' as ChartPosition);
    if (cached) return cached;
    const spec = this.json.headsUp?.rfi?.BTN;
    const range = spec === undefined
      ? Range.empty('HU BTN RFI')
      : Range.parse(spec, 'HU BTN RFI');
    this.rfiCache.set('__hu_btn__' as ChartPosition, range);
    return range;
  }

  /** The big blind's heads-up defence against a button open. */
  headsUpVsOpen(): ParsedResponse {
    return this.cachedResponse('hu:BB', () =>
      this.parseResponse(this.json.headsUp?.vsOpen?.BB, 'HU BB vs BTN open'),
    );
  }

  /** Raise-first-in range for a position. The BB has none (it never opens). */
  rfi(position: ChartPosition): Range {
    const cached = this.rfiCache.get(position);
    if (cached) return cached;
    const spec = this.json.rfi[position];
    const range = spec === undefined
      ? Range.empty(`${position} RFI`)
      : Range.parse(spec, `${position} RFI`);
    this.rfiCache.set(position, range);
    return range;
  }

  private parseResponse(spec: ResponseSpec | undefined, label: string): ParsedResponse {
    return {
      call: spec?.call ? Range.parse(spec.call, `${label} call`) : Range.empty(`${label} call`),
      threeBet: spec?.threeBet
        ? Range.parse(spec.threeBet, `${label} 3-bet`)
        : Range.empty(`${label} 3-bet`),
      fourBet: spec?.fourBet
        ? Range.parse(spec.fourBet, `${label} 4-bet`)
        : Range.empty(`${label} 4-bet`),
      squeeze: spec?.squeeze
        ? Range.parse(spec.squeeze, `${label} squeeze`)
        : Range.empty(`${label} squeeze`),
    };
  }

  private cachedResponse(key: string, build: () => ParsedResponse): ParsedResponse {
    const cached = this.responseCache.get(key);
    if (cached) return cached;
    const built = build();
    this.responseCache.set(key, built);
    return built;
  }

  /** Hero's response to a single open from a bucketed position. */
  vsOpen(position: ChartPosition, bucket: OpenerBucket): ParsedResponse {
    return this.cachedResponse(`vsOpen:${position}:${bucket}`, () =>
      this.parseResponse(this.json.vsOpen[position]?.[bucket], `${position} vs ${bucket} open`),
    );
  }

  /** Hero's response to an open that already has at least one caller. */
  vsOpenWithCallers(position: ChartPosition): ParsedResponse {
    return this.cachedResponse(`vsCallers:${position}`, () =>
      this.parseResponse(this.json.vsOpenWithCallers[position], `${position} vs open + callers`),
    );
  }

  /** Hero opened and now faces a 3-bet. Falls back to the `default` entry. */
  vsThreeBet(position: ChartPosition): ParsedResponse {
    return this.cachedResponse(`vs3bet:${position}`, () =>
      this.parseResponse(
        this.json.vsThreeBet[position] ?? this.json.vsThreeBet.default,
        `${position} vs 3-bet`,
      ),
    );
  }

  /**
   * The range a player who OPENED from `position` holds, i.e. their RFI range.
   * This is the starting point for postflop range narrowing.
   */
  openingRange(position: ChartPosition): Range {
    return this.rfi(position);
  }

  /**
   * The range a player who CALLED an open from `openerPosition` holds.
   * Falls back to a sensible wide default when the chart has no entry, so the
   * engine never ends up sampling from an empty range.
   */
  callingRange(position: ChartPosition, openerPosition: ChartPosition): Range {
    const response = this.vsOpen(position, openerBucket(openerPosition));
    if (!response.call.isEmpty) return response.call;
    return this.rfi(position).isEmpty ? Range.full(`${position} defend`) : this.rfi(position);
  }

  /** The range a player who 3-bet an open from `openerPosition` holds. */
  threeBetRange(position: ChartPosition, openerPosition: ChartPosition): Range {
    const response = this.vsOpen(position, openerBucket(openerPosition));
    if (!response.threeBet.isEmpty) return response.threeBet;
    return this.rfi(position);
  }
}

let loadedCharts: RangeCharts | null = null;

/** Installs the charts, replacing any previously loaded set. */
export function loadRangeCharts(json: RangeChartsJson): RangeCharts {
  loadedCharts = new RangeCharts(json);
  return loadedCharts;
}

/** The active charts. Throws if `loadRangeCharts` has not been called. */
export function getRangeCharts(): RangeCharts {
  if (loadedCharts === null) {
    throw new Error('Range charts have not been loaded; call loadRangeCharts() first');
  }
  return loadedCharts;
}

/** Convenience for tests and for the UI's range preview. */
export function parseRange(spec: RangeSpec, label = ''): Range {
  return Range.parse(spec, label);
}

export type { Rank, Suit };
