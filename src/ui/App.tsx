/**
 * Engine build check.
 *
 * This is NOT the trainer UI — that is step 5. This page exists so the engine
 * can be run on a real device, from an installed home-screen app, with the
 * network off. It answers two questions that cannot be answered from CI:
 *
 *   1. Does the whole engine actually work offline once installed?
 *   2. How fast is a 100,000-iteration Monte Carlo run on THIS phone?
 *
 * The spec says that if Monte Carlo blocks the UI for more than ~200ms on an
 * iPhone, `equity.ts` moves into a Web Worker. This measures that number.
 */
import { useCallback, useEffect, useState } from 'react';

import rangesJson from '../data/ranges.json';
import { codesFromStrings, createRng } from '../engine/deck';
import { DEFAULT_ITERATIONS, computeEquity } from '../engine/equity';
import { RangeCharts, Range, type RangeChartsJson } from '../engine/ranges';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const C = (text: string) => codesFromStrings(text.split(/\s+/).filter(Boolean));

/**
 * Reference equities, enumerated exhaustively offline (every remaining board,
 * no sampling) by `exactEquityVsHand` and asserted in test/equity.test.ts.
 * Enumerating 1.7M preflop boards in a phone browser would take far too long,
 * so the trusted values are carried here and the live run is compared to them.
 */
const BENCHMARKS = [
  { name: 'AA vs KK', hero: 'As Ah', villain: 'Kc Kd', board: '', exact: 81.26 },
  { name: 'AKs vs QQ', hero: 'Ah Kh', villain: 'Qs Qd', board: '', exact: 46.21 },
  { name: '22 vs AKo', hero: '2c 2d', villain: 'Ah Ks', board: '', exact: 53.04 },
  {
    name: 'flush draw vs top pair',
    hero: '7h 2h', villain: 'Ks 9c', board: 'Kd 8h 3h', exact: 36.57,
  },
  {
    name: 'set vs nut flush draw',
    hero: '7c 7d', villain: 'Ah Qh', board: '7h 5h 2c', exact: 74.44,
  },
] as const;

interface Row {
  name: string;
  exact: number;
  measured: number;
  error: number;
  ms: number;
  standardError: number;
}

function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const check = () =>
      setStandalone(
        window.matchMedia('(display-mode: standalone)').matches
        || (window.navigator as { standalone?: boolean }).standalone === true,
      );
    check();
    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener('change', check);
    return () => media.removeEventListener('change', check);
  }, []);
  return standalone;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function App(): JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [worst, setWorst] = useState(0);
  const standalone = useStandalone();
  const online = useOnline();

  const run = useCallback(() => {
    setRunning(true);
    // Yield a frame so the button's pressed state paints before the main
    // thread is blocked. If this is not enough on a real phone, that is the
    // signal to move the engine into a Web Worker.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const results: Row[] = [];
        let slowest = 0;
        for (const benchmark of BENCHMARKS) {
          const started = performance.now();
          const result = computeEquity({
            hole: C(benchmark.hero),
            board: C(benchmark.board),
            opponents: [Range.parse([benchmark.villain.split(/\s+/).join('')])],
            rng: createRng(`build-check:${benchmark.name}`),
            iterations: DEFAULT_ITERATIONS,
          });
          const ms = performance.now() - started;
          if (ms > slowest) slowest = ms;
          results.push({
            name: benchmark.name,
            exact: benchmark.exact,
            measured: result.equity,
            error: result.equity - benchmark.exact,
            ms,
            standardError: result.standardError,
          });
        }
        setRows(results);
        setWorst(slowest);
        setRunning(false);
      }, 0);
    });
  }, []);

  const allPass = rows !== null && rows.every((r) => Math.abs(r.error) < 0.5);

  return (
    <main>
      <header>
        <h1>Poker Equity Trainer</h1>
        <p className="lede">
          Engine build check. The trainer UI is not built yet — this page runs the
          engine on this device so you can confirm it works offline and see how
          fast Monte Carlo is on your own hardware.
        </p>
        <div className="chips">
          <span className={`chip ${standalone ? 'ok' : ''}`}>
            {standalone ? 'installed app' : 'in browser'}
          </span>
          <span className={`chip ${online ? '' : 'ok'}`}>
            {online ? 'online' : 'offline — engine still running'}
          </span>
        </div>
      </header>

      <section>
        <h2>Equity benchmarks</h2>
        <p className="note">
          {DEFAULT_ITERATIONS.toLocaleString()} iterations per scenario, compared
          against values enumerated exhaustively offline. Anything under
          ±0.5&thinsp;pp is well inside the ±5&thinsp;pp grading tolerance.
        </p>
        <button type="button" onClick={run} disabled={running}>
          {running ? 'Computing…' : rows === null ? 'Run benchmarks' : 'Run again'}
        </button>

        {rows !== null && (
          <>
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>scenario</th><th>exact</th><th>measured</th>
                    <th>error</th><th>time</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.exact.toFixed(2)}%</td>
                      <td>{row.measured.toFixed(2)}%</td>
                      <td className={Math.abs(row.error) < 0.5 ? 'good' : 'bad'}>
                        {row.error >= 0 ? '+' : ''}{row.error.toFixed(2)}pp
                      </td>
                      <td>{row.ms.toFixed(0)}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`verdict ${allPass ? 'good' : 'bad'}`}>
              {allPass
                ? 'All scenarios within tolerance.'
                : 'A scenario is outside tolerance — do not trust this build.'}
            </p>
            <p className={`verdict ${worst > 200 ? 'bad' : 'good'}`}>
              Slowest run {worst.toFixed(0)}ms.{' '}
              {worst > 200
                ? 'Over the 200ms budget — equity.ts should move into a Web Worker.'
                : 'Inside the 200ms budget — no Web Worker needed yet.'}
            </p>
          </>
        )}
      </section>

      <section>
        <h2>Loaded charts</h2>
        <p className="note">
          Proof the range data is present and parsed, not just the code.
        </p>
        <div className="scroller">
          <table>
            <thead><tr><th>position</th><th>opens</th><th>combos</th></tr></thead>
            <tbody>
              {(['UTG', 'MP', 'CO', 'BTN', 'SB'] as const).map((position) => {
                const range = charts.rfi(position);
                return (
                  <tr key={position}>
                    <td>{position}</td>
                    <td>{range.percentOfHands.toFixed(1)}%</td>
                    <td>{range.comboCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <footer>
        <p>
          Add to Home Screen, then turn on Airplane Mode and reopen. Everything
          above must still work.
        </p>
      </footer>
    </main>
  );
}
