# Poker Equity Trainer

Fully offline Texas Hold'em training app. Drills equity estimation, pot odds and
action selection. No network calls, no API keys, no LLM — every "correct answer"
is computed deterministically from a seeded RNG, so a wrong training signal can
only come from a bug, never from a model's guess.

**Status: engine steps 1–4 complete** (deck, evaluator, ranges, Monte Carlo
equity, pot odds, table-size scaling, range narrowing, action solver), plus a
deployable PWA shell. 217 tests passing. Game modes and the trainer UI next.

The deployed page is an **engine build check**, not the trainer — it runs the
engine on your device so you can confirm it works offline and measure Monte
Carlo speed on real hardware.

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
npm test            # 302 tests, ~25s
npm run grids       # render every chart as a 13x13 grid -> range-grids.html
npm run sanity      # solver verdicts on spots with uncontroversial answers
npm run calibrate   # engine equity vs the rule of 4 and 2, across 600 spots
npm run icons       # regenerate the PWA icons
npm run build       # typecheck + production build
npm run verify:pwa  # build must work offline in a real browser
npm run smoke       # play one hand end to end in a real browser
npm run bench       # performance numbers (informational, never a gate)
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

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages. The
workflow runs the full test suite and an offline PWA check before publishing —
a failing test blocks the deploy rather than shipping a trainer that teaches
wrong answers.

**One-time setup, which a workflow file cannot do for itself:** Repository
Settings → Pages → Build and deployment → Source: **GitHub Actions**. Until
that is set the build succeeds but the deploy step fails with "Pages site not
found".

The workflow triggers on pushes to `main`, plus manual `workflow_dispatch`.

### PWA

`vite-plugin-pwa` precaches every build asset (13 entries, ~556 KB), so the app
runs with no network at all after a single load. Icons are generated by
`scripts/generateIcons.mjs` — raw PNG encoding via zlib, no image dependency and
no network.

`npm run verify:pwa` drives the built bundle in Chromium at iPhone viewport
size: it checks the manifest, the iOS-specific meta tags, that the service
worker takes control, then **cuts the network**, reloads, and confirms the
engine still computes correct equities from the precache. It also checks a deep
link falls back to the app shell offline.

**What can and cannot fail the build.** Only checks proving the app *functions*
offline are blocking: the service worker controls the page, a precached asset
resolves with the network cut, a never-cached URL does *not* resolve (proving
the network really was cut rather than the test quietly running online), the
engine deals a hand, and the form advances. Cosmetic checks report as warnings
and cannot block a deploy.

That split exists because a CI run once failed on a connectivity label alone
while every functional check passed. `navigator.onLine` reports only whether a
network interface exists, and under emulated offline mode it may not flip at
all. A label being wrong is not a reason to withhold a deploy whose engine
demonstrably works offline. That label is gone with the engine-check page, but
the split remains.

That verifies everything verifiable without an iOS device. Installing from the
Pages URL on an actual iPhone is the one step that needs your hardware.

## Solver sanity

`npm run sanity` runs the action solver on spots where the right answer is
uncontroversial and prints the full verdict plus `firedRules`. It is a
judgement harness, not a test: it exists so a human can read the solver's
reasoning and disagree with it. Two real modelling defects were found this way —
see the narrowing section above on bet-size intensity.

## Calibration: engine equity vs counting outs

`npm run calibrate` compares engine truth against what a player computes at the
table, over 600 spots (300 flops, each carried to the turn).

```
FLOP   mean signed gap  +3.2pp   sd 20.3pp   74% outside +/-5pp
TURN   mean signed gap +13.1pp   sd 26.2pp   68% outside +/-5pp
```

**The small mean is an artefact — two large opposite biases cancelling.** By
hand type:

```
hand type      n    mean gap    outs   naive   engine   as-is  improved
monster       10    +88.5pp      0.4     1.0    89.5    88.5     1.1
strong        68    +55.3pp      6.1    15.7    71.0    54.8    16.2
overpair       9    +32.8pp     13.2    38.7    71.5    38.2    33.3
topPair       28    +24.6pp     13.3    39.7    64.4    32.8    31.6
weakPair     218     +1.4pp     11.0    30.5    32.0    11.4    20.6
weakDraw      73     +1.1pp      8.9    24.8    25.9     4.3    21.6
nothing      161     -5.4pp      6.0    20.3    14.9     2.0    13.0
strongDraw    33     -8.2pp     13.6    41.0    32.7     2.0    30.8
```

Made hands are massively understated by outs counting (all their equity is
already-ahead equity, which counting outs cannot see); big draws are overstated
(outs are not clean, and the opponent redraws).

**The rule of 4 is not the problem.** Splitting the gap:

```
rule-of-4 arithmetic error      mean +0.4pp  sd  1.8
ignoring the opponent's range   mean +7.8pp  sd 23.8
```

The shortcut's arithmetic is nearly exact. The entire error is that outs
counting answers a different question from the one the engine answers.

**Restricting to genuine drawing spots helps but does not fix it:** 177 of 600
spots qualify, mean gap -4.2pp, sd 9.5pp, still 64% outside +/-5pp.

**Widening the tolerance is not viable**, which is why it was rejected:

```
all spots           to pass 90% needs +/-52pp
drawing spots only  to pass 90% needs +/-18pp
```

### Equity decomposition

The truth object now carries an `EquityBreakdown` splitting equity into `asIs`
(won without improving) and `improved` (won after improving), plus equity and
frequency per finishing category. The two parts sum exactly to the total. It is
present only on a flop or turn board — preflop there is no hand to improve on,
and on the river nothing can change.

This is what lets feedback say "16 points from making the flush, 15 from
ace-high being good when he misses" instead of a bare 31%.

### Outs

`countOuts` defines an out as a card that improves HERO's hand specifically,
measured against a benchmark: the best hand a player holding two blanks could
make on the same board, minimised over every possible pair of blanks. Without
that benchmark, any card pairing the board counts as an out — a nut flush draw
scores 23 outs and the rule of 4 claims 92%.

## Game layer

`src/game/` holds the two mode state machines. Both follow the same shape: a
hand is built and its truth frozen before it reaches the caller, the caller
submits input, and grading is a pure comparison.

### The truth guarantee

`OutsHand.submit` requires the truth object the caller RENDERED and throws if it
is not the one pending. That closes a class of bug by construction: a UI holding
stale state once showed one hand while grading another, so a correct answer was
marked wrong and the same seed appeared to produce two different truths. The
engine was deterministic throughout — the desync was entirely in the caller.


`buildTruth` takes no player input — there is no parameter to pass one through,
which is deliberate and visible in the signature. `HandTruth` is deeply readonly
so writing to it is a compile error, and `deepFreeze` freezes it so writing to
it at runtime throws (modules are strict mode). `gradeHand(truth, input)` is
pure: tests assert the truth object is byte-identical after grading with wild
inputs, and that repeated grading returns identical verdicts.

### Grading tolerances

Outs mode asks four things, each isolating one skill, then the action:

| field | graded | skill |
|---|---|---|
| outs | exact | mechanical counting |
| hit probability | ±3pp of the exact value | arithmetic |
| where you stand | correct band | judgement against a range |
| pot odds | ±2pp | arithmetic, not estimation |
| action | in the solver's accepted set | multiple actions can be right |

**Equity is a band, not a number.** A numeric equity input asks for something no
human can compute at a table: 64.5% against a 445-combo range is a Monte Carlo
result, not an estimate. The per-field timings made the case — 557 seconds on
that one field in a real session, against 0.2s for the fields that are actually
calculable. The bands are *way behind* (<25), *behind* (25–40), *even* (40–60),
*ahead* (60–80), *way ahead* (>80). Within 2pp of a band edge either adjoining
band is accepted, so a true 40.1% cannot fail an answer of "behind" by a tenth
of a point — the knife-edge problem that sank the two-anchor hit-probability
scheme, avoided at band edges.

The exact percentage, the as-is/improved split and the range grid all still
appear in the feedback. The information is valuable; the input was not.

The out count is asked for rather than displayed, because counting is the part
that actually gets used at a table — showing the number reduces the drill to
arithmetic. The `countOutsYourself` setting (on by default) drops back to three
inputs when five per hand is too slow under a time trial.

**Undercounting is treated as a misplaced judgement, not a miscount.**
Discounting soft outs — cards that improve the hand into something that still
loses — is a real technique, but it belongs in the equity estimate. The outs
field grades the raw improving-card count, and the feedback says exactly that
when hero enters fewer.

Hit probability is graded against the **exact** probability alone, in a single
±3pp band, on both streets.

An earlier design used two anchors — exact and the rule of 4 and 2 — each within
±2pp, because the *plain* shortcut diverges from exact by up to 5.9pp at 15
outs. That was wrong twice over:

- **It left a hole.** Two ±2pp bands around anchors 4.8pp apart accept 49–53 and
  54–58, so 53.5 failed while 53 and 54 both passed. A value sitting between two
  accepted answers cannot be graded wrong. A test now asserts the accepted set
  is one contiguous interval.
- **It solved a problem the calibration invented.** The baseline was plain
  `outs × 4`. The method players actually use subtracts the excess over eight
  outs, and it is far more accurate:

```
outs   exact   plain x4   adjusted   adjusted error
   9   35.0%      36         35          +0.0pp
  12   45.0%      48         44          -1.0pp
  14   51.2%      56         50          -1.2pp
  15   54.1%      60         53          -1.1pp
```

Across 1–15 outs the worst error is **−1.16pp on the flop (14 outs)** and
**−2.61pp on the turn (15 outs)**, so a single ±3pp band around exact accepts a
correctly-applied shortcut with room to spare. Switching the calibration to the
adjusted estimator halves the arithmetic error's spread (sd 1.8 → 0.9) and left
the range-blindness figure **exactly unchanged at +7.8pp, sd 23.8** — as it must,
since that term is measured against exact enumeration rather than any shortcut.
The two-field design rests on a number no estimator choice can move.

**Spot generation is capped** at 23 outs on the flop and 17 on the turn, so
hands where the shortcut breaches the band are never dealt. Measured over 2,000
spots the flop cap rejects 0.00% (the flop never reaches 23 outs in practice)
and the turn cap rejects 12.70%; rejection just re-deals, so that costs
generation attempts rather than variety. The mix shifts by at most 2.2pp, on
`strongDraw`, and the hand-mix weights are deliberately **not** compensated for
it. Tests assert both caps hold and that every dealt spot lands inside the
grading band.

The caps also improve the drill independently of tolerance: a 22-out turn count
is typically padded with soft outs — `2h5d` on `9c3s4d2c` has 12 of its 22 going
to bottom two pair, which wins almost nothing.

**Where the band stops holding.** The ±3pp band covers 1–15 outs comfortably,
but the shortcut breaches it at **18+ outs on the turn** and **24+ outs on the
flop**, and those counts do occur: measured over 1,500 generated spots, 12.4% of
turn spots have more than 17 outs (max 28). Those are legitimate counts, not an
over-count — a hand like `2h5d` on `9c3s4d2c` genuinely has 22 improving cards
(wheel draw 8, two-pair outs 12, trips 2), each verified against the blank
benchmark. On such a spot a correctly-applied `×2` can be graded wrong. Widening
the turn band to ±4pp would cover to 21 outs, ±5pp to 28. Left at ±3pp and handled by capping spot generation instead; the thresholds are
asserted in `test/outs.test.ts` so any change to either rule shows up.

### Hand mix

`HAND_MIX_WEIGHTS` in `spot.ts` leans the rotation toward draws (strongDraw 3.0
down to monster 0.5) while keeping made hands in. Pure air is weighted to zero
and excluded — facing a bet with no pair and no draw is not a decision.

Made hands are kept deliberately: once hit probability and equity are separate
inputs, a set with zero outs and 89% equity stops being a grading failure and
becomes the clearest demonstration that counting outs and estimating equity are
different questions.

## UI

Built so far: one full Outs hand, end to end. Preflop mode and the settings
screen are deliberately not wired yet — the interaction is worth correcting on
one working hand before both modes depend on it.

**The feedback screen was designed first** and the hand screen follows it, since
that is where the learning happens. Order on the page: the verdict, then the
answers against truth, then *why* the equity was what it was, then the evidence
— every out grouped by what it makes, the solver's rules verbatim, and the
opponent's narrowed range as a 13×13 grid.

Fields are asked **one at a time** rather than as a form. It keeps the number
pad in one place on a phone, stops a later answer being revised after seeing an
earlier one, and makes the per-field timing exact rather than inferred.

**Soft outs are asked about, not guessed.** Entering 11 against a raw count of
14 could be a deliberate discount or a miscount, and those are opposite lessons
from the same number. A checkbox next to the field decides which feedback fires.

**Per-field timings** appear on the feedback screen, so the time-trial range can
be set from evidence now that there are five fields rather than three.

`?seed=XXX` replays a hand exactly — the mechanism Review mode will use.

Four-colour deck: spades black, hearts red, diamonds blue, clubs green, on light
card faces so a black spade still reads against the dark table. The 13×13 grid
sizes off its container (27px cells at 390px wide), so nothing scrolls
horizontally on an iPhone.

## Environment assumptions

The repo runs in more than one place — a dev container, a GitHub runner — and
two CI failures came from assuming otherwise. What is deliberately not assumed:

- **No hardcoded browser path.** Playwright resolves the browser it installed.
  An environment holding Chromium outside Playwright's versioned layout sets
  `PLAYWRIGHT_CHROMIUM_PATH`.
- **No fixed ports.** The test servers bind port 0 and read back what the OS
  gave them, so parallel jobs on a shared runner cannot collide.
- **No locale-dependent ordering in the engine.** The trimming tie-break in
  `tableScaling.ts` compares by code unit, not `localeCompare` — that ordering
  decides which hands survive table-size trimming, which changes opponent
  ranges, which changes graded truth, so it must not vary with the ICU data a
  Node build happens to ship. A test pins the sequence.
- **No wall-clock gate on correctness.** Timing assertions in the suite are
  generous 5s ceilings that catch an algorithmic regression, not a slow runner.
  Real numbers come from `npm run bench`, which CI runs with
  `continue-on-error` so a busy runner never blocks a deploy.

`toLocaleString` is still used for display formatting, where varying by locale
is the point.

## Still to build

- Preflop mode wiring and the settings screen
- Stats and review mode
