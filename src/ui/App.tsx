/**
 * Settings, then one mode, hand after hand.
 *
 * The hand and its state are ONE piece of state, deliberately. They were once a
 * `useMemo` on the seed plus a separate `useState` initialised from it, and
 * `useState` initialises only once — so changing the seed built a new hand while
 * the state kept the old one's truth, and the screen rendered one hand while
 * the answers were graded against another. Holding both together makes that
 * impossible: they can only change as a pair.
 */
import { useCallback, useState } from 'react';

import rangesJson from '../data/ranges.json';
import { type ActionKind } from '../engine/actionSolver';
import { createRng, generateSeed } from '../engine/deck';
import { RangeCharts, type RangeChartsJson } from '../engine/ranges';
import {
  OutsHand,
  buildPreflopHand,
  gradePreflop,
  type PreflopGrade,
  type PreflopTruth,
} from '../game/session';
import { DEFAULT_SETTINGS, type HandGrade, type HandInput, type HandTruth, type Settings }
  from '../game/types';
import {
  appendRecord,
  clearHistory,
  exportHistory,
  importHistory,
  loadHistory,
  recordOutsHand,
  recordPreflopHand,
  saveHistory,
  type HandRecord,
} from '../game/history';
import { bandOf } from '../game/types';
import { FeedbackScreen } from './components/FeedbackScreen';
import { OutsHandScreen } from './components/OutsHandScreen';
import { PreflopFeedback } from './components/PreflopFeedback';
import { PreflopScreen } from './components/PreflopScreen';
import { ReviewScreen } from './components/ReviewScreen';
import { SettingsScreen, type Mode } from './components/SettingsScreen';
import { StatsScreen } from './components/StatsScreen';
import { useHandTimer } from './components/useHandTimer';

const charts = new RangeCharts(rangesJson as unknown as RangeChartsJson);
const sessionRng = createRng(`session:${Date.now()}`);

/**
 * A seed may be pinned with `?seed=...`, which replays that hand exactly. This
 * is the mechanism Review mode will use, and it makes the app inspectable
 * without a debug build. `?mode=preflop` skips straight into that mode.
 */
function fromUrl(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get(name);
  return value !== null && value.length > 0 ? value : null;
}

type Screen = 'settings' | 'playing' | 'stats' | 'review';

export function App(): JSX.Element {
  const urlSeed = fromUrl('seed');
  const pinnedMode = fromUrl('mode');
  const [screen, setScreen] = useState<Screen>(
    urlSeed !== null || pinnedMode !== null ? 'playing' : 'settings',
  );
  const [settings, setSettings] = useState<Settings>(
    { ...DEFAULT_SETTINGS, playerCount: 6 },
  );
  const [mode, setMode] = useState<Mode>(pinnedMode === 'preflop' ? 'preflop' : 'outs');
  const [pinnedSeed, setPinnedSeed] = useState<string | null>(urlSeed);
  const [records, setRecords] = useState<HandRecord[]>(() => loadHistory());
  /** Bumped to force a fresh session when replaying the same seed twice. */
  const [sessionKey, setSessionKey] = useState(0);

  const record = useCallback((entry: HandRecord) => {
    setRecords(appendRecord(entry));
  }, []);

  const start = useCallback((chosen: Settings, chosenMode: Mode) => {
    setSettings(chosen);
    setMode(chosenMode);
    setPinnedSeed(null);
    setSessionKey((key) => key + 1);
    setScreen('playing');
  }, []);

  /** Replays a recorded hand at the table it was dealt at. */
  const replay = useCallback((entry: HandRecord) => {
    setSettings(entry.settings);
    setMode(entry.mode);
    setPinnedSeed(entry.seed);
    setSessionKey((key) => key + 1);
    setScreen('playing');
  }, []);

  const exportJson = useCallback(() => {
    const text = exportHistory(records);
    // A data: URL download is blocked in some embedded viewers, so offer the
    // text itself as a fallback rather than failing silently.
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `poker-trainer-history-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      window.prompt('Copy your history:', text);
    }
  }, [records]);

  const importJson = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) return;
      void file.text().then((text) => {
        try {
          const result = importHistory(text, records);
          saveHistory(result.records);
          setRecords(result.records);
          window.alert(`Imported ${result.added} hands, skipped ${result.skipped}.`);
        } catch (error) {
          window.alert(error instanceof Error ? error.message : 'Import failed.');
        }
      });
    };
    input.click();
  }, [records]);

  const wipe = useCallback(() => {
    if (!window.confirm('Delete every recorded hand? This cannot be undone.')) return;
    clearHistory();
    setRecords([]);
  }, []);

  if (screen === 'settings') {
    return (
      <main>
        <SettingsScreen initial={settings} onStart={start} />
        <div className="nav-row">
          <button type="button" className="link" onClick={() => setScreen('stats')}>
            Stats
          </button>
          <button type="button" className="link" onClick={() => setScreen('review')}>
            Review{records.filter((r) => !r.passed).length > 0
              && ` (${records.filter((r) => !r.passed).length})`}
          </button>
        </div>
      </main>
    );
  }
  if (screen === 'stats') {
    return (
      <main>
        <StatsScreen
          records={records}
          onBack={() => setScreen('settings')}
          onExport={exportJson}
          onImport={importJson}
          onClear={wipe}
        />
      </main>
    );
  }
  if (screen === 'review') {
    return (
      <main>
        <ReviewScreen
          records={records}
          onBack={() => setScreen('settings')}
          onReplay={replay}
        />
      </main>
    );
  }
  return (
    <main>
      {mode === 'outs'
        ? <OutsSession key={sessionKey} settings={settings} pinnedSeed={pinnedSeed}
            onQuit={() => setScreen('settings')} onRecord={record} />
        : <PreflopSession key={sessionKey} settings={settings} pinnedSeed={pinnedSeed}
            onQuit={() => setScreen('settings')} onRecord={record} />}
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function OutsSession({ settings, pinnedSeed, onQuit, onRecord }: {
  settings: Settings;
  pinnedSeed: string | null;
  onQuit: () => void;
  onRecord: (record: HandRecord) => void;
}): JSX.Element {
  const [session, setSession] = useState(() => {
    const seed = pinnedSeed ?? generateSeed(sessionRng);
    const hand = new OutsHand(seed, settings, charts);
    return { hand, state: hand.current };
  });
  const [lastGrade, setLastGrade] = useState<HandGrade | null>(null);
  const [gradedTruth, setGradedTruth] = useState<HandTruth | null>(null);

  const submit = useCallback((input: HandInput, answering: HandTruth) => {
    const result = session.hand.submit(input, answering);
    onRecord(recordOutsHand(
      answering, { ...input }, result.grade, settings,
      bandOf(answering.equity.percent),
    ));
    setGradedTruth(answering);
    setLastGrade(result.grade);
    setSession({ hand: session.hand, state: result.state });
  }, [session.hand, onRecord, settings]);

  const nextHand = useCallback(() => {
    const seed = generateSeed(sessionRng);
    const hand = new OutsHand(seed, settings, charts);
    setGradedTruth(null);
    setLastGrade(null);
    setSession({ hand, state: hand.current });
  }, [settings]);

  const state = session.state;
  const truth = state.truth;
  const showingFeedback = lastGrade !== null && gradedTruth !== null;

  // Timing out submits an empty answer, which the grader counts as a loss.
  const onExpire = useCallback(() => {
    if (truth === null || showingFeedback) return;
    submit({
      outs: null, cleanOuts: null, timings: {}, hitProbability: null,
      equityBand: null, potOdds: null, action: null, timedOut: true,
    }, truth);
  }, [truth, showingFeedback, submit]);
  const secondsLeft = useHandTimer(
    showingFeedback ? null : settings.timePerHandSeconds,
    `${truth?.seed ?? ''}:${state.phase}`,
    onExpire,
  );

  if (truth === null) return <p>No hand.</p>;
  const handOver = state.phase === 'won' || state.phase === 'lost';

  return (
    <>
      <SessionBar secondsLeft={secondsLeft} onQuit={onQuit} />
      {showingFeedback ? (
        <FeedbackScreen
          truth={gradedTruth}
          grade={lastGrade}
          onNext={handOver ? nextHand : () => { setGradedTruth(null); setLastGrade(null); }}
          nextLabel={handOver
            ? (state.outcome === 'won' ? 'Hand won — deal the next' : 'Next hand')
            : 'Correct — see the turn'}
        />
      ) : (
        <OutsHandScreen
          key={`${truth.seed}:${state.phase}`}
          truth={truth}
          onSubmit={submit}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function PreflopSession({ settings, pinnedSeed, onQuit, onRecord }: {
  settings: Settings;
  pinnedSeed: string | null;
  onQuit: () => void;
  onRecord: (record: HandRecord) => void;
}): JSX.Element {
  const [truth, setTruth] = useState<PreflopTruth>(() =>
    buildPreflopHand(pinnedSeed ?? generateSeed(sessionRng), settings, charts));
  const [grade, setGrade] = useState<PreflopGrade | null>(null);

  const answer = useCallback((action: ActionKind | null, timedOut: boolean) => {
    const result = gradePreflop(truth, action, timedOut);
    onRecord(recordPreflopHand(truth, action, result, settings));
    setGrade(result);
  }, [truth, onRecord, settings]);

  const nextHand = useCallback(() => {
    setGrade(null);
    setTruth(buildPreflopHand(generateSeed(sessionRng), settings, charts));
  }, [settings]);

  const onExpire = useCallback(() => {
    if (grade === null) answer(null, true);
  }, [grade, answer]);
  const secondsLeft = useHandTimer(
    grade === null ? settings.timePerHandSeconds : null, truth.seed, onExpire,
  );

  return (
    <>
      <SessionBar secondsLeft={secondsLeft} onQuit={onQuit} />
      {grade === null
        ? <PreflopScreen truth={truth} secondsLeft={secondsLeft}
            onAnswer={(action) => answer(action, false)} />
        : <PreflopFeedback truth={truth} grade={grade} onNext={nextHand} />}
    </>
  );
}

function SessionBar({ secondsLeft, onQuit }: {
  secondsLeft: number | null;
  onQuit: () => void;
}): JSX.Element {
  return (
    <div className="session-bar">
      <button type="button" className="link" onClick={onQuit}>← settings</button>
      {secondsLeft !== null && (
        <span className={`clock ${secondsLeft <= 5 ? 'urgent' : ''}`}>{secondsLeft}s</span>
      )}
    </div>
  );
}
