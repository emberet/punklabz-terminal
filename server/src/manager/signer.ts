import { randomUUID } from 'node:crypto';

/**
 * Sends one payout on-chain. StubSigner fakes it; the real one later is an
 * SPL token transfer from a hot wallet — same interface, engine unchanged.
 */
export interface Signer {
  readonly name: string;
  send(address: string, amountMicroUsd: number): Promise<{ txSig: string }>;
}

export class StubSigner implements Signer {
  readonly name = 'stub';
  async send(_address: string, _amountMicroUsd: number): Promise<{ txSig: string }> {
    await new Promise((r) => setTimeout(r, 500));
    return { txSig: `stub:${randomUUID()}` };
  }
}
