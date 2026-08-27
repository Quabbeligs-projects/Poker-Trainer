/**
 * One full Outs hand, end to end: deal, answer, feedback, next.
 *
 * Preflop mode and the settings screen are deliberately not wired yet — the
 * interaction is worth correcting on one working hand before both modes depend
 * on it.
 */
import { useCallback, useState } from 'react';

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

  /**
   * The hand and its state are ONE piece of state, deliberately.
   *
   * They were previously a `useMemo` on the seed plus a separate `useState`
   * initialised from it. `useState` initialises once, so changing the seed
   * built a new hand while the state kept the old one's truth: the screen
   * rendered the previous hand and the answers were graded against the new one.
   * Holding both together makes that impossible — they can only change as a
   * pair.
   */
  const [session, setSession] = useState(() => {
    const seed = pinnedSeed ?? generateSeed(sessionRng);
    const hand = new OutsHand(seed, settings, charts);
    return { hand, state: hand.current };
  });
  const [lastGrade, setLastGrade] = useState<HandGrade | null>(null);
  /** The truth that was ANSWERED, captured before submitting. */
  const [gradedTruth, setGradedTruth] = useState<HandTruth | null>(null);

  const submit = useCallback((input: HandInput, answering: HandTruth) => {
    const result = session.hand.submit(input, answering);
    setGradedTruth(answering);
    setLastGrade(result.grade);
    setSession({ hand: session.hand, state: result.state });
  }, [session.hand]);

  const nextHand = useCallback(() => {
    const seed = generateSeed(sessionRng);
    const hand = new OutsHand(seed, settings, charts);
    setGradedTruth(null);
    setLastGrade(null);
    setSession({ hand, state: hand.current });
  }, []);

  const continueHand = useCallback(() => {
    setGradedTruth(null);
    setLastGrade(null);
  }, []);

  const state = session.state;
  const truth = state.truth;
  if (truth === null) return <main><p>No hand.</p></main>;

  const handOver = state.phase === 'won' || state.phase === 'lost';

  return (
    <main>
      {lastGrade === null || gradedTruth === null ? (
        <OutsHandScreen
          key={`${truth.seed}:${state.phase}`}
          truth={truth}
          onSubmit={submit}
        />
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
