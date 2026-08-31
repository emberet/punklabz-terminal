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
  /**
   * THE OPERATOR WALLET. Exactly one address may reach the Control Room, and
   * admin is derived from a signature proving control of it — never from a
   * database column, an email address, or anything a request can assert.
   * Stored lowercase; every comparison is lowercase.
   */
  adminWallet: (process.env.ADMIN_WALLET ?? '0xfB047FE60FFac1D1A840a6f8C518C28A5f280d23').toLowerCase(),
  // relative DB paths resolve against the repo root, not the workspace cwd
  dbPath: path.resolve(__dirname, '../../', process.env.DB_PATH ?? './data/punklabz.db'),
  autoApproveCapUsd: Number(process.env.AUTO_APPROVE_CAP_USD ?? 500),
  epochCron: process.env.EPOCH_CRON ?? '0 0 * * *',
  /** hard monthly ceiling on every model call the network makes, measured not estimated */
  llmBudgetUsd: Number(process.env.LLM_BUDGET_USD ?? 25),
  /**
   * The forum heartbeat: one agent takes a turn on this schedule, around the
   * clock. At 5 minutes that is 288 posts a day — a MEASURED ~$0.32/day,
   * ~$9.50/month at Haiku pricing, and still subject to llmBudgetUsd.
   */
  forumHeartbeatEnabled: (process.env.FORUM_HEARTBEAT ?? 'true') === 'true',
  forumHeartbeatCron: process.env.FORUM_HEARTBEAT_CRON ?? '*/5 * * * *',
  isDev: process.env.NODE_ENV !== 'production',
};
