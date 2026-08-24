# Poker Equity Trainer

Fully offline Texas Hold'em training app. Drills equity estimation, pot odds and
action selection. No network calls, no API keys, no LLM — every "correct answer"
is computed deterministically from a seeded RNG, so a wrong training signal can
only come from a bug, never from a model's guess.

**Status: engine steps 1–2 complete** (deck, evaluator, ranges, Monte Carlo
equity, pot odds). Paused here as requested, for benchmark review before
building range narrowing, the action solver, game modes and UI on top.

## Layout

```
src/engine/   pure TypeScript, zero React imports, unit-tested from Node
src/game/     game mode state machines            (not built yet)
src/ui/       React components                    (not built yet)
src/data/     editable JSON: ranges, config
test/         vitest suites, run with `npm test`
```

`src/engine` has no DOM dependency, so `equity.ts` can be moved into a Web
Worker as a drop-in change if Monte Carlo ever blocks the UI on an iPhone.

## Commands

```
npm test          # 126 tests, ~12s
npm run dev       # (once UI exists)
npm run build
```

## Engine notes

### Card representation

Three interchangeable forms: `{rank, suit}` objects at API boundaries, compact
strings (`"As"`, `"Th"`, `"2c"`) in JSON and tests, and integers `0..51` in
every hot loop. The integer encoding is `rankIndex * 4 + suitIndex`, chosen to
be bit-identical to the backing evaluator's own encoding so codes are passed
through with zero conversion. A test asserts that equivalence for all 52 cards.

### Determinism

`Math.random` is never used. Every hand comes from `createRng(seed)` — cyrb128
seed hashing into an sfc32 generator — so any hand replays exactly from its
seed, which is what makes Review mode possible.

### Evaluator choice — a deviation worth knowing about

The brief named `pokersolver` or `poker-evaluator`. Measured on this machine:

| library | 7-card evals/sec | size | browser-safe |
|---|---|---|---|
| `pokersolver` | ~50,000 | 192 KB | yes |
| `poker-evaluator` | fast | **130 MB** `HandRanks.dat`, read via `fs` | **no** |
| **`phe`** (chosen) | **~4,350,000** | 632 KB, zero deps | yes |

`pokersolver` at 50k evals/sec makes a 100k-iteration run take ~4 seconds,
against a requirement of "well under one second". `poker-evaluator` is fast but
ships a 130 MB lookup table read through `fs` — it cannot run in a browser and
certainly cannot be precached in an offline PWA.

`phe` is also a proven npm evaluator, so the "no hand-rolled evaluator" rule is
still honoured — and both named libraries are kept as **dev-only test oracles**.
`test/evaluator.test.ts` runs all three against each other over 50,000 random
seven-card matchups each; agreement between three independently written
evaluators is a stronger guarantee than trusting any single one. Current result:
**zero disagreements**.

Everything is behind the `HandEvaluator` interface in `src/engine/evaluator.ts`.
Swapping backends means implementing that interface and changing one export.

### Ranges

`src/data/ranges.json` is editable without touching code, and is re-parsed at
startup — a typo throws loudly rather than silently mis-training you. Ranges
expand to all 1326 individual combos with weights, so equity sampling is exact
rather than approximated at the 169-hand level.

Notation follows the PokerStove convention. Note that `+` on a non-pair fixes
the **high** card and walks the low one up, so `AJs+` is `AJs, AQs, AKs` and
`76s+` is just `76s`. Runs of connectors must be written as an explicit diagonal
(`T9s-54s`), which removes the ambiguity that bites people writing `65s+`.

Charts are 6-max. For other table sizes: the last three seats are always
BTN/SB/BB, the seat before the button is CO, and remaining early seats split
into UTG then MP with the extra seat going to UTG. Heads-up is BTN vs BB.
Duplicated chart positions get distinct display labels (`UTG`, `UTG+1`, `UTG+2`).

Current chart coverage:

```
RFI  UTG  14.3%   MP  18.9%   CO  25.5%   BTN  41.8%   SB  36.7%
BB defends vs BTN open: 40.3% call + 10.0% 3-bet
```

### Equity

Monte Carlo, 100,000 iterations by default. Per iteration: sample one hand per
opponent from their weighted range by rejection sampling against every known
card, deal the remaining board, evaluate the showdown. Hero scores 1 for a win,
`1/k` for a k-way tie, 0 for a loss.

The run reports its standard error and **automatically raises iterations** if it
exceeds 0.5 percentage points, rather than reporting a number too noisy to grade
against a ±5pp tolerance. Under heavy card blocking, rejection sampling falls
back to an exact weighted draw conditioned on availability, so the distribution
stays correct instead of degrading.

## Equity benchmark results

Two independent layers: `exactEquityVsHand` enumerates every remaining board
exhaustively and is checked against published equity tables; the Monte Carlo
estimator is then checked against that enumeration, so sampling bias appears as
a systematic gap rather than hiding behind a loose tolerance.

```
                                                 exact       MC       error      SE
AA vs KK (preflop)                              81.26%   81.42%    +0.16pp   0.123pp
AA vs KK (suit-blocking config)                 81.95%   82.03%    +0.09pp   0.121pp
AKs vs QQ (preflop)                             46.21%   46.14%    -0.08pp   0.157pp
AKo vs QQ (preflop)                             42.84%   42.82%    -0.01pp   0.156pp
AKo vs JJ (preflop)                             42.75%   42.71%    -0.04pp   0.156pp
22 vs AKo (preflop)                             53.04%   53.03%    -0.01pp   0.157pp
JTs vs AA (preflop)                             21.72%   21.81%    +0.09pp   0.130pp
bare flush draw vs top pair (flop)              36.57%   36.48%    -0.08pp   0.152pp
nut flush draw + overcard vs top pair (flop)    45.66%   45.46%    -0.19pp   0.157pp
open-ended straight draw vs top pair (flop)     34.24%   34.20%    -0.04pp   0.150pp
set vs nut flush draw (flop)                    74.44%   74.51%    +0.07pp   0.138pp

mean signed error -0.005pp        worst -0.195pp
```

Worst error is 0.195pp against a ±5pp grading tolerance — 25x headroom. The mean
signed error of -0.005pp shows no systematic bias in either direction.

`AA vs KK` deserves a note since the brief quoted "≈81%": exhaustive enumeration
gives 81.95% averaged over all 36 suit configurations, which decomposes as
81.71% outright wins + 0.49% ties — matching the standard published split
exactly. The 81.26% row is the specific no-suit-overlap configuration.

### Performance

```
heads-up, flop, 100k iterations     62ms   (1.6M iterations/sec)
preflop, 100k iterations            78ms
2 opponents, 100k iterations        99ms
3 opponents, 100k iterations       133ms
5 opponents, 100k iterations       204ms
8 opponents, 100k iterations       332ms
```

Comfortably inside the "well under one second" requirement, with enough headroom
that a slower phone CPU should still land under 200ms heads-up. If an actual
iPhone measurement says otherwise, `equity.ts` moves into a Web Worker unchanged.

## Still to build

3. Range narrowing + action solver
4. Game state machines (Outs, Preflop)
5. UI (dark theme, four-colour deck, oval table)
6. Stats, review mode, PWA packaging
