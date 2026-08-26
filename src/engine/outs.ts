/**
 * outs.ts — counting outs, and the rule of 4 and 2.
 *
 * An OUT is a single unseen card that improves HERO's hand specifically — not
 * merely one that raises hero's category.
 *
 * The distinction matters and is easy to get wrong. On Kd 8h 3h holding Ah Qh,
 * any card pairing the board lifts hero from high card to one pair, so a naive
 * "did my category go up" test counts 23 outs and the rule of 4 reports 92%.
 * That is nonsense: a paired board hands the same pair to everyone.
 *
 * So each candidate card is measured against a BENCHMARK: the best hand a
 * player holding two blanks could make on the same board. A card is an out only
 * when it lifts hero's category ABOVE what that blank hand achieves. Pairing
 * the board lifts both equally and is correctly excluded; a flush card, or a
 * card pairing one of hero's own cards, lifts only hero and counts.
 *
 * The benchmark is computed exactly, by minimising over every possible pair of
 * blanks rather than picking one by hand, so there is no judgement in it.
 *
 * What this deliberately does NOT do is judge whether an out is CLEAN — whether
 * the card that improves hero also improves the opponent, or whether the
 * improved hand is actually ahead. That needs the opponent's range, which is
 * what the Monte Carlo engine does properly. The gap between this count and
 * engine truth is the thing the trainer has to teach, so it is measured rather
 * than papered over — see `npm run calibrate`.
 */

import {
  type Card,
  type CardCode,
  DECK_SIZE,
  cardFromCode,
} from './deck';
import {
  HAND_CATEGORIES,
  type HandCategory,
  evaluator,
  categoryOfStrength,
} from './evaluator';

export interface Out {
  readonly card: Card;
  readonly code: CardCode;
  /** The category this card lifts hero to. */
  readonly to: HandCategory;
}

export interface OutsCount {
  /** Hero's category right now, on the visible board. */
  readonly currentCategory: HandCategory;
  /** Every card that raises hero's category. */
  readonly outs: readonly Out[];
  /** Convenience: `outs.length`. */
  readonly total: number;
  /** How many outs lift hero to each category. */
  readonly byCategory: ReadonlyArray<{ category: HandCategory; count: number }>;
  /** Cards still unseen from hero's point of view. */
  readonly unseen: number;
}

/**
 * Counts hero's outs on the current board.
 *
 * Requires a board of 3 or 4 cards: there are no outs preflop (no hand yet to
 * improve on) and none on the river (no cards to come).
 */
export function countOuts(
  hole: readonly CardCode[],
  board: readonly CardCode[],
): OutsCount {
  if (hole.length !== 2) {
    throw new Error(`Hero must hold exactly 2 cards, received ${hole.length}`);
  }
  if (board.length !== 3 && board.length !== 4) {
    throw new Error(
      `Outs are only defined on the flop or turn, received a board of ${board.length}`,
    );
  }

  const seen = new Uint8Array(DECK_SIZE);
  for (const code of [...hole, ...board]) {
    if (seen[code]) throw new Error(`Duplicate card: ${code}`);
    seen[code] = 1;
  }

  const currentIndex = categoryOfStrength(evaluator.strengthOfCodes([...hole, ...board]));
  const unseenCards: CardCode[] = [];
  for (let code = 0; code < DECK_SIZE; code++) if (!seen[code]) unseenCards.push(code);

  const outs: Out[] = [];

  for (const code of unseenCards) {
    const heroIndex = categoryOfStrength(
      evaluator.strengthOfCodes([...hole, ...board, code]),
    );
    if (heroIndex <= currentIndex) continue;
    if (heroIndex > blankBenchmark(board, code, unseenCards)) {
      outs.push({
        card: cardFromCode(code),
        code,
        to: HAND_CATEGORIES[heroIndex] as HandCategory,
      });
    }
  }

  const counts = new Map<HandCategory, number>();
  for (const out of outs) counts.set(out.to, (counts.get(out.to) ?? 0) + 1);

  return {
    currentCategory: HAND_CATEGORIES[currentIndex] as HandCategory,
    outs,
    total: outs.length,
    byCategory: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    unseen: DECK_SIZE - hole.length - board.length,
  };
}

/**
 * The best category a player holding two blanks could make on `board` plus
 * `candidate`.
 *
 * Minimised over every available pair of blanks, so it measures what the board
 * gives away to everyone rather than depending on which blanks are chosen.
 */
function blankBenchmark(
  board: readonly CardCode[],
  candidate: CardCode,
  unseenCards: readonly CardCode[],
): number {
  const pool = unseenCards.filter((code) => code !== candidate);
  const withCandidate = [...board, candidate];
  let best: number = HAND_CATEGORIES.length;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const index = categoryOfStrength(evaluator.strengthOfCodes(
        [...withCandidate, pool[i] as CardCode, pool[j] as CardCode],
      ));
      if (index < best) {
        best = index;
        if (best === 0) return best; // cannot go lower than High Card
      }
    }
  }
  return best;
}

/**
 * The unadjusted rule of 4 and 2: `outs x 4` with two cards to come, `outs x 2`
 * with one.
 *
 * Kept for the calibration report, which measures how much the shortcut's
 * arithmetic contributes to the gap against engine truth. It is NOT what the
 * trainer grades against — see `adjustedRuleOfThumb`, which is the method
 * players actually use and is dramatically more accurate.
 */
export function ruleOfFourAndTwo(outs: number, cardsToCome: number): number {
  if (cardsToCome !== 1 && cardsToCome !== 2) {
    throw new Error(`Cards to come must be 1 or 2, received ${cardsToCome}`);
  }
  return Math.min(100, outs * (cardsToCome === 2 ? 4 : 2));
}

/**
 * The rule of 4 and 2 as it is actually taught and used: with two cards to
 * come, multiply by four and then subtract the excess over eight outs.
 *
 * The plain shortcut drifts badly at high out counts because it double-counts
 * runouts that hit on both cards — at 15 outs it reads 60% against a true
 * 54.1%. The adjustment corrects almost exactly for that:
 *
 *     outs   exact   plain x4   adjusted   error
 *        9   35.0%      36         35      +0.0pp
 *       12   45.0%      48         44      -1.0pp
 *       14   51.2%      56         50      -1.2pp
 *       15   54.1%      60         53      -1.1pp
 *
 * Across 1-15 outs the worst flop error is -1.2pp. On the turn no adjustment
 * applies and `outs x 2` is used unchanged; its error grows with the out count
 * (-2.6pp at 15 outs) because x2 implicitly assumes 50 unseen cards rather than
 * the actual 46. See the note in README about out counts above 17 on the turn.
 */
export function adjustedRuleOfThumb(outs: number, cardsToCome: number): number {
  if (cardsToCome !== 1 && cardsToCome !== 2) {
    throw new Error(`Cards to come must be 1 or 2, received ${cardsToCome}`);
  }
  if (cardsToCome === 1) return Math.min(100, outs * 2);
  return Math.min(100, outs * 4 - Math.max(0, outs - 8));
}

/**
 * The exact probability of hitting at least one of `outs` cards, ignoring the
 * opponent entirely. This is what the rule of 4 and 2 approximates, and the
 * difference between the two is pure arithmetic error — small, and quite
 * separate from the much larger error of ignoring the opponent's range.
 */
export function exactHitProbability(outs: number, cardsToCome: number, unseen: number): number {
  if (outs <= 0) return 0;
  if (cardsToCome === 1) return (outs / unseen) * 100;
  const missFirst = (unseen - outs) / unseen;
  const missSecond = (unseen - outs - 1) / (unseen - 1);
  return (1 - missFirst * missSecond) * 100;
}
