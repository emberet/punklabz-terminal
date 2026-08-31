import {
  ROBINHOOD_MAINNET_CHAIN_ID, USDG, atLeast,
  type RhAssetClass, type EligibilityState,
} from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { getAsset } from './assetRegistry.js';
import { corporateActionState } from './corporateActions.js';
import { parseMultiplier, pendingMultiplier } from './multiplier.js';
import { registryStatus } from './assetRegistry.js';

// THE RESOLVER.
//
// Strategies name a logical symbol — AAPL — and never an address. Everything
// that turns that into something signable happens here, from the verified
// registry, so a strategy config can never smuggle in a contract address.
//
// This replaces the hand-maintained mapping table for Robinhood assets. The
// old model was an explicitly empty `LIVE_MAPPINGS` object whose emptiness was
// the safety property; the safety property now is that an instrument must be
// present in the registry AND verified onchain AND clear of corporate actions
// AND eligible for the current mode. That is strictly stronger than a
// hand-typed table, because nobody can typo an address into it.

export interface RhInstrument {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: RhAssetClass;
  network: 'ROBINHOOD';
  chainId: number;
  venue: string;
  contractAddress: string;
  decimals: number;
  multiplier: bigint;
  quoteAsset: string;
  quoteContract: string;
  quoteDecimals: number;
  underlyingSymbol: string;
  isin: string | null;
  eligibility: EligibilityState;
  tradingStatus: string;
}

export interface Resolution {
  resolved: boolean;
  instrument: RhInstrument | null;
  reason: string;
  /** every gate consulted, so a refusal is explainable in the terminal */
  checks: { name: string; pass: boolean; detail: string }[];
}

export const ZEROX_ROBINHOOD_VENUE = 'zerox:robinhood';

/**
 * Resolve a logical symbol for a given execution mode. `requiredEligibility`
 * rises with the mode, so the same symbol can be researchable but not
 * canary-tradable without any special-casing at the call site.
 */
export function resolveRobinhoodInstrument(
  db: DB,
  symbol: string,
  requiredEligibility: EligibilityState = 'RESEARCH_ONLY',
  chainId = ROBINHOOD_MAINNET_CHAIN_ID,
): Resolution {
  const checks: Resolution['checks'] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const fail = (reason: string): Resolution => ({ resolved: false, instrument: null, reason, checks });

  const clean = String(symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,16}$/.test(clean)) {
    add('symbol_shape', false, `"${symbol}" is not a plausible ticker`);
    return fail('symbol is not a plausible ticker — strategies name symbols, never addresses');
  }
  add('symbol_shape', true, clean);

  const asset = getAsset(db, clean, chainId);
  if (!asset) {
    add('in_registry', false, `${clean} is not in the asset registry`);
    return fail(`${clean} is not a registered Robinhood Chain asset`);
  }
  add('in_registry', true, `${asset.name}`);

  if (asset.chainId !== chainId) {
    add('chain', false, `registry says chain ${asset.chainId}, expected ${chainId}`);
    return fail('asset is registered on a different chain');
  }
  add('chain', true, `chain ${chainId}`);

  const registry = registryStatus(db);
  add('registry_fresh', !registry.stale,
    registry.stale
      ? `registry last refreshed ${registry.ageMs === null ? 'never' : `${(registry.ageMs / 3_600_000).toFixed(1)}h ago`} — STALE`
      : `refreshed ${((registry.ageMs ?? 0) / 60_000).toFixed(0)}m ago`);

  add('verified_onchain', asset.verifiedOnchain,
    asset.verifiedOnchain ? 'contract, decimals and multiplier confirmed' : 'never confirmed against the chain');

  add('tradable', asset.tradable, asset.tradable ? asset.status : `status ${asset.status}`);

  // decimals are load-bearing arithmetic; a missing value is not a default
  const decimalsOk = Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 36;
  add('decimals_known', decimalsOk, decimalsOk ? `${asset.decimals}` : 'decimals unknown — cannot size an order');

  const multiplier = parseMultiplier(asset.multiplier);
  const pending = pendingMultiplier(
    multiplier,
    asset.pendingMultiplier ? parseMultiplier(asset.pendingMultiplier) : multiplier,
    asset.pendingEffectiveAt,
  );
  add('no_pending_multiplier', !pending.pending && !pending.overdue,
    pending.pending
      ? 'a multiplier change is scheduled — stand down until it applies'
      : pending.overdue
        ? 'a multiplier change is already effective but not yet re-verified'
        : `multiplier ${asset.multiplier}`);

  const corp = corporateActionState(db, clean);
  add('no_corporate_action', !corp.blocked, corp.blocked ? corp.reason! : 'no unresolved corporate action');

  const eligible = atLeast(asset.eligibility, requiredEligibility);
  add('eligibility', eligible, `${asset.eligibility}, needs at least ${requiredEligibility}`);

  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    return fail(failed.map((c) => `${c.name}: ${c.detail}`).join('; '));
  }

  return {
    resolved: true,
    reason: `resolved to ${asset.contractAddress} on chain ${chainId}`,
    checks,
    instrument: {
      id: `RH://${chainId}/${clean}`,
      symbol: clean,
      displayName: asset.name,
      assetClass: asset.assetClass,
      network: 'ROBINHOOD',
      chainId,
      venue: ZEROX_ROBINHOOD_VENUE,
      contractAddress: asset.contractAddress,
      decimals: asset.decimals,
      multiplier,
      quoteAsset: USDG.symbol,
      quoteContract: USDG.address.toLowerCase(),
      // 6, not 18. The single most expensive constant in this file.
      quoteDecimals: USDG.decimals,
      underlyingSymbol: asset.underlyingSymbol,
      isin: asset.isin,
      eligibility: asset.eligibility,
      tradingStatus: asset.status,
    },
  };
}

/** The eligibility a mode demands before an instrument may be routed. */
export function eligibilityForMode(mode: string): EligibilityState {
  switch (mode) {
    case 'live': return 'LIVE_ALLOWED';
    case 'canary': return 'CANARY_ALLOWED';
    case 'shadow': return 'SHADOW_ONLY';
    default: return 'RESEARCH_ONLY';
  }
}

export interface EligibilityDecision {
  state: EligibilityState;
  reason: string;
}

/**
 * The eligibility service. Promotion is evidence-based and one step at a time:
 * nothing jumps to LIVE_ALLOWED, and every downgrade is immediate.
 */
export function evaluateEligibility(db: DB, symbol: string): EligibilityDecision {
  const asset = getAsset(db, symbol);
  if (!asset) return { state: 'BLOCKED', reason: 'not in the registry' };
  if (!asset.verifiedOnchain) return { state: 'BLOCKED', reason: 'not verified against the chain' };
  if (!asset.tradable) return { state: 'RESEARCH_ONLY', reason: `trading status ${asset.status}` };

  const corp = corporateActionState(db, symbol);
  if (corp.blocked) return { state: 'RESEARCH_ONLY', reason: corp.reason! };

  const multiplier = parseMultiplier(asset.multiplier);
  const pending = pendingMultiplier(
    multiplier,
    asset.pendingMultiplier ? parseMultiplier(asset.pendingMultiplier) : multiplier,
    asset.pendingEffectiveAt,
  );
  if (pending.pending || pending.overdue) {
    return { state: 'RESEARCH_ONLY', reason: 'multiplier change outstanding' };
  }

  const registry = registryStatus(db);
  if (registry.stale) return { state: 'RESEARCH_ONLY', reason: 'asset registry is stale' };

  // Everything the system can check automatically now passes. Anything beyond
  // SHADOW is an operator decision backed by canary evidence, so this function
  // deliberately cannot return CANARY_ALLOWED or LIVE_ALLOWED.
  return { state: 'SHADOW_ONLY', reason: 'verified and clear; live eligibility is an operator decision' };
}

export function applyEligibility(db: DB, symbol: string): EligibilityDecision {
  const decision = evaluateEligibility(db, symbol);
  const current = getAsset(db, symbol);
  // never silently downgrade an operator-granted state without saying so
  if (current && atLeast(current.eligibility, 'CANARY_ALLOWED') && decision.state === 'SHADOW_ONLY') {
    return { state: current.eligibility, reason: 'operator-granted; automatic checks pass' };
  }
  db.prepare(
    `UPDATE rh_assets SET eligibility = ?, eligibility_reason = ?, updated_at = ? WHERE symbol = ?`,
  ).run(decision.state, decision.reason, Date.now(), symbol);
  return decision;
}
