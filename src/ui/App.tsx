/**
 * One full Outs hand, end to end: deal, answer, feedback, next.
 *
 * Preflop mode and the settings screen are deliberately not wired yet — the
 * interaction is worth correcting on one working hand before both modes depend
 * on it.
 */
import { useCallback, useMemo, useState } from 'react';

import rangesJson from '../data/ranges.json';
import { RangeCharts, type RangeChartsJson } from '../engine/ranges';
import { createRng, generateSeed } from '../engine/deck';
import { OutsHand } from '../game/session';
import {
  DEFAULT_SETTINGS,
  type HandGrade,
  type HandInput,
  type HandTruth,
} from '../game/types';
import { FeedbackScreen } from './components/FeedbackScreen';
import { OutsHandScreen } from './components/OutsHandScreen';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const settings = { ...DEFAULT_SETTINGS, playerCount: 6 };

/** Session-level generator, so each hand gets a fresh replayable seed. */
const sessionRng = createRng(`session:${Date.now()}`);

/**
 * A seed may be pinned with `?seed=...`, which replays that hand exactly.
 * This is the mechanism Review mode will use to re-deal a hand you got wrong,
 * and it makes the app inspectable without a debug build.
 */
function seedFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const pinned = new URLSearchParams(window.location.search).get('seed');
  return pinned !== null && pinned.length > 0 ? pinned : null;
}

export function App(): JSX.Element {
  const pinnedSeed = seedFromUrl();
  const [seed, setSeed] = useState(() => pinnedSeed ?? generateSeed(sessionRng));
  const [lastGrade, setLastGrade] = useState<HandGrade | null>(null);
  /**
   * The truth that was ANSWERED, captured before submitting.
   *
   * `hand.submit` returns the ADVANCED state, so on a correct flop its truth is
   * already the turn's — board, outs, equity split, fired rules and range grid
   * would all describe a street hero has not seen yet, against answers from the
   * one they just played.
   */
  const [gradedTruth, setGradedTruth] = useState<HandTruth | null>(null);

  // Rebuilt only when the seed changes, so the Monte Carlo runs once per hand.
  const hand = useMemo(() => new OutsHand(seed, settings, charts), [seed]);
  const [state, setState] = useState(hand.current);

  const submit = useCallback((input: HandInput) => {
    const answered = state.truth;
    const result = hand.submit(input);
    setGradedTruth(answered);
    setLastGrade(result.grade);
    setState(result.state);
  }, [hand, state.truth]);

  const nextHand = useCallback(() => {
    setLastGrade(null);
    setSeed(generateSeed(sessionRng));
  }, []);

  const continueHand = useCallback(() => {
    setLastGrade(null);
    setState(hand.current);
  }, [hand]);

  const truth = state.truth;
  if (truth === null) return <main><p>No hand.</p></main>;

  const handOver = state.phase === 'won' || state.phase === 'lost';

  return (
    <main>
      {lastGrade === null || gradedTruth === null ? (
        <OutsHandScreen key={`${seed}:${state.phase}`} truth={truth} onSubmit={submit} />
      ) : (
        <FeedbackScreen
          truth={gradedTruth}
          grade={lastGrade}
          onNext={handOver ? nextHand : continueHand}
          nextLabel={
            handOver
              ? (state.outcome === 'won' ? 'Hand won — deal the next' : 'Next hand')
              : 'Correct — see the turn'
          }
        />
      )}
    </main>
  );
}
