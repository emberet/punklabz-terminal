import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { renderSweep, sweepWalletToOperator } from './sweepToOperator.js';
import type { Ctx } from '../live/signing/provisionPrivy.js';

// OPERATOR SWEEP — decommission a Privy wallet by sending everything home.
//
// Dry run is the DEFAULT and --execute is the only way past it. A tool that
// moves real money on its default invocation is a tool that eventually moves
// real money by accident.
//
//   node server/dist/ops/sweepCli.js --wallet <privy_wallet_id> --to <0x...>
//   node server/dist/ops/sweepCli.js --wallet <privy_wallet_id> --to <0x...> --execute
//
// Run it on the server: the authorization key that signs the policy PATCH
// lives in a systemd credential file and is deliberately not available
// anywhere else.

function credential(fileEnv: string, inlineEnv: string): string {
  const file = process.env[fileEnv];
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return process.env[inlineEnv] ?? '';
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const walletId = arg('wallet') ?? process.env.PRIVY_WALLET_ID ?? '';
  const destination = arg('to') ?? '';
  const dryRun = !process.argv.includes('--execute');
  const rpcUrl = arg('rpc') ?? process.env.RPC_ROBINHOOD_PRIMARY ?? 'https://rpc.mainnet.chain.robinhood.com';

  const ctx: Ctx = {
    appId: process.env.PRIVY_APP_ID ?? '',
    appSecret: credential('PRIVY_APP_SECRET_FILE', 'PRIVY_APP_SECRET'),
    walletId,
    authorizationKey: credential('PRIVY_AUTHORIZATION_KEY_FILE', 'PRIVY_AUTHORIZATION_KEY'),
  };

  const missing = [
    !ctx.appId && 'PRIVY_APP_ID',
    !ctx.appSecret && 'PRIVY_APP_SECRET(_FILE)',
    !walletId && '--wallet or PRIVY_WALLET_ID',
    !destination && '--to <destination address>',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`missing: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (!ctx.authorizationKey) {
    // Not fatal for a dry run, but it will be the moment we try to PATCH the
    // policy — say so now rather than after the balances are printed.
    console.error('WARNING: no authorization key — the policy swap will fail if this wallet has an owner\n');
  }

  const report = await sweepWalletToOperator({
    ctx, rpcUrl, destination, runId: `sweep-${randomUUID().slice(0, 8)}`, dryRun,
  });
  console.log(renderSweep(report));

  if (dryRun && report.steps.length) {
    console.log('\nnothing was signed. re-run with --execute to send.');
  }
}

main().catch((e) => {
  console.error(`sweep failed: ${String(e?.message ?? e)}`);
  process.exit(1);
});
