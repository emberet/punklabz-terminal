import 'dotenv/config';
import {
  chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, keccak256,
  type Hex,
} from 'viem';
import { openDb } from '../db/db.js';
import {
  recordCustodyTransfer, separateManagerAndTrader,
} from '../live/accounts.js';
import { haltNetwork } from '../live/riskEngine.js';
import {
  prepareManagerFundingPolicy, provisionIsolatedTrader, restoreManagerPolicies,
  signPrivyOperatorTransaction, USDG_ADDRESS, type Ctx,
} from '../live/signing/provisionPrivy.js';
import { rhChainDef } from '../chain/rhChain.js';

const TRANSFER_ABI = [{
  name: 'Transfer', type: 'event', anonymous: false,
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;
const ERC20_TRANSFER_ABI = [{
  name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const;

interface ProvisionState {
  runId: string;
  walletId: string;
  walletAddress: string;
  managementQuorumId: string;
  runtimeSignerId: string;
  policyId: string;
  createdAt: number;
  transactions?: Record<string, {
    nonce: number;
    hash: string;
    signedPayload?: string;
    receipt?: { blockNumber: number; blockHash: string; gasEth: number; logIndex: number };
  }>;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireSecret(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error(`${name}_FILE is empty`);
    return value;
  }
  return requireEnv(name);
}

function generateKeys(outDir: string): void {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const result: Record<string, string> = {};
  for (const kind of ['management', 'runtime'] as const) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const privateFile = path.join(outDir, `${kind}-authorization-key`);
    writeFileSync(privateFile, `${privateKey}\n`, { mode: 0o600 });
    chmodSync(privateFile, 0o600);
    result[`${kind}PublicKey`] = publicKey;
  }
  writeJson(path.join(outDir, 'public-keys.json'), result);
  console.log(`generated isolated authorization keys in ${outDir}`);
}

async function provision(publicKeysFile: string, stateFile: string, runId: string): Promise<void> {
  const keys = loadJson<{ managementPublicKey: string; runtimePublicKey: string }>(publicKeysFile);
  const result = await provisionIsolatedTrader({
    appId: requireEnv('PRIVY_APP_ID'),
    appSecret: requireSecret('PRIVY_APP_SECRET'),
    managementPublicKey: keys.managementPublicKey,
    runtimePublicKey: keys.runtimePublicKey,
    runId,
  });
  writeJson(stateFile, { runId, ...result, createdAt: Date.now(), transactions: {} } satisfies ProvisionState);
  console.log(JSON.stringify(result, null, 2));
}

async function fund(stateFile: string, managerKeyFile: string): Promise<void> {
  const state = loadJson<ProvisionState>(stateFile);
  state.transactions ??= {};
  const rpc = requireEnv('RPC_ROBINHOOD_PRIMARY');
  const client = createPublicClient({ chain: rhChainDef(4663), transport: http(rpc) });
  if (await client.getChainId() !== 4663) throw new Error('primary RPC is not Robinhood Chain 4663');
  const managerKey = readFileSync(managerKeyFile, 'utf8').trim();
  if (!managerKey) throw new Error('Manager authorization key file is empty');
  const ctx: Ctx = {
    appId: requireEnv('PRIVY_APP_ID'),
    appSecret: requireSecret('PRIVY_APP_SECRET'),
    walletId: requireEnv('PRIVY_WALLET_ID'),
    authorizationKey: managerKey,
  };
  const db = openDb(requireEnv('DB_PATH'));
  haltNetwork(db, 'mainnet custody separation and exact Trader funding in progress', 'operator-ceremony');
  const accounts = separateManagerAndTrader(db, state.walletAddress, 'operator-ceremony');
  let priorPolicies: string[] | null = null;

  const submit = async (
    key: 'usdg' | 'eth', to: string, data: string, value: bigint, gas: bigint,
  ) => {
    const existing = state.transactions![key];
    let hash = existing?.hash as Hex | undefined;
    if (!hash) {
      const [nonce, fees] = await Promise.all([
        client.getTransactionCount({ address: getAddress(accounts.manager.walletAddress!) }),
        client.estimateFeesPerGas(),
      ]);
      const priority = fees.maxPriorityFeePerGas ?? 1_000_000n;
      const maxFee = fees.maxFeePerGas ?? priority * 2n;
      const raw = await signPrivyOperatorTransaction(ctx, {
        to, value, data, nonce, gas, maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priority, idempotencyKey: `${state.runId}-fund-${key}`,
      });
      hash = keccak256(raw as Hex);
      state.transactions![key] = { nonce, hash, signedPayload: raw };
      writeJson(stateFile, state);
      try {
        const returned = await client.sendRawTransaction({ serializedTransaction: raw as Hex });
        if (returned.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC hash differs from signed hash');
      } catch (error) {
        const message = String(error).toLowerCase();
        if (!message.includes('already known') && !message.includes('known transaction')) throw error;
      }
    }
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 12, timeout: 15 * 60_000 });
    if (receipt.status !== 'success') throw new Error(`${key} funding transaction reverted`);
    const block = await client.getBlockNumber();
    const confirmations = Number(block - receipt.blockNumber + 1n);
    if (confirmations < 12) throw new Error(`${key} funding has only ${confirmations} confirmations`);
    const gasEth = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
    let logIndex = -1;
    if (key === 'usdg') {
      const matching = receipt.logs.find((log) => {
        if (log.address.toLowerCase() !== USDG_ADDRESS.toLowerCase()) return false;
        try {
          const decoded = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
          return decoded.eventName === 'Transfer'
            && decoded.args.from.toLowerCase() === accounts.manager.walletAddress!.toLowerCase()
            && decoded.args.to.toLowerCase() === state.walletAddress.toLowerCase()
            && decoded.args.value === 5_000_000n;
        } catch { return false; }
      });
      if (!matching) throw new Error('USDG funding receipt does not contain the exact Manager -> Trader transfer');
      logIndex = Number(matching.logIndex);
    } else {
      const tx = await client.getTransaction({ hash });
      if (tx.to?.toLowerCase() !== state.walletAddress.toLowerCase() || tx.value !== 5_000_000_000_000_000n) {
        throw new Error('ETH funding transaction does not match the exact Trader recipient/value');
      }
    }
    state.transactions![key] = {
      ...state.transactions![key], signedPayload: undefined,
      receipt: { blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash, gasEth, logIndex },
    };
    writeJson(stateFile, state);
    return { hash, confirmations, gasEth, logIndex };
  };

  try {
    const fundingPolicy = await prepareManagerFundingPolicy(ctx, state.walletAddress, state.runId);
    priorPolicies = fundingPolicy.previousPolicyIds;
    if (fundingPolicy.walletAddress.toLowerCase() !== accounts.manager.walletAddress?.toLowerCase()) {
      throw new Error('Privy Manager wallet and Manager account do not match');
    }
    const usdgData = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [getAddress(state.walletAddress), 5_000_000n],
    });
    const usdg = await submit('usdg', USDG_ADDRESS, usdgData, 0n, 100_000n);
    recordCustodyTransfer(db, {
      fromAccountId: accounts.manager.id, toAccountId: accounts.trader.id,
      asset: 'USDG', qty: 5, txRef: usdg.hash, logIndex: usdg.logIndex,
      gasEth: usdg.gasEth, confirmations: usdg.confirmations,
    }, 'operator-ceremony');
    const eth = await submit('eth', state.walletAddress, '0x', 5_000_000_000_000_000n, 21_000n);
    recordCustodyTransfer(db, {
      fromAccountId: accounts.manager.id, toAccountId: accounts.trader.id,
      asset: 'ETH', qty: 0.005, txRef: eth.hash, logIndex: -1,
      gasEth: eth.gasEth, confirmations: eth.confirmations,
    }, 'operator-ceremony');
    console.log(JSON.stringify({ manager: accounts.manager.walletAddress, trader: state.walletAddress,
      usdgTx: usdg.hash, ethTx: eth.hash }, null, 2));
  } finally {
    if (priorPolicies) await restoreManagerPolicies(ctx, priorPolicies);
    db.close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'generate-keys' && args[0]) return generateKeys(path.resolve(args[0]));
  if (command === 'provision' && args.length >= 3) {
    return provision(path.resolve(args[0]), path.resolve(args[1]), args[2]);
  }
  if (command === 'fund' && args.length >= 2) {
    return fund(path.resolve(args[0]), path.resolve(args[1]));
  }
  throw new Error(
    'usage: mainnetExperiment generate-keys <dir> | provision <public-keys.json> <state.json> <run-id> | fund <state.json> <manager-key-file>',
  );
}

void main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
