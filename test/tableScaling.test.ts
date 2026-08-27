import { describe, expect, it } from 'vitest';

import rangesJson from '../src/data/ranges.json';
import handStrengthJson from '../src/data/handStrength.json';
import {
  type ChartPosition,
  HAND_GRID,
  Range,
  RangeCharts,
  type RangeChartsJson,
  combosOfHandKey,
  seatPositions,
} from '../src/engine/ranges';
import {
  MIN_WIDTH_FACTOR,
  SIX_MAX_PLAYERS_BEHIND,
  WIDTH_FACTOR_PER_EXTRA_PLAYER,
  handOrdering,
  playersBehind,
  scaleRangeWidth,
  tableAdjustedResponse,
  tableAdjustedRfi,
  tableSeats,
  trimToWeight,
} from '../src/engine/tableScaling';
import { computeEquity } from '../src/engine/equity';
import { comboCards } from '../src/engine/ranges';
import { createRng } from '../src/engine/deck';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const equityVsRandom = (handStrengthJson as { equityVsRandom: Record<string, number> })
  .equityVsRandom;

describe('players behind', () => {
  it('counts the players still to act after hero', () => {
    expect(playersBehind(0, 9)).toBe(8);
    expect(playersBehind(8, 9)).toBe(0);
    expect(playersBehind(3, 6)).toBe(2); // 6-max button
    expect(playersBehind(5, 6)).toBe(0); // 6-max big blind
  });

  it('rejects seats that do not exist at that table size', () => {
    expect(() => playersBehind(6, 6)).toThrow();
    expect(() => playersBehind(-1, 6)).toThrow();
  });

  it('derives the 6-max baseline from the seat mapping', () => {
    expect(SIX_MAX_PLAYERS_BEHIND).toEqual({
      UTG: 5, MP: 4, CO: 3, BTN: 2, SB: 1, BB: 0,
    });
  });
});

describe('seat mapping is driven by players behind, not table size', () => {
  it('gives a seat the same chart whenever it has the same players behind', () => {
    const chartByBehind = new Map<number, ChartPosition>();
    for (let n = 3; n <= 10; n++) {
      for (const seat of seatPositions(n)) {
        const behind = playersBehind(seat.seatIndex, n);
        if (behind >= 5) continue; // everything past 5 shares the UTG chart
        const existing = chartByBehind.get(behind);
        if (existing === undefined) chartByBehind.set(behind, seat.chart);
        else expect(seat.chart, `${n}-handed seat with ${behind} behind`).toBe(existing);
      }
    }
    expect(chartByBehind.get(0)).toBe('BB');
    expect(chartByBehind.get(1)).toBe('SB');
    expect(chartByBehind.get(2)).toBe('BTN');
    expect(chartByBehind.get(3)).toBe('CO');
    expect(chartByBehind.get(4)).toBe('MP');
  });

  it('gives a seat the same opening width whenever it has the same players behind', () => {
    const widthByBehind = new Map<number, number>();
    for (let n = 3; n <= 10; n++) {
      for (const seat of tableSeats(n)) {
        const width = tableAdjustedRfi(charts, n, seat.seatIndex).percentOfHands;
        if (width === 0) continue;
        const existing = widthByBehind.get(seat.playersBehind);
        if (existing === undefined) widthByBehind.set(seat.playersBehind, width);
        else {
          expect(width, `${n}-handed, ${seat.playersBehind} behind`).toBeCloseTo(existing, 6);
        }
      }
    }
  });

  it('always ends with BTN, SB, BB for three or more players', () => {
    for (let n = 3; n <= 10; n++) {
      expect(seatPositions(n).map((s) => s.chart).slice(-3)).toEqual(['BTN', 'SB', 'BB']);
    }
  });
});

describe('the RFI charts are nested, which the trimming order depends on', () => {
  it('UTG is a subset of MP is a subset of CO is a subset of BTN', () => {
    const order: ChartPosition[] = ['UTG', 'MP', 'CO', 'BTN'];
    for (let i = 0; i + 1 < order.length; i++) {
      const tighter = charts.rfi(order[i] as ChartPosition);
      const wider = charts.rfi(order[i + 1] as ChartPosition);
      const missing: string[] = [];
      for (const row of HAND_GRID) {
        for (const key of row) {
          for (const combo of combosOfHandKey(key)) {
            if (tighter.weightOf(combo) > 0 && wider.weightOf(combo) === 0) {
              if (!missing.includes(key)) missing.push(key);
            }
          }
        }
      }
      expect(missing, `${order[i]} hands absent from ${order[i + 1]}`).toEqual([]);
    }
  });
});

describe('width scaling reproduces published full-ring ranges', () => {
  it('matches standard 9-handed opening widths', () => {
    // Published full-ring opening widths, with a tolerance wide enough to
    // absorb differences between chart authors but tight enough to catch a
    // scaling rule that is simply wrong.
    const expected: Array<[number, number, number]> = [
      // [players behind, published %, tolerance]
      [8, 10.5, 2.0], // UTG 9-handed
      [7, 12.0, 2.0], // UTG+1
      [6, 13.5, 2.0], // UTG+2
      [5, 15.0, 2.5], // LJ
      [4, 19.0, 2.0], // HJ
      [3, 25.0, 2.5], // CO
      [2, 43.0, 3.0], // BTN
    ];
    const seats = tableSeats(9);
    const rows: string[] = [];
    for (const [behind, published, tolerance] of expected) {
      const seat = seats.find((s) => s.playersBehind === behind);
      expect(seat, `no 9-handed seat with ${behind} behind`).toBeDefined();
      const width = tableAdjustedRfi(charts, 9, seat!.seatIndex).percentOfHands;
      rows.push(
        `      ${seat!.display.padEnd(6)} ${String(behind).padStart(2)} behind`
        + `   rule ${width.toFixed(1).padStart(5)}%   published ~${published}%`,
      );
      expect(
        Math.abs(width - published),
        `${seat!.display} (${behind} behind): rule says ${width.toFixed(1)}%, published ~${published}%`,
      ).toBeLessThanOrEqual(tolerance);
    }
    console.log(`\n    9-HANDED OPENING WIDTHS\n${rows.join('\n')}\n`);
  });

  it('leaves 6-max charts untouched', () => {
    for (const seat of tableSeats(6)) {
      expect(seat.widthFactor).toBe(1);
      const scaled = tableAdjustedRfi(charts, 6, seat.seatIndex);
      expect(scaled.percentOfHands).toBeCloseTo(charts.rfi(seat.chart).percentOfHands, 6);
    }
  });

  it('never widens a range, only tightens it', () => {
    for (let n = 3; n <= 10; n++) {
      for (const seat of tableSeats(n)) {
        expect(seat.widthFactor).toBeLessThanOrEqual(1);
        const scaled = tableAdjustedRfi(charts, n, seat.seatIndex);
        expect(scaled.totalWeight).toBeLessThanOrEqual(charts.rfi(seat.chart).totalWeight + 1e-9);
      }
    }
  });

  it('tightens monotonically as players are added behind hero', () => {
    // Restricted to non-blind seats. The small blind is a deliberate exception:
    // it has only one player behind but opens tighter than the button because
    // it is out of position postflop and guaranteed to face the big blind.
    // That exception is asserted separately below.
    for (let n = 3; n <= 10; n++) {
      const widths = tableSeats(n)
        .filter((s) => s.playersBehind >= 2)
        .map((s) => ({ behind: s.playersBehind, width: tableAdjustedRfi(charts, n, s.seatIndex).percentOfHands }))
        .filter((r) => r.width > 0)
        .sort((a, b) => a.behind - b.behind);
      for (let i = 1; i < widths.length; i++) {
        expect(
          widths[i]!.width,
          `${n}-handed: ${widths[i]!.behind} behind should not open wider than ${widths[i - 1]!.behind} behind`,
        ).toBeLessThanOrEqual(widths[i - 1]!.width + 1e-9);
      }
    }
  });

  it('keeps the small blind tighter than the button, the documented exception', () => {
    // Fewer players behind, but out of position postflop against a blind that
    // never folds for free. Any monotonic-in-players-behind rule must not be
    // applied to the blinds, which is why the seat mapping handles them by name.
    for (let n = 3; n <= 10; n++) {
      const seats = tableSeats(n);
      const sb = seats.find((s) => s.chart === 'SB')!;
      const btn = seats.find((s) => s.chart === 'BTN')!;
      expect(sb.playersBehind).toBeLessThan(btn.playersBehind);
      expect(tableAdjustedRfi(charts, n, sb.seatIndex).percentOfHands)
        .toBeLessThan(tableAdjustedRfi(charts, n, btn.seatIndex).percentOfHands);
    }
  });

  it('applies the documented multiplier exactly', () => {
    const utg = charts.rfi('UTG').totalWeight;
    const seats = tableSeats(9);
    const eightBehind = seats.find((s) => s.playersBehind === 8)!;
    expect(eightBehind.widthFactor).toBeCloseTo(WIDTH_FACTOR_PER_EXTRA_PLAYER ** 3, 12);
    expect(tableAdjustedRfi(charts, 9, eightBehind.seatIndex).totalWeight)
      .toBeCloseTo(utg * WIDTH_FACTOR_PER_EXTRA_PLAYER ** 3, 6);
  });

  it('respects the minimum width floor', () => {
    // The floor is not reached in normal play, but must hold if the constant changes.
    for (let behind = 5; behind <= 20; behind++) {
      const factor = Math.max(MIN_WIDTH_FACTOR, WIDTH_FACTOR_PER_EXTRA_PLAYER ** (behind - 5));
      expect(factor).toBeGreaterThanOrEqual(MIN_WIDTH_FACTOR);
    }
  });

  it('scales defending ranges too', () => {
    // Seat 1 uses the UTG chart at both table sizes and faces an open from
    // seat 0 at both, but has 5 players behind at 7-handed and 7 at 9-handed.
    const sevenHanded = tableAdjustedResponse(charts, 7, 1, 'UTG');
    const nineHanded = tableAdjustedResponse(charts, 9, 1, 'UTG');
    expect(sevenHanded.call.totalWeight).toBeGreaterThan(0);
    expect(nineHanded.call.totalWeight).toBeLessThan(sevenHanded.call.totalWeight);
    expect(nineHanded.threeBet.totalWeight).toBeLessThan(sevenHanded.threeBet.totalWeight);
  });

  it('has a defending range for every seat that can actually face an open', () => {
    // At 7+ handed an early seat can face an even earlier open. Without a chart
    // entry for that spot the engine would fall back to the opening range,
    // which would be wrong in Preflop mode.
    for (let n = 3; n <= 10; n++) {
      const seats = tableSeats(n);
      for (const seat of seats) {
        for (const opener of seats) {
          if (opener.seatIndex >= seat.seatIndex) continue; // must act before hero
          if (opener.chart === 'BB') continue;              // BB never opens
          const response = tableAdjustedResponse(charts, n, seat.seatIndex, opener.chart);
          expect(
            response.call.isEmpty && response.threeBet.isEmpty,
            `${n}-handed: ${seat.display} has no response to a ${opener.display} open`,
          ).toBe(false);
        }
      }
    }
  });
});

describe('heads-up is authored, not scaled', () => {
  it('uses the dedicated heads-up button chart', () => {
    const btn = tableAdjustedRfi(charts, 2, 0);
    expect(btn.percentOfHands).toBeGreaterThan(75);
    expect(btn.percentOfHands).toBeLessThan(95);
    // Emphatically not the 6-max button chart.
    expect(btn.percentOfHands).toBeGreaterThan(charts.rfi('BTN').percentOfHands + 20);
  });

  it('defends the big blind wide against a heads-up open', () => {
    const defence = tableAdjustedResponse(charts, 2, 1, 'BTN');
    const total = defence.call.percentOfHands + defence.threeBet.percentOfHands;
    expect(total).toBeGreaterThan(55);
    expect(defence.threeBet.percentOfHands).toBeGreaterThan(5);
  });

  it('gives the big blind no opening range', () => {
    expect(tableAdjustedRfi(charts, 2, 1).isEmpty).toBe(true);
  });

  it('never applies a width factor at 2 players', () => {
    for (const seat of tableSeats(2)) expect(seat.widthFactor).toBe(1);
  });
});

describe('the trimming order does not depend on the environment', () => {
  it('breaks ties by code unit, not by locale collation', () => {
    // This tie-break decides which hands survive table-size trimming, which
    // changes opponent ranges, which changes graded truth. localeCompare would
    // make that depend on the ICU data a particular Node build ships, so the
    // ordering is pinned here: a switch back to locale collation breaks it.
    const ordering = handOrdering(charts);
    expect(ordering.keys).toHaveLength(169);
    expect(new Set(ordering.keys).size).toBe(169);
    // Strongest first, weakest last, with the exact sequence recorded.
    expect(ordering.keys[0]).toBe('AA');
    expect(ordering.keys[ordering.keys.length - 1]).toBe('32o');
    // Tier dominates: every UTG-tier hand precedes every untiered hand.
    const lastTiered = Math.max(
      ...ordering.keys.map((key, i) => (ordering.tiers.get(key)! < 4 ? i : -1)),
    );
    const firstUntiered = ordering.keys.findIndex((key) => ordering.tiers.get(key) === 4);
    expect(firstUntiered).toBeGreaterThan(-1);
    expect(firstUntiered).toBeGreaterThan(lastTiered - ordering.keys.length);
  });

  it('is byte-identical across repeated construction', () => {
    const a = handOrdering(new RangeCharts(rangesJson as unknown as RangeChartsJson));
    const b = handOrdering(new RangeCharts(rangesJson as unknown as RangeChartsJson));
    expect(b.keys.join(',')).toBe(a.keys.join(','));
  });
});

describe('trimming', () => {
  const ordering = handOrdering(charts);

  it('hits the target weight exactly', () => {
    const btn = charts.rfi('BTN');
    for (const fraction of [0.9, 0.75, 0.5, 0.25, 0.1]) {
      const target = btn.totalWeight * fraction;
      expect(trimToWeight(btn, target, ordering).totalWeight).toBeCloseTo(target, 6);
    }
  });

  it('keeps the strongest hands and drops the weakest', () => {
    const btn = charts.rfi('BTN');
    const trimmed = trimToWeight(btn, btn.totalWeight * 0.4, ordering);
    // Aces survive any trim.
    for (const combo of combosOfHandKey('AA')) expect(trimmed.weightOf(combo)).toBe(1);
    // Button-only junk does not.
    for (const combo of combosOfHandKey('K2s')) expect(trimmed.weightOf(combo)).toBe(0);
  });

  it('prefers a chart-tier hand over a higher-equity hand outside its tier', () => {
    // 76s has lower equity against a random hand than K2s, but the cutoff opens
    // 76s while only the button opens K2s. Tier must win.
    expect(equityVsRandom['K2s']!).toBeGreaterThan(equityVsRandom['76s']!);
    expect(ordering.tiers.get('76s')!).toBeLessThan(ordering.tiers.get('K2s')!);
    const btn = charts.rfi('BTN');
    const trimmed = trimToWeight(btn, btn.totalWeight * 0.6, ordering);
    const kept = (key: string) =>
      combosOfHandKey(key).some((c) => trimmed.weightOf(c) > 0);
    expect(kept('76s')).toBe(true);
    expect(kept('K2s')).toBe(false);
  });

  it('trims the boundary hand fractionally rather than dropping it whole', () => {
    const btn = charts.rfi('BTN');
    // Pick a target that lands mid-hand.
    const trimmed = trimToWeight(btn, btn.totalWeight * 0.5 + 0.5, ordering);
    const fractional = [...trimmed.handKeyWeights().values()]
      .filter((v) => v.maxWeight > 0 && v.maxWeight < 1);
    expect(fractional.length).toBeGreaterThan(0);
    for (const bucket of fractional) {
      expect(bucket.maxWeight).toBeGreaterThan(0);
      expect(bucket.maxWeight).toBeLessThan(1);
    }
  });

  it('returns the range untouched when the target is not binding', () => {
    const btn = charts.rfi('BTN');
    expect(trimToWeight(btn, btn.totalWeight * 2, ordering)).toBe(btn);
    expect(scaleRangeWidth(btn, 1, ordering)).toBe(btn);
    expect(scaleRangeWidth(btn, 1.5, ordering)).toBe(btn);
  });

  it('produces an empty range for a zero target and handles empty input', () => {
    expect(trimToWeight(charts.rfi('BTN'), 0, ordering).isEmpty).toBe(true);
    expect(scaleRangeWidth(Range.empty(), 0.5, ordering).isEmpty).toBe(true);
  });

  it('never produces weights outside [0, 1]', () => {
    const trimmed = trimToWeight(charts.rfi('BTN'), charts.rfi('BTN').totalWeight * 0.37, ordering);
    for (let i = 0; i < trimmed.weights.length; i++) {
      expect(trimmed.weights[i]!).toBeGreaterThanOrEqual(0);
      expect(trimmed.weights[i]!).toBeLessThanOrEqual(1);
    }
  });
});

describe('handStrength.json is derived data and must not drift from the engine', () => {
  it('covers all 169 hands with plausible values', () => {
    const keys = HAND_GRID.flat();
    expect(Object.keys(equityVsRandom)).toHaveLength(169);
    for (const key of keys) {
      const value = equityVsRandom[key];
      expect(value, `missing ${key}`).toBeDefined();
      expect(value!).toBeGreaterThan(28);
      expect(value!).toBeLessThan(90);
    }
  });

  it('ranks the hands the way published hot-and-cold tables do', () => {
    expect(equityVsRandom['AA']!).toBeGreaterThan(equityVsRandom['KK']!);
    expect(equityVsRandom['KK']!).toBeGreaterThan(equityVsRandom['QQ']!);
    expect(equityVsRandom['AKs']!).toBeGreaterThan(equityVsRandom['AKo']!);
    expect(equityVsRandom['AA']!).toBeCloseTo(85.2, 0);
    expect(equityVsRandom['32o']!).toBeCloseTo(32.3, 0);
    // 32o is the worst hand in hold'em.
    const worst = Object.entries(equityVsRandom).sort((a, b) => a[1] - b[1])[0]!;
    expect(worst[0]).toBe('32o');
  });

  it('still matches a fresh engine run', () => {
    // Spot-check: if the engine changes, this catches stale generated data.
    for (const key of ['AA', 'AKs', '76s', 'K2s', '32o']) {
      const hole = comboCards(combosOfHandKey(key)[0]!);
      const fresh = computeEquity({
        hole,
        opponents: [Range.full()],
        rng: createRng(`drift-check:${key}`),
        iterations: 100_000,
        targetStandardError: 0,
        maxIterations: 100_000,
      }).equity;
      expect(
        Math.abs(fresh - equityVsRandom[key]!),
        `${key}: stored ${equityVsRandom[key]}%, fresh run ${fresh.toFixed(2)}%`,
      ).toBeLessThan(0.6);
    }
  });
});
