# Poker Equity Trainer

Fully offline Texas Hold'em training app. Drills equity estimation, pot odds and
action selection. No network calls, no API keys, no LLM — every "correct answer"
is computed deterministically from a seeded RNG, so a wrong training signal can
only come from a bug, never from a model's guess.

**Status: engine steps 1–3 complete** (deck, evaluator, ranges, Monte Carlo
equity, pot odds, table-size scaling, range narrowing, action solver).
212 tests passing. Game modes and UI next.

Tagged `engine-v1-validated` at commit `83db7ec` — the validated evaluator +
equity layer, before narrowing was built on top.

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
npm test          # 212 tests, ~18s
npm run grids     # render every chart as a 13x13 grid -> range-grids.html
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

Review the charts visually with `npm run grids`, which renders every chart as a
13×13 grid in a self-contained HTML page.

Current 6-max coverage:

```
RFI  UTG  14.3%   MP  18.9%   CO  25.5%   BTN  41.8%   SB  36.7%
BB defends vs BTN open: 40.3% call + 10.0% 3-bet
```

### Table-size scaling — one rule, not two chart sets

Mapping seat names onto a 9-handed table is not enough: UTG 9-handed has eight
players behind against five 6-handed, so range *width* has to tighten too.

The key point is that width is driven by **players left to act behind hero**,
not table size. A cutoff has three players behind at any table size, which is
why published 6-max and full-ring cutoff ranges are near-identical. The same
holds for the button and the blinds. Only the early seats differ, and they
differ precisely because they have more players behind. So seats are mapped by
players-behind, and beyond five behind — where no 6-max chart exists — the UTG
chart is tightened by **0.90 per extra player**.

This reproduces published full-ring ranges within ~1.2pp:

```
seat (9-handed)   behind   this rule   published
UTG                  8       10.4%      ~10.5%
UTG+1                7       11.6%       ~12%
UTG+2                6       12.9%      ~13.5%
UTG+3                5       14.3%       ~15%
MP                   4       18.9%       ~19%
CO                   3       25.5%       ~25%
BTN                  2       41.8%       ~43%
```

Chosen over separate 6-max/full-ring chart sets because it leaves exactly **one**
hand-authored chart set to review — authored chart data is the part of this
engine no test can prove correct, only self-consistent, so halving it is a real
reduction in risk. It also covers the 7-, 8- and 10-handed cases no published
chart set covers, applies uniformly to calling and 3-betting ranges, and is
falsifiable against the table above.

When tightening, weakest hands go first, ordered by **chart tier** (the tightest
opening chart containing the hand — derived from the charts themselves) and then
by equity against a random hand, used only to break ties within a tier. Tier
dominates deliberately: equity-vs-random ranks K2s above 76s, whereas the charts
prefer 76s, and tier ordering keeps 76s longer. The boundary hand is trimmed
**fractionally** so a target width is hit exactly.

Two documented exceptions:

- **Heads-up is authored separately, never scaled.** The button has one player
  behind — fewer than the 6-max button — so the rule would want to *widen*, and
  no widening of a 41.8% chart produces a correct ~85% heads-up button range.
  HU is a structurally different game and gets its own charts (BTN opens 84.6%,
  BB defends 68.9%).
- **The small blind is tighter than the button** despite fewer players behind,
  because it is out of position postflop against a blind that never folds for
  free. Any monotonic-in-players-behind rule must exclude the blinds.

### Range narrowing

`rangeNarrowing.ts` holds every tunable weight in one `NARROWING_RULES` object,
one block per action, each with a comment. Every rule is tagged `[DERIVED]`
(follows from the game or from arithmetic — changing it makes the engine wrong)
or `[JUDGEMENT]` (a modelling opinion about how a typical opponent plays — yours
to tune). Most of it is `[JUDGEMENT]`, unavoidably: there is no deterministic
truth about what a check means.

Hand classification *is* derived — it comes from the evaluator and from counting
outs. Note the taxonomy: `strong` is two pair or a set, `monster` starts at a
straight.

A range is never narrowed to nothing: below `MIN_SURVIVING_COMBOS` (12) or
`MIN_SURVIVING_WEIGHT` (8) the narrowing is blended back toward the pre-action
range, and `MAX_NARROWING_PER_STREET` (0.25) stops one action removing more than
three quarters of a range.

Fold frequency is keyed on the **pot odds the opponent is laid**, not on the raw
size of hero's wager. This matters for raises: a raise to 183 when the opponent
has already bet 50 asks them to call only 133 into 333 — a cheap price — even
though 183 looks like an overbet next to the pot. Pricing that as an overbet
made every raise look enormously profitable, which is a bug this caught.

Fold frequency is a **step function** of price, since continue thresholds are
class buckets: sizings inside one band fold out identical hands, and two bands
coincide when the class between them is empty on that board. Documented rather
than hidden.

### Action solver

Every action gets an EV in chips against folding = 0, from explicit pot
arithmetic written out in the file header — no heuristic scores. Bet and raise
EV uses equity against the range that **continues**, not the whole range, since
the folding hands are exactly the ones hero already beats.

Simplifications, stated plainly: one street at a time (no implied odds, no
multi-street planning), one bet size fixed at 2/3 pot per the spec, and multiway
pots resolve as a simple showdown.

An action is correct when its EV is within 5% of the best, with an absolute
floor of 1% of the pot so grading is not knife-edge when the best EV is near
zero. Note that a *profitable* call is not necessarily a *correct* one: with real
fold equity available, raising can outrank a call that still shows positive EV.

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

4. Game state machines (Outs, Preflop)
5. UI (dark theme, four-colour deck, oval table)
6. Stats, review mode, PWA packaging
