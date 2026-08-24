declare module 'phe' {
  export function evaluateCards(cards: string[]): number;
  export function evaluateCardsFast(cards: string[]): number;
  export function evaluateCardCodes(codes: number[]): number;
  export function cardCode(rank: string, suit: string): number;
  export function cardCodes(cards: string[]): number[];
  export function handRank(value: number): number;
  export const rankDescription: string[];
  export function stringifyCardCode(code: number): string;
}
declare module 'phe/lib/evaluator7' {
  const evaluate7: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
  export = evaluate7;
}
declare module 'phe/lib/evaluator6' {
  const evaluate6: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  export = evaluate6;
}
declare module 'phe/lib/evaluator5' {
  const evaluate5: (a: number, b: number, c: number, d: number, e: number) => number;
  export = evaluate5;
}
declare module 'pokersolver' {
  export class Hand {
    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
    rank: number;
    descr: string;
    name: string;
  }
}
