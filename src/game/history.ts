/**
 * history.ts — what was played, persisted, and what it adds up to.
 *
 * Storage
 * -------
 * Records go to `localStorage`. Each carries the SEED, which regenerates the
 * hand exactly, so only the graded values are stored rather than the whole
 * truth object — a truth object contains a 169-entry range grid per opponent,
 * and a few hundred of those would exhaust the quota for no benefit. Anything
 * not stored is one seed replay away.
 *
 * `localStorage` is not always available — a private window, cleared site data,
 * a browser set to block storage, or a thumbnail capture can all make the
 * accessor throw rather than merely return null. Every read and write is
 * wrapped, and the app falls back to an in-memory list for the session rather
 * than breaking.
 */

import type { ActionKind } from '../engine/actionSolver';
import type {
  EquityBandId,
  FieldTimings,
  MistakeCategory,
  Settings,
  Street,
} from './types';

export const STORAGE_KEY = 'poker-trainer/history/v1';

/** How many hands to keep. Old ones are dropped oldest-first. */
export const MAX_RECORDS = 2000;

export type PlayedMode = 'outs' | 'preflop';

/** What hero answered. Nulls mean the field was not asked, or time ran out. */
export interface RecordedInput {
  readonly outs: number | null;
  readonly cleanOuts: number | null;
  readonly hitProbability: number | null;
  readonly equityBand: EquityBandId | null;
  readonly potOdds: number | null;
  readonly action: ActionKind | null;
}

/** The graded values. The seed regenerates everything else. */
export interface RecordedTruth {
  readonly outs: number | null;
  readonly cleanOuts: number | null;
  readonly hitProbability: number | null;
  readonly equityPercent: number | null;
  readonly equityBand: EquityBandId | null;
  readonly potOdds: number | null;
  readonly bestAction: ActionKind;
  readonly acceptedActions: readonly ActionKind[];
  /** For the review list, so hands are recognisable without replaying them. */
  readonly heroCards: string;
  readonly board: string;
  readonly heroClass: string;
}

export interface HandRecord {
  readonly id: string;
  readonly seed: string;
  readonly mode: PlayedMode;
  readonly street: Street;
  readonly playedAt: number;
  readonly passed: boolean;
  readonly mistakes: readonly MistakeCategory[];
  readonly input: RecordedInput;
  readonly truth: RecordedTruth;
  readonly timings: FieldTimings;
  /** Replaying needs the table it was dealt at. */
  readonly settings: Settings;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

/** Session fallback when localStorage is unavailable. */
let memoryFallback: HandRecord[] | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/** True when a record has the shape we can use. Anything else is dropped. */
export function isHandRecord(value: unknown): value is HandRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<HandRecord>;
  return typeof record.id === 'string'
    && typeof record.seed === 'string'
    && (record.mode === 'outs' || record.mode === 'preflop')
    && typeof record.passed === 'boolean'
    && Array.isArray(record.mistakes)
    && typeof record.playedAt === 'number'
    && record.truth !== undefined
    && record.input !== undefined
    && record.settings !== undefined;
}

export function loadHistory(): HandRecord[] {
  if (memoryFallback !== null) return memoryFallback;
  const raw = readRaw();
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter rather than reject: one malformed record must not lose the rest.
    return parsed.filter(isHandRecord);
  } catch {
    return [];
  }
}

export function saveHistory(records: readonly HandRecord[]): void {
  const trimmed = records.slice(-MAX_RECORDS);
  if (!writeRaw(JSON.stringify(trimmed))) {
    memoryFallback = [...trimmed];
  }
}

export function appendRecord(record: HandRecord): HandRecord[] {
  const next = [...loadHistory(), record].slice(-MAX_RECORDS);
  saveHistory(next);
  if (memoryFallback !== null) memoryFallback = next;
  return next;
}

export function clearHistory(): void {
  memoryFallback = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    memoryFallback = [];
  }
}

/** True when history is being held in memory because storage refused. */
export function isUsingMemoryFallback(): boolean {
  return memoryFallback !== null;
}

/* -------------------------------------------------------------------------- */
/* Export and import                                                           */
/* -------------------------------------------------------------------------- */

export function exportHistory(records: readonly HandRecord[]): string {
  return JSON.stringify({
    format: STORAGE_KEY,
    exportedAt: new Date().toISOString(),
    records,
  }, null, 2);
}

export interface ImportResult {
  readonly added: number;
  readonly skipped: number;
  readonly records: HandRecord[];
}

/**
 * Merges an exported file into the current history.
 *
 * Existing ids win, so importing the same file twice is a no-op rather than a
 * duplicate. Records are re-sorted by time so a merge of two sessions reads in
 * order.
 */
export function importHistory(text: string, current: readonly HandRecord[]): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const container = parsed as { records?: unknown };
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(container.records) ? container.records : null;
  if (incoming === null) {
    throw new Error('That file does not contain a history export.');
  }

  const byId = new Map(current.map((record) => [record.id, record]));
  let added = 0;
  let skipped = 0;
  for (const candidate of incoming) {
    if (!isHandRecord(candidate)) { skipped += 1; continue; }
    if (byId.has(candidate.id)) { skipped += 1; continue; }
    byId.set(candidate.id, candidate);
    added += 1;
  }
  const records = [...byId.values()]
    .sort((a, b) => a.playedAt - b.playedAt)
    .slice(-MAX_RECORDS);
  return { added, skipped, records };
}

/* -------------------------------------------------------------------------- */
/* Building a record                                                           */
/* -------------------------------------------------------------------------- */

/** A stable id that does not need a crypto API. */
function newId(seed: string, street: string, playedAt: number): string {
  return `${seed}:${street}:${playedAt.toString(36)}`;
}

/** Records one graded Outs decision. Flop and turn are separate records. */
export function recordOutsHand(
  truth: {
    seed: string; street: Street; heroCards: readonly { rank: string; suit: string }[];
    board: readonly { rank: string; suit: string }[]; heroClass: string;
    hitProbability: { outs: number; exact: number } | null;
    cleanOuts: { total: number } | null;
    equity: { percent: number }; potOdds: { percent: number };
    action: { best: ActionKind; accepted: readonly ActionKind[] };
  },
  input: RecordedInput & { timings: FieldTimings },
  grade: { passed: boolean; mistakes: readonly MistakeCategory[] },
  settings: Settings,
  equityBand: EquityBandId,
  playedAt = Date.now(),
): HandRecord {
  const show = (cards: readonly { rank: string; suit: string }[]) =>
    cards.map((card) => `${card.rank}${card.suit}`).join(' ');
  return {
    id: newId(truth.seed, truth.street, playedAt),
    seed: truth.seed,
    mode: 'outs',
    street: truth.street,
    playedAt,
    passed: grade.passed,
    mistakes: [...grade.mistakes],
    input: {
      outs: input.outs,
      cleanOuts: input.cleanOuts,
      hitProbability: input.hitProbability,
      equityBand: input.equityBand,
      potOdds: input.potOdds,
      action: input.action,
    },
    truth: {
      outs: truth.hitProbability?.outs ?? null,
      cleanOuts: truth.cleanOuts?.total ?? null,
      hitProbability: truth.hitProbability?.exact ?? null,
      equityPercent: truth.equity.percent,
      equityBand,
      potOdds: truth.potOdds.percent,
      bestAction: truth.action.best,
      acceptedActions: [...truth.action.accepted],
      heroCards: show(truth.heroCards),
      board: show(truth.board),
      heroClass: truth.heroClass,
    },
    timings: input.timings,
    settings,
  };
}

/** Records one graded Preflop decision. */
export function recordPreflopHand(
  truth: { seed: string; heroHandKey: string },
  given: ActionKind | null,
  grade: {
    passed: boolean; mistakes: readonly string[];
    best: ActionKind; accepted: readonly ActionKind[];
  },
  settings: Settings,
  playedAt = Date.now(),
): HandRecord {
  return {
    id: newId(truth.seed, 'preflop', playedAt),
    seed: truth.seed,
    mode: 'preflop',
    street: 'preflop',
    playedAt,
    passed: grade.passed,
    mistakes: grade.mistakes as MistakeCategory[],
    input: {
      outs: null, cleanOuts: null, hitProbability: null,
      equityBand: null, potOdds: null, action: given,
    },
    truth: {
      outs: null, cleanOuts: null, hitProbability: null,
      equityPercent: null, equityBand: null, potOdds: null,
      bestAction: grade.best,
      acceptedActions: [...grade.accepted],
      heroCards: truth.heroHandKey,
      board: '',
      heroClass: 'preflop',
    },
    timings: {},
    settings,
  };
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                       */
/* -------------------------------------------------------------------------- */

export interface FieldBias {
  /** Hands where the field was both asked and answered. */
  readonly samples: number;
  /** Mean SIGNED error. Negative means hero reads low. */
  readonly meanSignedError: number;
  /** Mean absolute error, for a sense of spread. */
  readonly meanAbsoluteError: number;
}

export interface Stats {
  readonly hands: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly byMode: ReadonlyArray<{ mode: PlayedMode; hands: number; accuracy: number }>;
  /** Every category seen, most frequent first. */
  readonly byMistake: ReadonlyArray<{
    category: MistakeCategory;
    count: number;
    /** Share of played hands carrying this mistake. */
    rate: number;
  }>;
  readonly outsBias: FieldBias;
  readonly cleanOutsBias: FieldBias;
  readonly hitProbabilityBias: FieldBias;
  readonly potOddsBias: FieldBias;
  /**
   * Signed band offset: negative means hero calls their equity lower than it is.
   * Bands replaced a numeric equity input, so a percentage-point error is no
   * longer measurable — this is the equivalent signal.
   */
  readonly equityBandBias: FieldBias;
  /** Median seconds per field, over hands where timings were recorded. */
  readonly medianSecondsPerField: ReadonlyArray<{ field: string; seconds: number }>;
}

const BAND_ORDER: readonly EquityBandId[] = [
  'wayBehind', 'behind', 'even', 'ahead', 'wayAhead',
];

function bias(pairs: ReadonlyArray<readonly [number, number]>): FieldBias {
  if (pairs.length === 0) {
    return { samples: 0, meanSignedError: 0, meanAbsoluteError: 0 };
  }
  let signed = 0;
  let absolute = 0;
  for (const [given, truth] of pairs) {
    signed += given - truth;
    absolute += Math.abs(given - truth);
  }
  return {
    samples: pairs.length,
    meanSignedError: signed / pairs.length,
    meanAbsoluteError: absolute / pairs.length,
  };
}

function pairsOf(
  records: readonly HandRecord[],
  pick: (record: HandRecord) => readonly [number | null, number | null],
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const record of records) {
    const [given, truth] = pick(record);
    if (given === null || truth === null) continue;
    out.push([given, truth]);
  }
  return out;
}

export function computeStats(records: readonly HandRecord[]): Stats {
  const hands = records.length;
  const passed = records.filter((record) => record.passed).length;

  // Streaks run over hands in the order they were played.
  const ordered = [...records].sort((a, b) => a.playedAt - b.playedAt);
  let currentStreak = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (!(ordered[i] as HandRecord).passed) break;
    currentStreak += 1;
  }
  let bestStreak = 0;
  let running = 0;
  for (const record of ordered) {
    running = record.passed ? running + 1 : 0;
    if (running > bestStreak) bestStreak = running;
  }

  const mistakeCounts = new Map<MistakeCategory, number>();
  for (const record of records) {
    // A hand can carry several mistakes; count each once per hand.
    for (const category of new Set(record.mistakes)) {
      mistakeCounts.set(category, (mistakeCounts.get(category) ?? 0) + 1);
    }
  }

  const modes: PlayedMode[] = ['outs', 'preflop'];
  const byMode = modes
    .map((mode) => {
      const subset = records.filter((record) => record.mode === mode);
      return {
        mode,
        hands: subset.length,
        accuracy: subset.length === 0
          ? 0
          : subset.filter((r) => r.passed).length / subset.length,
      };
    })
    .filter((row) => row.hands > 0);

  const bandIndex = (id: EquityBandId | null): number | null => {
    if (id === null) return null;
    const index = BAND_ORDER.indexOf(id);
    return index < 0 ? null : index;
  };

  const timingTotals = new Map<string, number[]>();
  for (const record of records) {
    for (const [field, ms] of Object.entries(record.timings)) {
      if (typeof ms !== 'number') continue;
      const list = timingTotals.get(field) ?? [];
      list.push(ms);
      timingTotals.set(field, list);
    }
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number);
  };

  return {
    hands,
    passed,
    accuracy: hands === 0 ? 0 : passed / hands,
    currentStreak,
    bestStreak,
    byMode,
    byMistake: [...mistakeCounts.entries()]
      .map(([category, count]) => ({
        category,
        count,
        rate: hands === 0 ? 0 : count / hands,
      }))
      .sort((a, b) => b.count - a.count),
    outsBias: bias(pairsOf(records, (r) => [r.input.outs, r.truth.outs])),
    cleanOutsBias: bias(pairsOf(records, (r) => [r.input.cleanOuts, r.truth.cleanOuts])),
    hitProbabilityBias: bias(
      pairsOf(records, (r) => [r.input.hitProbability, r.truth.hitProbability]),
    ),
    potOddsBias: bias(pairsOf(records, (r) => [r.input.potOdds, r.truth.potOdds])),
    equityBandBias: bias(pairsOf(records, (r) =>
      [bandIndex(r.input.equityBand), bandIndex(r.truth.equityBand)])),
    medianSecondsPerField: [...timingTotals.entries()]
      .map(([field, values]) => ({ field, seconds: median(values) / 1000 }))
      .sort((a, b) => b.seconds - a.seconds),
  };
}

/** Hands hero got wrong, newest first, optionally narrowed to one mistake. */
export function reviewable(
  records: readonly HandRecord[],
  category: MistakeCategory | 'all',
): HandRecord[] {
  return records
    .filter((record) => !record.passed)
    .filter((record) => category === 'all' || record.mistakes.includes(category))
    .sort((a, b) => b.playedAt - a.playedAt);
}
