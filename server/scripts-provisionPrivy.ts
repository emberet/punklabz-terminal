// Entry point for provisioning the Privy wallet's owner and policy.
// Run on the server, where the credentials already live:
//   cd /opt/punklabz && npx tsx server/scripts-provisionPrivy.ts [--dry-run]
import './src/config.js';
import { provisionPrivyWallet } from './src/live/signing/provisionPrivy.js';

const dryRun = process.argv.includes('--dry-run');
const capUsd = Number(process.env.PRIVY_POLICY_CAP_USD ?? 25);

provisionPrivyWallet({
  ctx: {
    appId: process.env.PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
    walletId: process.env.PRIVY_WALLET_ID!,
    authorizationKey: process.env.PRIVY_AUTHORIZATION_KEY,
  },
  capUsd,
  chainId: Number(process.env.PRIMARY_CHAIN_ID ?? 4663),
  dryRun,
})
  .then((r) => {
    console.log('\nresult:', r.ok ? 'PROVISIONED' : 'NOT PROVISIONED');
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => { console.error('FAILED:', e); process.exit(1); });
