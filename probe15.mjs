import rangesJson from './src/data/ranges.json' with { type: 'json' };
import { RangeCharts } from './src/engine/ranges.ts';
import { createRng } from './src/engine/deck.ts';
import { countOuts } from './src/engine/outs.ts';
import { buildOutsSpot } from './src/game/spot.ts';
import { DEFAULT_SETTINGS } from './src/game/types.ts';
const charts = new RangeCharts(rangesJson);
const settings = { ...DEFAULT_SETTINGS, playerCount: 6 };
const N = 2000;
let flopOver = 0, turnOver = 0, either = 0;
const mixAll = new Map(), mixKept = new Map();
for (let i = 0; i < N; i++) {
  const spot = buildOutsSpot(`cap-${i}`, settings, charts, createRng(`cap-${i}`));
  const f = countOuts(spot.heroCards, spot.flop).total;
  const t = countOuts(spot.heroCards, [...spot.flop, spot.turnCard]).total;
  const overF = f > 23, overT = t > 17;
  if (overF) flopOver++;
  if (overT) turnOver++;
  mixAll.set(spot.heroClass, (mixAll.get(spot.heroClass)||0)+1);
  if (overF || overT) { either++; } else {
    mixKept.set(spot.heroClass, (mixKept.get(spot.heroClass)||0)+1);
  }
}
console.log(`Over 23 outs on the flop: ${flopOver}/${N} (${(100*flopOver/N).toFixed(2)}%)`);
console.log(`Over 17 outs on the turn: ${turnOver}/${N} (${(100*turnOver/N).toFixed(2)}%)`);
console.log(`Rejected by either cap:   ${either}/${N} (${(100*either/N).toFixed(2)}%)\n`);
console.log('hand class      all spots      after capping     change');
const keys = [...new Set([...mixAll.keys(), ...mixKept.keys()])];
const keptTotal = N - either;
for (const k of keys.sort()) {
  const a = (mixAll.get(k)||0), b = (mixKept.get(k)||0);
  const pa = 100*a/N, pb = 100*b/keptTotal;
  console.log(`  ${k.padEnd(12)} ${pa.toFixed(1).padStart(5)}%        ${pb.toFixed(1).padStart(5)}%        ${(pb-pa>=0?'+':'')+(pb-pa).toFixed(1)}pp`);
}
