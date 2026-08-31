import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// load .env from the repo root regardless of cwd (npm workspace scripts run
// with cwd=server/), then let a cwd-local .env override for ad-hoc runs
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4700),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-do-not-use-in-prod',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  feedMode: (process.env.FEED_MODE ?? 'binance') as 'binance' | 'coinbase' | 'replay',
  pumpFeedEnabled: (process.env.PUMP_FEED_ENABLED ?? 'true') === 'true',
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // relative DB paths resolve against the repo root, not the workspace cwd
  dbPath: path.resolve(__dirname, '../../', process.env.DB_PATH ?? './data/punklabz.db'),
  autoApproveCapUsd: Number(process.env.AUTO_APPROVE_CAP_USD ?? 500),
  epochCron: process.env.EPOCH_CRON ?? '0 0 * * *',
  isDev: process.env.NODE_ENV !== 'production',
};
