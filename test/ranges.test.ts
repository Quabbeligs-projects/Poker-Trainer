import { describe, expect, it } from 'vitest';

import rangesJson from '../src/data/ranges.json';
import {
  CHART_POSITIONS,
  COMBO_COUNT,
  type ChartPosition,
  HAND_GRID,
  Range,
  RangeCharts,
  type RangeChartsJson,
  RangeSampler,
  comboCards,
  comboIndex,
  combosOfHandKey,
  expandNotation,
  handKeyOfCombo,
  openerBucket,
  seatPositions,
} from '../src/engine/ranges';
import { codeFromString, codeToString, createRng } from '../src/engine/deck';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);

function keysOf(notation: string): string[] {
  const keys = new Set<string>();
  for (const index of expandNotation(notation)) keys.add(handKeyOfCombo(index));
  return [...keys].sort();
}

describe('combo indexing', () => {
  it('assigns every one of the 1326 combos a unique index', () => {
    const seen = new Set<number>();
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        const index = comboIndex(a, b);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(COMBO_COUNT);
        expect(seen.has(index)).toBe(false);
        seen.add(index);
        // Order must not matter.
        expect(comboIndex(b, a)).toBe(index);
      }
    }
    expect(seen.size).toBe(COMBO_COUNT);
  });

  it('round-trips an index back to its two cards', () => {
    for (let index = 0; index < COMBO_COUNT; index++) {
      const [hi, lo] = comboCards(index);
      expect(hi).toBeGreaterThan(lo);
      expect(comboIndex(hi, lo)).toBe(index);
    }
  });

  it('rejects a combo made of one card twice', () => {
    expect(() => comboIndex(7, 7)).toThrow();
  });
});

describe('hand keys and the 13x13 grid', () => {
  it('has 169 distinct keys covering all 1326 combos', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < COMBO_COUNT; i++) {
      const key = handKeyOfCombo(i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(169);
    let pairs = 0;
    let suited = 0;
    let offsuit = 0;
    for (const [key, count] of counts) {
      if (key.length === 2) { expect(count).toBe(6); pairs++; }
      else if (key.endsWith('s')) { expect(count).toBe(4); suited++; }
      else { expect(count).toBe(12); offsuit++; }
    }
    expect(pairs).toBe(13);
    expect(suited).toBe(78);
    expect(offsuit).toBe(78);
    expect(13 * 6 + 78 * 4 + 78 * 12).toBe(COMBO_COUNT);
  });

  it('lays the grid out with pairs on the diagonal and suited above it', () => {
    expect(HAND_GRID).toHaveLength(13);
    expect(HAND_GRID[0]).toHaveLength(13);
    expect(HAND_GRID[0]![0]).toBe('AA');
    expect(HAND_GRID[0]![1]).toBe('AKs');
    expect(HAND_GRID[1]![0]).toBe('AKo');
    expect(HAND_GRID[12]![12]).toBe('22');
    expect(HAND_GRID[12]![0]).toBe('A2o');
    expect(HAND_GRID[0]![12]).toBe('A2s');
  });

  it('maps hand keys back to the right combos', () => {
    expect(combosOfHandKey('AA')).toHaveLength(6);
    expect(combosOfHandKey('AKs')).toHaveLength(4);
    expect(combosOfHandKey('AKo')).toHaveLength(12);
    const aks = combosOfHandKey('AKs').map((i) => comboCards(i).map(codeToString).join(''));
    expect(aks.sort()).toEqual(['AcKc', 'AdKd', 'AhKh', 'AsKs'].sort());
  });
});

describe('notation expansion', () => {
  it('expands a single pair', () => {
    expect(expandNotation('77')).toHaveLength(6);
    expect(keysOf('77')).toEqual(['77']);
  });

  it('expands pair-plus ranges', () => {
    expect(keysOf('TT+')).toEqual(['AA', 'JJ', 'KK', 'QQ', 'TT'].sort());
    expect(expandNotation('22+')).toHaveLength(13 * 6);
  });

  it('expands pair dash ranges in either direction', () => {
    expect(keysOf('77-TT')).toEqual(['77', '88', '99', 'TT']);
    expect(keysOf('TT-77')).toEqual(['77', '88', '99', 'TT']);
  });

  it('expands suited and offsuit hands to the right combo counts', () => {
    expect(expandNotation('AJs')).toHaveLength(4);
    expect(expandNotation('AJo')).toHaveLength(12);
    expect(expandNotation('AJ')).toHaveLength(16);
    expect(keysOf('AJ')).toEqual(['AJo', 'AJs']);
  });

  it('walks the LOW card upward for a non-pair plus range', () => {
    // PokerStove convention: the high card is fixed.
    expect(keysOf('AJs+')).toEqual(['AJs', 'AKs', 'AQs']);
    expect(keysOf('AQo+')).toEqual(['AKo', 'AQo']);
    expect(keysOf('K9s+')).toEqual(['K9s', 'KJs', 'KQs', 'KTs']);
    // The degenerate case: 76s+ is just 76s, because 77 is a pair.
    expect(keysOf('76s+')).toEqual(['76s']);
  });

  it('expands same-high-card dash ranges', () => {
    expect(keysOf('A5s-A2s')).toEqual(['A2s', 'A3s', 'A4s', 'A5s']);
    expect(keysOf('A2s-A5s')).toEqual(['A2s', 'A3s', 'A4s', 'A5s']);
  });

  it('expands same-gap diagonal dash ranges', () => {
    expect(keysOf('T9s-54s')).toEqual(['54s', '65s', '76s', '87s', '98s', 'T9s']);
    expect(keysOf('86s-53s')).toEqual(['53s', '64s', '75s', '86s']);
  });

  it('expands explicit combos', () => {
    const combos = expandNotation('AsKh');
    expect(combos).toHaveLength(1);
    expect(comboCards(combos[0]!).map(codeToString).sort())
      .toEqual(['As', 'Kh'].sort());
  });

  it('expands the full range', () => {
    expect(expandNotation('random')).toHaveLength(COMBO_COUNT);
    expect(expandNotation('any2')).toHaveLength(COMBO_COUNT);
  });

  it('throws on anything it cannot parse rather than silently dropping it', () => {
    for (const bad of ['', 'XX', '77s', 'AJx', 'A', 'AJs-KQs', '10s+', 'AsAs']) {
      expect(() => expandNotation(bad), `expected "${bad}" to throw`).toThrow();
    }
  });
});

describe('Range', () => {
  it('computes weights, combo counts and percentages', () => {
    const range = Range.parse(['AA', 'KK']);
    expect(range.comboCount).toBe(12);
    expect(range.totalWeight).toBe(12);
    expect(range.percentOfHands).toBeCloseTo((12 / COMBO_COUNT) * 100, 10);

    const full = Range.full();
    expect(full.comboCount).toBe(COMBO_COUNT);
    expect(full.percentOfHands).toBeCloseTo(100, 10);
    expect(Range.empty().isEmpty).toBe(true);
  });

  it('honours per-entry weights and keeps the highest on overlap', () => {
    const range = Range.parse([{ hand: 'AA', weight: 0.25 }]);
    expect(range.totalWeight).toBeCloseTo(1.5, 10);

    const overlapping = Range.parse([{ hand: '22+', weight: 0.5 }, 'AA']);
    expect(overlapping.weightOfCards(codeFromString('As'), codeFromString('Ah'))).toBe(1);
    expect(overlapping.weightOfCards(codeFromString('Ks'), codeFromString('Kh'))).toBe(0.5);

    // Order must not change the outcome.
    const reversed = Range.parse(['AA', { hand: '22+', weight: 0.5 }]);
    expect(reversed.weightOfCards(codeFromString('As'), codeFromString('Ah'))).toBe(1);
  });

  it('rejects out-of-bounds weights', () => {
    expect(() => Range.parse([{ hand: 'AA', weight: 1.5 }])).toThrow();
    expect(() => Range.parse([{ hand: 'AA', weight: -0.1 }])).toThrow();
  });

  it('removes combos blocked by known cards', () => {
    const range = Range.parse(['AA']);
    const blocked = range.removeCards([codeFromString('As')]);
    // Removing one ace leaves the 3 combos among the other three aces.
    expect(blocked.comboCount).toBe(3);
    expect(range.comboCount).toBe(6); // original untouched
  });

  it('is immutable under transformation', () => {
    const range = Range.parse(['AA', 'KK']);
    const halved = range.map((w) => w * 0.5);
    expect(range.totalWeight).toBe(12);
    expect(halved.totalWeight).toBeCloseTo(6, 10);
  });

  it('unions by taking the higher weight', () => {
    const a = Range.parse([{ hand: 'AA', weight: 0.3 }]);
    const b = Range.parse([{ hand: 'AA', weight: 0.7 }, 'KK']);
    const union = a.union(b);
    expect(union.weightOfCards(codeFromString('As'), codeFromString('Ah'))).toBeCloseTo(0.7, 10);
    expect(union.comboCount).toBe(12);
  });

  it('reports weights per hand key for the 13x13 grid', () => {
    const grid = Range.parse(['AA', { hand: 'AKs', weight: 0.5 }]).handKeyWeights();
    expect(grid.get('AA')).toEqual({ weight: 6, combos: 6, maxWeight: 1 });
    expect(grid.get('AKs')!.weight).toBeCloseTo(2, 10);
    expect(grid.get('AKs')!.combos).toBe(4);
    expect(grid.has('KK')).toBe(false);
  });
});

describe('RangeSampler', () => {
  it('samples in proportion to weight', () => {
    // AA at full weight, KK at quarter weight: AA should appear ~4x as often.
    const range = Range.parse(['AA', { hand: 'KK', weight: 0.25 }]);
    const sampler = new RangeSampler(range);
    const rng = createRng('sampler');
    let aces = 0;
    let kings = 0;
    const draws = 200_000;
    for (let i = 0; i < draws; i++) {
      const key = handKeyOfCombo(sampler.sample(rng.next()));
      if (key === 'AA') aces++;
      else if (key === 'KK') kings++;
      else throw new Error(`Sampled a hand outside the range: ${key}`);
    }
    expect(aces + kings).toBe(draws);
    expect(aces / draws).toBeCloseTo(0.8, 2);
    expect(kings / draws).toBeCloseTo(0.2, 2);
  });

  it('covers every combo in the range', () => {
    const range = Range.parse(['22+', 'AKs']);
    const sampler = new RangeSampler(range);
    const rng = createRng('coverage');
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i++) seen.add(sampler.sample(rng.next()));
    expect(seen.size).toBe(range.comboCount);
  });
});

describe('table-size to 6-max seat mapping', () => {
  it('maps 6-max onto itself', () => {
    expect(seatPositions(6).map((s) => s.chart)).toEqual(
      ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    );
    expect(seatPositions(6).map((s) => s.display)).toEqual(
      ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    );
  });

  it('always ends with BTN, SB, BB for three or more players', () => {
    for (let n = 3; n <= 10; n++) {
      const charts = seatPositions(n).map((s) => s.chart);
      expect(charts.slice(-3)).toEqual(['BTN', 'SB', 'BB']);
      expect(charts).toHaveLength(n);
    }
  });

  it('handles heads-up and the solo drilling case', () => {
    expect(seatPositions(2).map((s) => s.chart)).toEqual(['BTN', 'BB']);
    expect(seatPositions(1).map((s) => s.chart)).toEqual(['BTN']);
  });

  it('splits extra early seats into UTG then MP, extra seat to UTG', () => {
    expect(seatPositions(7).map((s) => s.chart)).toEqual(
      ['UTG', 'UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    );
    expect(seatPositions(9).map((s) => s.chart)).toEqual(
      ['UTG', 'UTG', 'UTG', 'MP', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    );
    expect(seatPositions(10).map((s) => s.chart)).toEqual(
      ['UTG', 'UTG', 'UTG', 'MP', 'MP', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    );
  });

  it('gives duplicated chart positions distinct display labels', () => {
    expect(seatPositions(9).map((s) => s.display)).toEqual(
      ['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'CO', 'BTN', 'SB', 'BB'],
    );
  });

  it('rejects impossible table sizes', () => {
    for (const n of [0, -1, 11, 2.5]) expect(() => seatPositions(n)).toThrow();
  });

  it('buckets openers for chart lookup', () => {
    expect(openerBucket('UTG')).toBe('early');
    expect(openerBucket('MP')).toBe('early');
    expect(openerBucket('CO')).toBe('middle');
    expect(openerBucket('BTN')).toBe('late');
    expect(openerBucket('SB')).toBe('sb');
    expect(() => openerBucket('BB')).toThrow();
  });
});

describe('bundled ranges.json', () => {
  it('parses without error', () => {
    expect(() => new RangeCharts(rangesJson as unknown as RangeChartsJson)).not.toThrow();
  });

  it('opens tighter from early position than from late position', () => {
    const percents = CHART_POSITIONS
      .filter((p): p is ChartPosition => p !== 'BB')
      .map((p) => charts.rfi(p).percentOfHands);
    const [utg, mp, co, btn] = percents as [number, number, number, number];
    expect(utg).toBeLessThan(mp);
    expect(mp).toBeLessThan(co);
    expect(co).toBeLessThan(btn);
  });

  it('keeps opening ranges inside sane bounds', () => {
    const bounds: Record<string, [number, number]> = {
      UTG: [12, 20],
      MP: [16, 24],
      CO: [22, 32],
      BTN: [38, 52],
      SB: [32, 48],
    };
    for (const [position, [min, max]] of Object.entries(bounds)) {
      const percent = charts.rfi(position as ChartPosition).percentOfHands;
      expect(percent, `${position} opens ${percent.toFixed(1)}%`).toBeGreaterThanOrEqual(min);
      expect(percent, `${position} opens ${percent.toFixed(1)}%`).toBeLessThanOrEqual(max);
    }
  });

  it('gives the big blind no opening range (it is never first in)', () => {
    expect(charts.rfi('BB').isEmpty).toBe(true);
  });

  it('always contains the strongest hands in every value range', () => {
    const aces = combosOfHandKey('AA');
    for (const position of ['UTG', 'MP', 'CO', 'BTN', 'SB'] as ChartPosition[]) {
      for (const combo of aces) {
        expect(charts.rfi(position).weightOf(combo)).toBeGreaterThan(0);
      }
    }
    for (const position of ['CO', 'BTN', 'SB', 'BB'] as ChartPosition[]) {
      const threeBet = charts.vsOpen(position, 'middle').threeBet;
      if (threeBet.isEmpty) continue;
      for (const combo of aces) expect(threeBet.weightOf(combo)).toBeGreaterThan(0);
    }
  });

  it('defends the blinds wider than it opens from early position', () => {
    const bbVsButton = charts.vsOpen('BB', 'late').call.percentOfHands;
    expect(bbVsButton).toBeGreaterThan(charts.rfi('UTG').percentOfHands);
  });

  it('never returns an empty range from the defend helpers', () => {
    for (const hero of CHART_POSITIONS) {
      for (const opener of ['UTG', 'MP', 'CO', 'BTN', 'SB'] as ChartPosition[]) {
        expect(charts.callingRange(hero, opener).isEmpty).toBe(false);
        expect(charts.threeBetRange(hero, opener).isEmpty).toBe(false);
      }
    }
  });

  it('reports every chart percentage for eyeball review', () => {
    const lines: string[] = [];
    for (const position of CHART_POSITIONS) {
      const rfi = charts.rfi(position);
      if (!rfi.isEmpty) {
        lines.push(`      RFI  ${position.padEnd(4)} ${rfi.percentOfHands.toFixed(1).padStart(5)}%  (${rfi.comboCount} combos)`);
      }
    }
    for (const position of CHART_POSITIONS) {
      for (const bucket of ['early', 'middle', 'late', 'sb'] as const) {
        const response = charts.vsOpen(position, bucket);
        if (response.call.isEmpty && response.threeBet.isEmpty) continue;
        lines.push(
          `      vs ${bucket.padEnd(6)} ${position.padEnd(4)} call ${response.call.percentOfHands.toFixed(1).padStart(5)}%   3bet ${response.threeBet.percentOfHands.toFixed(1).padStart(5)}%`,
        );
      }
    }
    console.log(`\n    Chart coverage:\n${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
