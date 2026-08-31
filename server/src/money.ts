import { MICRO } from '@punklabz/shared';

/** USD number -> integer micro-USD. Rounds to nearest micro. */
export function toMicro(usd: number): number {
  return Math.round(usd * MICRO);
}

/** integer micro-USD -> USD number (display only; never feed back into ledger math). */
export function fromMicro(micro: number): number {
  return micro / MICRO;
}
