import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { ROBINHOOD_MAINNET_CHAIN_ID } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { getLiveConfig } from '../../live/riskEngine.js';

// DEPLOYMENT IDENTITY.
//
// "Which commit is controlling the money?" must have an answer that does not
// depend on trusting anyone's memory. Without this, a repo and a running
// server can drift apart silently — and an audit of the source tells you
// nothing about the process holding the wallet.
//
// build-info.json is written by deploy.sh at deploy time from the actual
// checkout being shipped. It is gitignored on purpose: it describes a
// deployment, not a revision, and committing it would make it a lie the moment
// anyone edited a file.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildInfo {
  commit: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
  builtBy: string;
}

let cached: BuildInfo | null | undefined;

export function buildInfo(): BuildInfo | null {
  if (cached !== undefined) return cached;
  for (const candidate of [
    path.resolve(__dirname, '../../../../build-info.json'),
    path.resolve(process.cwd(), 'build-info.json'),
  ]) {
    try {
      cached = JSON.parse(fs.readFileSync(candidate, 'utf8')) as BuildInfo;
      return cached;
    } catch { /* try the next location */ }
  }
  cached = null;
  return cached;
}

export function registerVersionRoutes(server: FastifyInstance, app: AppContext) {
  /**
   * Public and unauthenticated on purpose. Anyone auditing this deployment —
   * including someone deciding whether to trust it with funds — should be able
   * to pin the exact revision without credentials. It exposes no secret: a
   * commit hash, a mode, and a public address.
   */
  server.get('/api/version', async () => {
    const build = buildInfo();
    const cfg = getLiveConfig(app.db);
    const migrations = app.db
      .prepare(`SELECT COUNT(*) n, MAX(name) latest FROM _migrations`)
      .get() as { n: number; latest: string };
    const signerAddress = await app.signer.getAddress().catch(() => null);

    return {
      app: 'punklabz',
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      commit: build?.commit ?? 'unknown',
      branch: build?.branch ?? 'unknown',
      // a deploy from a tree with uncommitted edits is NOT reproducible, and
      // that is worth saying out loud rather than hiding
      dirty: build?.dirty ?? null,
      builtAt: build?.builtAt ?? null,
      migrations: { applied: migrations.n, latest: migrations.latest },

      // what this process is actually doing with money right now
      execution: {
        mode: cfg.mode,
        halted: cfg.halted,
        capitalStage: cfg.capitalStage,
        network: 'robinhood',
        chainId: ROBINHOOD_MAINNET_CHAIN_ID,
        signerKind: app.signer.kind,
        walletAddress: signerAddress,
      },
    };
  });
}
