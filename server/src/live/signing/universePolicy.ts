import { createHash } from 'node:crypto';
import type { DB } from '../../db/db.js';
import { activeUniverse, universeAssets } from '../../robinhood/universe.js';
import { lastReferenceQuote, referencePriceGate } from '../../robinhood/referencePrice.js';
import { parseMultiplier } from '../../robinhood/multiplier.js';
import { numberToRaw } from '../pairScanner.js';
import { ZEROX_ALLOWANCE_HOLDER } from './provisionPrivy.js';
import { getLiveConfig } from '../riskEngine.js';
import type { TradingSigner } from './signer.js';

const APPROVE_ABI = [{
  inputs: [{ internalType: 'address', name: 'spender', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' }],
  name: 'approve', outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
  stateMutability: 'nonpayable', type: 'function',
}];

const EXEC_ABI = [{
  inputs: [
    { internalType: 'address', name: 'operator', type: 'address' },
    { internalType: 'address', name: 'token', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' },
    { internalType: 'address payable', name: 'target', type: 'address' },
    { internalType: 'bytes', name: 'data', type: 'bytes' },
  ],
  name: 'exec', outputs: [{ internalType: 'bytes', name: 'result', type: 'bytes' }],
  stateMutability: 'payable', type: 'function',
}];

export interface UniversePolicyBundle {
  snapshotHash: string;
  policyHash: string;
  allowedTargets: string[];
  allowedTargetsHash: string;
  generatedAt: number;
  maxTradeUsd: number;
  policies: { version: string; name: string; chain_type: string; rules: unknown[] }[];
}

export interface SignerAmountPolicyGate {
  eligible: boolean;
  reason: string;
  currentCapUsd: number | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

export function normalizePrivyPolicy(value: unknown): unknown {
  const policy = value as any;
  if (!policy || policy.version !== '1.0' || policy.chain_type !== 'ethereum' || !Array.isArray(policy.rules)) {
    throw new Error('Privy returned an invalid policy body');
  }
  return {
    version: policy.version,
    name: String(policy.name),
    chain_type: policy.chain_type,
    rules: policy.rules.map((rule: any) => {
      if (!rule || !Array.isArray(rule.conditions)) throw new Error('Privy returned an invalid policy rule');
      return {
        name: String(rule.name), method: String(rule.method), action: String(rule.action),
        conditions: rule.conditions.map((condition: any) => {
          const normalized: Record<string, unknown> = {
            field_source: condition.field_source, field: condition.field,
            operator: condition.operator, value: condition.value,
          };
          if (condition.abi !== undefined) normalized.abi = condition.abi;
          return normalized;
        }),
      };
    }),
  };
}

export function generateUniversePolicyBundle(db: DB, maxTradeUsd = 0.5, chunkSize = 20): UniversePolicyBundle {
  getLiveConfig(db);
  const snapshot = activeUniverse(db);
  if (!snapshot) throw new Error('no active universe snapshot');
  if (!(maxTradeUsd > 0) || maxTradeUsd > 0.5) throw new Error('signer per-transaction cap cannot exceed $0.50');
  const assets = universeAssets(db, snapshot.id);
  const policyCaps: { contractAddress: string; referencePriceUsd: number; rawCap: bigint }[] = [];
  const tokenRules = assets.map((asset) => {
    const quote = asset.symbol === 'USDG' ? null : lastReferenceQuote(db, asset.symbol);
    const gate = asset.symbol === 'USDG' ? { usable: true, reason: 'settlement asset' } : referencePriceGate(quote);
    const referencePriceUsd = asset.symbol === 'USDG' ? 1
      : quote ? quote.mid * (Number(parseMultiplier(asset.multiplier)) / 1e18) : null;
    if (!gate.usable || !referencePriceUsd || !Number.isFinite(referencePriceUsd)) {
      throw new Error(`${asset.symbol} has no usable reference price for signer amount policy`);
    }
    const rawCap = numberToRaw(maxTradeUsd / referencePriceUsd, asset.decimals);
    if (rawCap <= 0n) throw new Error(`${asset.symbol} signer cap rounds to zero`);
    policyCaps.push({ contractAddress: asset.contractAddress, referencePriceUsd, rawCap });
    const cap = `0x${rawCap.toString(16).toUpperCase()}`;
    return [
      {
        name: `${asset.symbol.slice(0, 18)} exact approval cap`, method: 'eth_signTransaction', action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: asset.contractAddress },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0x0' },
          { field_source: 'ethereum_calldata', field: 'approve.spender', abi: APPROVE_ABI,
            operator: 'eq', value: ZEROX_ALLOWANCE_HOLDER },
          { field_source: 'ethereum_calldata', field: 'approve.amount', abi: APPROVE_ABI,
            operator: 'lte', value: cap },
        ],
      },
      {
        name: `${asset.symbol.slice(0, 20)} swap cap`, method: 'eth_signTransaction', action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: ZEROX_ALLOWANCE_HOLDER },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0x0' },
          { field_source: 'ethereum_calldata', field: 'exec.token', abi: EXEC_ABI,
            operator: 'eq', value: asset.contractAddress },
          { field_source: 'ethereum_calldata', field: 'exec.amount', abi: EXEC_ABI,
            operator: 'lte', value: cap },
        ],
      },
    ];
  });
  const policies: UniversePolicyBundle['policies'] = [];
  for (let i = 0; i < tokenRules.length; i += chunkSize) {
    policies.push({ version: '1.0', name: `PunkLabz ${snapshot.contentHash.slice(7, 15)} ${i / chunkSize + 1}`,
      chain_type: 'ethereum', rules: tokenRules.slice(i, i + chunkSize).flat() });
  }
  const allowedTargets = [...new Set(assets.map((a) => a.contractAddress.toLowerCase())
    .concat(ZEROX_ALLOWANCE_HOLDER.toLowerCase()))].sort();
  const content = { snapshotHash: snapshot.contentHash, maxTradeUsd, policies };
  const bundle: UniversePolicyBundle = {
    ...content, policyHash: hash(content), allowedTargets,
    allowedTargetsHash: createHash('sha256').update(JSON.stringify(allowedTargets)).digest('hex'),
    generatedAt: Date.now(),
  };
  db.transaction(() => {
    const recordCap = db.prepare(
      `UPDATE rh_universe_assets SET policy_reference_price_usd=?, policy_raw_cap=?
       WHERE snapshot_id=? AND contract_address=?`,
    );
    for (const cap of policyCaps) recordCap.run(
      String(cap.referencePriceUsd), cap.rawCap.toString(), snapshot.id, cap.contractAddress,
    );
    db.prepare(`UPDATE rh_universe_snapshots SET policy_hash=?, policy_bundle_json=? WHERE id=?`)
      .run(bundle.policyHash, JSON.stringify(content), snapshot.id);
    db.prepare(
      `UPDATE live_config SET expected_signer_policy_hash=?, observed_signer_policy_hash=NULL,
       full_market_autonomy=0, autonomy_enabled=0, halted=1, halt_reason=?, updated_at=? WHERE id=1`,
    ).run(bundle.policyHash, 'new snapshot-bound signer policy generated; manual Privy application and read-back required', Date.now());
  })();
  return bundle;
}

/**
 * Privy policies cap raw token units, so their USD value can drift as prices move.
 * Refuse an amount once the stored raw cap is absent, exceeded, or worth more than
 * the policy's reviewed USD ceiling. Regenerating the policy is a manual action.
 */
export function signerAmountPolicyGate(
  db: DB, snapshotId: number, asset: ReturnType<typeof universeAssets>[number], amountRaw?: bigint,
): SignerAmountPolicyGate {
  if (!asset.policyReferencePriceUsd || !asset.policyRawCap) {
    return { eligible: false, reason: `${asset.symbol} has no generated signer amount cap`, currentCapUsd: null };
  }
  let rawCap: bigint;
  try { rawCap = BigInt(asset.policyRawCap); }
  catch { return { eligible: false, reason: `${asset.symbol} signer amount cap is invalid`, currentCapUsd: null }; }
  if (rawCap <= 0n) return { eligible: false, reason: `${asset.symbol} signer amount cap is zero`, currentCapUsd: null };
  const snapshot = db.prepare(`SELECT policy_bundle_json FROM rh_universe_snapshots WHERE id=?`).get(snapshotId) as
    { policy_bundle_json: string | null } | undefined;
  if (!snapshot?.policy_bundle_json) {
    return { eligible: false, reason: 'stored signer policy bundle is missing', currentCapUsd: null };
  }
  let maxTradeUsd: number;
  try { maxTradeUsd = Number(JSON.parse(snapshot.policy_bundle_json).maxTradeUsd); }
  catch { return { eligible: false, reason: 'stored signer policy bundle is invalid', currentCapUsd: null }; }
  const quote = asset.symbol === 'USDG' ? null : lastReferenceQuote(db, asset.symbol);
  const priceGate = asset.symbol === 'USDG' ? { usable: true, reason: 'settlement asset' } : referencePriceGate(quote);
  const currentPriceUsd = asset.symbol === 'USDG' ? 1
    : quote ? quote.mid * (Number(parseMultiplier(asset.multiplier)) / 1e18) : null;
  if (!priceGate.usable || !currentPriceUsd || !Number.isFinite(currentPriceUsd)) {
    return { eligible: false, reason: `${asset.symbol} has no current price for signer cap validation`, currentCapUsd: null };
  }
  const currentCapUsd = Number(rawCap) / (10 ** asset.decimals) * currentPriceUsd;
  if (!Number.isFinite(currentCapUsd) || currentCapUsd > maxTradeUsd + 1e-9) {
    return { eligible: false,
      reason: `${asset.symbol} signer raw cap is now worth $${currentCapUsd.toFixed(6)}, above $${maxTradeUsd.toFixed(2)}`,
      currentCapUsd };
  }
  if (amountRaw !== undefined && amountRaw > rawCap) {
    return { eligible: false, reason: `${asset.symbol} amount ${amountRaw} exceeds signer raw cap ${rawCap}`, currentCapUsd };
  }
  return { eligible: true, reason: 'signer raw amount cap remains within its reviewed USD ceiling', currentCapUsd };
}

export function recordAppliedUniversePolicy(
  db: DB, policyHash: string, policyIds: string[], observedPolicyIds: string[],
  observedPolicyBodies: unknown[], actor: string,
): void {
  const snapshot = activeUniverse(db);
  if (!snapshot || snapshot.policyHash !== policyHash) throw new Error('policy hash is not the active snapshot policy');
  const expectedSet = [...new Set(policyIds)].sort();
  const observedSet = [...new Set(observedPolicyIds)].sort();
  if (!expectedSet.length || JSON.stringify(expectedSet) !== JSON.stringify(observedSet)) {
    throw new Error('Privy policy IDs do not exactly match the reviewed bundle');
  }
  const row = db.prepare(`SELECT policy_bundle_json FROM rh_universe_snapshots WHERE id=?`).get(snapshot.id) as
    { policy_bundle_json: string | null };
  if (!row.policy_bundle_json) throw new Error('generated policy bundle is not stored');
  const expected = JSON.parse(row.policy_bundle_json) as { snapshotHash: string; maxTradeUsd: number; policies: unknown[] };
  if (observedPolicyBodies.length !== expected.policies.length || policyIds.length !== expected.policies.length) {
    throw new Error('Privy policy body count does not match the generated bundle');
  }
  const observedContent = { snapshotHash: expected.snapshotHash, maxTradeUsd: expected.maxTradeUsd,
    policies: observedPolicyBodies.map(normalizePrivyPolicy) };
  if (hash(observedContent) !== policyHash) throw new Error('live Privy policy rules do not match the generated bundle hash');
  db.transaction(() => {
    db.prepare(`UPDATE rh_universe_snapshots SET policy_ids_json=? WHERE id=?`).run(JSON.stringify(policyIds), snapshot.id);
    db.prepare(
      `UPDATE live_config SET observed_signer_policy_hash=?, full_market_autonomy=0,
       autonomy_enabled=0, halted=1, halt_reason=?, updated_at=? WHERE id=1`,
    ).run(policyHash, `snapshot policy read back from Privy by ${actor}; remaining activation gates still required`, Date.now());
  })();
}

export async function verifyActiveUniversePolicy(db: DB, signer: TradingSigner): Promise<{ ok: boolean; detail: string }> {
  const snapshot = activeUniverse(db);
  if (!snapshot?.policyHash || !snapshot.policyIds.length) return { ok: false, detail: 'active snapshot has no applied policy' };
  if (!signer.getPolicyBodies) return { ok: false, detail: 'signer cannot read back policy rule bodies' };
  try {
    const row = db.prepare(`SELECT policy_bundle_json FROM rh_universe_snapshots WHERE id=?`).get(snapshot.id) as
      { policy_bundle_json: string | null };
    if (!row.policy_bundle_json) return { ok: false, detail: 'stored policy bundle is missing' };
    const expected = JSON.parse(row.policy_bundle_json) as { snapshotHash: string; maxTradeUsd: number; policies: unknown[] };
    const bodies = await signer.getPolicyBodies(snapshot.policyIds);
    const observed = { snapshotHash: expected.snapshotHash, maxTradeUsd: expected.maxTradeUsd,
      policies: bodies.map(normalizePrivyPolicy) };
    const observedHash = hash(observed);
    return observedHash === snapshot.policyHash
      ? { ok: true, detail: `live Privy rules match ${snapshot.policyHash}` }
      : { ok: false, detail: `live Privy policy hash ${observedHash} differs from ${snapshot.policyHash}` };
  } catch (error) {
    return { ok: false, detail: `Privy policy read-back failed: ${String(error).slice(0, 180)}` };
  }
}
