import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem';
import {
  ROBINHOOD_CHAINS, ROBINHOOD_MAINNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID,
} from '@punklabz/shared';
import type { DB } from '../db/db.js';

// THE CHAIN CLIENT.
//
// One RPC is a single point of failure, and the documented public endpoint is
// explicitly "rate-limited and not recommended for production use". So the
// client is built as an ordered fallback: operator-supplied endpoints first,
// public endpoint last and only as a lifeline.
//
// The chain id is checked on every health pass rather than trusted from
// config. An RPC that answers but reports the wrong chain is the worst failure
// mode available here — it looks healthy and it signs against the wrong world.

export interface RpcEndpoint {
  label: string;
  url: string;
}

function endpointsFor(chainId: number): RpcEndpoint[] {
  const meta = ROBINHOOD_CHAINS[chainId];
  if (!meta) throw new Error(`unknown Robinhood chain id ${chainId}`);

  const isTestnet = meta.isTestnet;
  const primary = isTestnet ? process.env.RPC_ROBINHOOD_TESTNET_PRIMARY : process.env.RPC_ROBINHOOD_PRIMARY;
  const secondary = isTestnet ? process.env.RPC_ROBINHOOD_TESTNET_SECONDARY : process.env.RPC_ROBINHOOD_SECONDARY;

  const out: RpcEndpoint[] = [];
  if (primary) out.push({ label: 'primary', url: primary });
  if (secondary) out.push({ label: 'secondary', url: secondary });
  out.push({ label: 'public', url: meta.publicRpcUrl });
  return out;
}

export function rhChainDef(chainId: number) {
  const meta = ROBINHOOD_CHAINS[chainId];
  if (!meta) throw new Error(`unknown Robinhood chain id ${chainId}`);
  return defineChain({
    id: meta.chainId,
    name: meta.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [meta.publicRpcUrl] } },
    blockExplorers: { default: { name: 'Blockscout', url: meta.explorerUrl } },
    // Multicall3 is deployed at the canonical cross-chain address here —
    // verified by reading 3,808 bytes of code at it on mainnet. Declaring it
    // turns a 194-token balance scan into one RPC round trip; without the
    // declaration viem refuses to batch at all.
    contracts: {
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const },
    },
    testnet: meta.isTestnet,
  });
}

const clients = new Map<number, PublicClient>();

export function rhClient(chainId = ROBINHOOD_MAINNET_CHAIN_ID): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const endpoints = endpointsFor(chainId);
  const client = createPublicClient({
    chain: rhChainDef(chainId),
    transport: fallback(
      endpoints.map((e) => http(e.url, { timeout: 12_000, retryCount: 2 })),
      { rank: false },
    ),
  }) as PublicClient;
  clients.set(chainId, client);
  return client;
}

export interface RpcHealth {
  label: string;
  url: string;
  ok: boolean;
  blockNumber: number | null;
  chainIdReported: number | null;
  latencyMs: number;
  error: string | null;
}

/**
 * Probe each endpoint individually. `fallback()` hides which one answered,
 * and for health reporting that is exactly what we need to know.
 */
export async function probeEndpoints(chainId = ROBINHOOD_MAINNET_CHAIN_ID): Promise<RpcHealth[]> {
  return Promise.all(endpointsFor(chainId).map(async (endpoint): Promise<RpcHealth> => {
    const started = Date.now();
    try {
      const probe = createPublicClient({ chain: rhChainDef(chainId), transport: http(endpoint.url, { timeout: 8000, retryCount: 0 }) });
      const [reported, block] = await Promise.all([probe.getChainId(), probe.getBlockNumber()]);
      return {
        label: endpoint.label,
        url: redact(endpoint.url),
        ok: reported === chainId,
        blockNumber: Number(block),
        chainIdReported: reported,
        latencyMs: Date.now() - started,
        error: reported === chainId ? null : `endpoint reports chain ${reported}, expected ${chainId}`,
      };
    } catch (e) {
      return {
        label: endpoint.label, url: redact(endpoint.url), ok: false, blockNumber: null,
        chainIdReported: null, latencyMs: Date.now() - started,
        error: String(e instanceof Error ? e.message : e).slice(0, 160),
      };
    }
  }));
}

/** RPC URLs carry API keys. They are never logged or returned whole. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length && parts[parts.length - 1].length > 8) parts[parts.length - 1] = '…';
    u.search = '';
    return `${u.origin}/${parts.join('/')}`;
  } catch {
    return 'malformed-url';
  }
}

export interface ChainHealth {
  chainId: number;
  ok: boolean;
  /** true only when more than one endpoint answered correctly */
  redundant: boolean;
  blockNumber: number | null;
  endpoints: RpcHealth[];
  detail: string;
}

export async function checkChainHealth(db: DB, chainId = ROBINHOOD_MAINNET_CHAIN_ID): Promise<ChainHealth> {
  const endpoints = await probeEndpoints(chainId);
  const healthy = endpoints.filter((e) => e.ok);
  const blocks = healthy.map((e) => e.blockNumber ?? 0);
  const spread = blocks.length > 1 ? Math.max(...blocks) - Math.min(...blocks) : 0;

  const stmt = db.prepare(
    `INSERT INTO rh_chain_health (ts, chain_id, rpc_label, ok, block_number, latency_ms, chain_id_reported, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (const e of endpoints) {
      stmt.run(now, chainId, e.label, e.ok ? 1 : 0, e.blockNumber, e.latencyMs, e.chainIdReported, e.error);
    }
    db.prepare(`DELETE FROM rh_chain_health WHERE ts < ?`).run(now - 7 * 86_400_000);
  })();

  // Endpoints that disagree by more than a handful of blocks are not simply
  // lagging — one of them may be on a fork or serving cached state.
  const disagreement = spread > 50;
  return {
    chainId,
    ok: healthy.length > 0 && !disagreement,
    redundant: healthy.length > 1,
    blockNumber: blocks.length ? Math.max(...blocks) : null,
    endpoints,
    detail: healthy.length === 0
      ? 'no RPC endpoint answered correctly'
      : disagreement
        ? `endpoints disagree by ${spread} blocks — refusing to treat chain state as known`
        : `${healthy.length}/${endpoints.length} endpoint(s) healthy at block ${Math.max(...blocks)}`,
  };
}

export const CHAIN_IDS = {
  mainnet: ROBINHOOD_MAINNET_CHAIN_ID,
  testnet: ROBINHOOD_TESTNET_CHAIN_ID,
};

/** The chain this install treats as home. Testnet is a first-class choice. */
export function primaryChainId(): number {
  const raw = process.env.PRIMARY_CHAIN_ID;
  if (!raw) return ROBINHOOD_MAINNET_CHAIN_ID;
  const parsed = Number(raw);
  if (!ROBINHOOD_CHAINS[parsed]) {
    throw new Error(
      `PRIMARY_CHAIN_ID=${raw} is not a Robinhood chain. Valid: ` +
        `${ROBINHOOD_MAINNET_CHAIN_ID} (mainnet), ${ROBINHOOD_TESTNET_CHAIN_ID} (testnet)`,
    );
  }
  return parsed;
}
