// Entry point for provisioning the Privy wallet's owner and policy.
// Run on the server, where the credentials already live:
//   cd /opt/punklabz && npx tsx server/scripts-provisionPrivy.ts [--dry-run]
import fs from 'node:fs';
import './src/config.js';
import { provisionPrivyWallet } from './src/live/signing/provisionPrivy.js';

const dryRun = process.argv.includes('--dry-run');
const capUsd = Number(process.env.PRIVY_POLICY_CAP_USD ?? 25);
const authorizationKey = process.env.PRIVY_AUTHORIZATION_KEY_FILE
  ? fs.readFileSync(process.env.PRIVY_AUTHORIZATION_KEY_FILE, 'utf8').trim()
  : process.env.PRIVY_AUTHORIZATION_KEY;

provisionPrivyWallet({
  ctx: {
    appId: process.env.PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
    walletId: process.env.PRIVY_WALLET_ID!,
    authorizationKey,
  },
  capUsd,
  chainId: Number(process.env.PRIMARY_CHAIN_ID ?? 4663),
  dryRun,
})
  .then((r) => {
    console.log('\nresult:', r.ok ? 'PROVISIONED' : 'NOT PROVISIONED');
    if (r.policyId) console.log('policy id:', r.policyId);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => { console.error('FAILED:', e); process.exit(1); });
