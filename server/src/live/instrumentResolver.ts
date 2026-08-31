import type { Instrument } from '@punklabz/shared';
import { findInstrument } from './instruments.js';

// Paper signal → live instrument.
//
// The bug this exists to prevent: a strategy trades "ETHUSDT" on the paper
// venue, and something downstream assumes any venue holding a token called ETH
// is an acceptable destination. Ticker collision is how you buy the wrong
// asset. A live instrument is only ever reached through an EXPLICIT mapping
// that names the chain, the exact contract addresses and their decimals.
//
// Nothing is mapped in this build. Every lookup returns "unmapped", which is
// what keeps the live path closed.

export interface LiveTokenSpec {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
}

export interface LiveInstrumentSpec {
  id: string;
  venue: string;
  chainId: number;
  base: LiveTokenSpec;
  quote: LiveTokenSpec;
  /** router/allowance target — must be an explicitly trusted address */
  spender: string;
  minNotionalUsd: number;
}

export interface ResolutionResult {
  mapped: boolean;
  spec: LiveInstrumentSpec | null;
  instrument: Instrument | null;
  reason: string;
}

/**
 * Operator-configured mappings. Empty by design.
 *
 * A real entry names everything needed to build a transaction without guessing:
 *
 *   'ETHUSDT': {
 *     id: 'CRYPTO_SPOT://base/WETH-USDC',
 *     venue: 'evm:base',
 *     chainId: 8453,
 *     base:  { chainId: 8453, address: '0x…', symbol: 'WETH', decimals: 18 },
 *     quote: { chainId: 8453, address: '0x…', symbol: 'USDC', decimals: 6  },
 *     spender: '0x…',        // verified against the venue's published router
 *     minNotionalUsd: 2,
 *   }
 *
 * Every address here must be verified against the venue's own documentation
 * before it is added. An unverified address in this table is an unbounded loss.
 */
const LIVE_MAPPINGS: Record<string, LiveInstrumentSpec> = {};

export function resolveLiveInstrument(paperSymbol: string): ResolutionResult {
  const spec = LIVE_MAPPINGS[paperSymbol];
  if (!spec) {
    return {
      mapped: false,
      spec: null,
      instrument: null,
      reason: `no live instrument mapping configured for ${paperSymbol} — live routing is closed`,
    };
  }
  const instrument = findInstrument(spec.id) ?? null;
  if (!instrument) {
    return { mapped: false, spec, instrument: null, reason: `mapping points at unknown instrument ${spec.id}` };
  }
  if (!instrument.tradable) {
    return { mapped: false, spec, instrument, reason: `${spec.id} is registered but not tradable` };
  }
  return { mapped: true, spec, instrument, reason: `mapped to ${spec.id} on chain ${spec.chainId}` };
}

export function mappedSymbols(): string[] {
  return Object.keys(LIVE_MAPPINGS);
}

/** sanity checks an operator's mapping table must pass before it is trusted */
export function validateMappings(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const [symbol, spec] of Object.entries(LIVE_MAPPINGS)) {
    if (spec.base.chainId !== spec.chainId || spec.quote.chainId !== spec.chainId) {
      problems.push(`${symbol}: token chainId disagrees with instrument chainId`);
    }
    for (const [role, token] of [['base', spec.base], ['quote', spec.quote]] as const) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(token.address)) {
        problems.push(`${symbol}: ${role} address is not a well-formed EVM address`);
      }
      if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
        problems.push(`${symbol}: ${role} decimals look wrong (${token.decimals})`);
      }
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(spec.spender)) {
      problems.push(`${symbol}: spender is not a well-formed address`);
    }
    if (spec.base.address.toLowerCase() === spec.quote.address.toLowerCase()) {
      problems.push(`${symbol}: base and quote are the same token`);
    }
  }
  return { ok: problems.length === 0, problems };
}
