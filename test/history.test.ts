import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_RECORDS,
  STORAGE_KEY,
  appendRecord,
  clearHistory,
  computeStats,
  exportHistory,
  importHistory,
  isHandRecord,
  loadHistory,
  reviewable,
  saveHistory,
  type HandRecord,
} from '../src/game/history';
import { DEFAULT_SETTINGS } from '../src/game/types';

/** Minimal in-memory localStorage, since the engine tests run without a DOM. */
function installStorage(behaviour: 'ok' | 'throws' = 'ok'): Map<string, string> {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => {
      if (behaviour === 'throws') throw new Error('blocked');
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (behaviour === 'throws') throw new Error('quota');
      store.set(key, value);
    },
    removeItem: (key: string) => { store.delete(key); },
  };
  vi.stubGlobal('window', { localStorage: storage });
  return store;
}

let counter = 0;
function makeRecord(over: Partial<HandRecord> = {}): HandRecord {
  counter += 1;
  return {
    id: `id-${counter}`,
    seed: `SEED${counter}`,
    mode: 'outs',
    street: 'flop',
    playedAt: 1_700_000_000_000 + counter * 1000,
    passed: true,
    mistakes: [],
    input: {
      outs: 9, cleanOuts: 6, hitProbability: 35,
      equityBand: 'even', potOdds: 25, action: 'call',
    },
    truth: {
      outs: 9, cleanOuts: 6, hitProbability: 35, equityPercent: 50,
      equityBand: 'even', potOdds: 25, bestAction: 'call',
      acceptedActions: ['call'], heroCards: 'Ah Kh', board: 'Qh 7d 2c',
      heroClass: 'strongDraw',
    },
    timings: { outs: 4000, equity: 2000 },
    settings: DEFAULT_SETTINGS,
    ...over,
  };
}

beforeEach(() => {
  counter = 0;
  installStorage();
  clearHistory();
});

describe('storage', () => {
  it('round-trips records through localStorage', () => {
    const record = makeRecord();
    appendRecord(record);
    expect(loadHistory()).toEqual([record]);
  });

  it('keeps the newest records when the cap is reached', () => {
    const many = Array.from({ length: MAX_RECORDS + 25 }, () => makeRecord());
    saveHistory(many);
    const loaded = loadHistory();
    expect(loaded).toHaveLength(MAX_RECORDS);
    expect(loaded[loaded.length - 1]!.id).toBe(many[many.length - 1]!.id);
  });

  it('drops a malformed record without losing the rest', () => {
    // One bad row must not cost the whole history.
    const good = makeRecord();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      good, { id: 'broken' }, null, 'nonsense',
    ]));
    expect(loadHistory()).toEqual([good]);
  });

  it('survives unreadable or unwritable storage', () => {
    installStorage('throws');
    expect(() => loadHistory()).not.toThrow();
    expect(loadHistory()).toEqual([]);
    // Writing falls back to memory for the session rather than breaking.
    const record = makeRecord();
    expect(() => appendRecord(record)).not.toThrow();
    expect(loadHistory().map((r) => r.id)).toEqual([record.id]);
  });

  it('recovers from corrupt JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadHistory()).toEqual([]);
  });

  it('validates record shape', () => {
    expect(isHandRecord(makeRecord())).toBe(true);
    expect(isHandRecord(null)).toBe(false);
    expect(isHandRecord({ id: 'x' })).toBe(false);
  });
});

describe('export and import', () => {
  it('round-trips a full history', () => {
    const records = [makeRecord(), makeRecord()];
    const result = importHistory(exportHistory(records), []);
    expect(result.added).toBe(2);
    expect(result.records.map((r) => r.id)).toEqual(records.map((r) => r.id));
  });

  it('is idempotent: importing the same file twice adds nothing', () => {
    const records = [makeRecord(), makeRecord()];
    const text = exportHistory(records);
    const first = importHistory(text, []);
    const second = importHistory(text, first.records);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.records).toHaveLength(2);
  });

  it('merges two sessions in time order', () => {
    const older = makeRecord({ id: 'a', playedAt: 100 });
    const newer = makeRecord({ id: 'b', playedAt: 200 });
    const merged = importHistory(exportHistory([newer]), [older]);
    expect(merged.records.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('accepts a bare array as well as the wrapped export', () => {
    const record = makeRecord();
    expect(importHistory(JSON.stringify([record]), []).added).toBe(1);
  });

  it('rejects files that are not a history, with a readable message', () => {
    expect(() => importHistory('not json', [])).toThrow(/valid JSON/i);
    expect(() => importHistory('{"nope":1}', [])).toThrow(/history export/i);
  });

  it('skips malformed rows inside an otherwise good file', () => {
    const good = makeRecord();
    const result = importHistory(JSON.stringify([good, { id: 'bad' }]), []);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

describe('stats', () => {
  it('reports accuracy over every recorded decision', () => {
    const stats = computeStats([
      makeRecord({ passed: true }),
      makeRecord({ passed: false, mistakes: ['EQUITY_UNDER'] }),
      makeRecord({ passed: true }),
    ]);
    expect(stats.hands).toBe(3);
    expect(stats.passed).toBe(2);
    expect(stats.accuracy).toBeCloseTo(2 / 3, 9);
  });

  it('counts the current streak from the most recent hand backwards', () => {
    const stats = computeStats([
      makeRecord({ playedAt: 1, passed: true }),
      makeRecord({ playedAt: 2, passed: false, mistakes: ['TIMEOUT'] }),
      makeRecord({ playedAt: 3, passed: true }),
      makeRecord({ playedAt: 4, passed: true }),
    ]);
    expect(stats.currentStreak).toBe(2);
    expect(stats.bestStreak).toBe(2);
  });

  it('reports a zero streak when the last hand was missed', () => {
    const stats = computeStats([
      makeRecord({ playedAt: 1, passed: true }),
      makeRecord({ playedAt: 2, passed: false, mistakes: ['TIMEOUT'] }),
    ]);
    expect(stats.currentStreak).toBe(0);
    expect(stats.bestStreak).toBe(1);
  });

  it('counts each mistake once per hand, even when repeated', () => {
    const stats = computeStats([
      makeRecord({ passed: false, mistakes: ['EQUITY_UNDER', 'EQUITY_UNDER'] }),
      makeRecord({ passed: false, mistakes: ['EQUITY_UNDER', 'TIMEOUT'] }),
    ]);
    const equity = stats.byMistake.find((row) => row.category === 'EQUITY_UNDER');
    expect(equity?.count).toBe(2);
    expect(equity?.rate).toBeCloseTo(1, 9);
  });

  it('measures signed bias so a consistent lean is visible', () => {
    // Reads outs two low every time.
    const stats = computeStats([
      makeRecord({ input: { ...makeRecord().input, outs: 7 } }),
      makeRecord({ input: { ...makeRecord().input, outs: 7 } }),
    ]);
    expect(stats.outsBias.samples).toBe(2);
    expect(stats.outsBias.meanSignedError).toBeCloseTo(-2, 9);
    expect(stats.outsBias.meanAbsoluteError).toBeCloseTo(2, 9);
  });

  it('cancels opposite errors in the signed figure but not the absolute one', () => {
    const stats = computeStats([
      makeRecord({ input: { ...makeRecord().input, potOdds: 20 } }),
      makeRecord({ input: { ...makeRecord().input, potOdds: 30 } }),
    ]);
    expect(stats.potOddsBias.meanSignedError).toBeCloseTo(0, 9);
    expect(stats.potOddsBias.meanAbsoluteError).toBeCloseTo(5, 9);
  });

  it('expresses equity bias in bands, since equity is no longer a number', () => {
    const stats = computeStats([
      makeRecord({ input: { ...makeRecord().input, equityBand: 'behind' } }),
    ]);
    // 'behind' is one band below 'even'.
    expect(stats.equityBandBias.meanSignedError).toBeCloseTo(-1, 9);
  });

  it('ignores fields that were never answered', () => {
    const stats = computeStats([
      makeRecord({ input: { ...makeRecord().input, outs: null } }),
    ]);
    expect(stats.outsBias.samples).toBe(0);
    expect(stats.outsBias.meanSignedError).toBe(0);
  });

  it('handles an empty history without dividing by zero', () => {
    const stats = computeStats([]);
    expect(stats.accuracy).toBe(0);
    expect(stats.byMistake).toEqual([]);
    expect(stats.medianSecondsPerField).toEqual([]);
  });

  it('reports median time per field', () => {
    const stats = computeStats([
      makeRecord({ timings: { outs: 1000 } }),
      makeRecord({ timings: { outs: 3000 } }),
      makeRecord({ timings: { outs: 5000 } }),
    ]);
    expect(stats.medianSecondsPerField.find((r) => r.field === 'outs')?.seconds)
      .toBeCloseTo(3, 9);
  });
});

describe('review filtering', () => {
  const records = [
    makeRecord({ id: 'p', passed: true, playedAt: 10 }),
    makeRecord({ id: 'a', passed: false, mistakes: ['EQUITY_UNDER'], playedAt: 20 }),
    makeRecord({ id: 'b', passed: false, mistakes: ['TIMEOUT'], playedAt: 30 }),
    makeRecord({ id: 'c', passed: false, mistakes: ['EQUITY_UNDER', 'TIMEOUT'], playedAt: 40 }),
  ];

  it('shows only missed hands, newest first', () => {
    expect(reviewable(records, 'all').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('narrows to a single mistake category', () => {
    expect(reviewable(records, 'EQUITY_UNDER').map((r) => r.id)).toEqual(['c', 'a']);
    expect(reviewable(records, 'TIMEOUT').map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('returns nothing for a category that never occurred', () => {
    expect(reviewable(records, 'POT_ODDS_ARITHMETIC')).toEqual([]);
  });

  it('keeps the seed on every reviewable hand, so a spot can be quoted', () => {
    for (const record of reviewable(records, 'all')) {
      expect(record.seed.length).toBeGreaterThan(0);
      expect(record.settings).toBeDefined();
    }
  });
});
