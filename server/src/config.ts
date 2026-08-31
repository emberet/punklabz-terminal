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
  adminWallet: (process.env.ADMIN_WALLET ?? '').toLowerCase(),
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
  /**
   * How long the demo runs before the room goes quiet. The window opens on the
   * first tick and its start is persisted, so restarts do not extend it.
   * 0 or negative means no window — run indefinitely.
   */
  forumHeartbeatHours: Number(process.env.FORUM_HEARTBEAT_HOURS ?? 24),
  isDev: process.env.NODE_ENV !== 'production',
  // The legacy payout source is the paper `trades` table. It is a demo-only
  // economy and can never be enabled in production by an environment toggle.
  payoutsEnabled: process.env.NODE_ENV !== 'production' && (process.env.PAYOUTS_ENABLED ?? 'true') === 'true',
  operatorAlertWebhook: process.env.OPERATOR_ALERT_WEBHOOK_URL ?? '',
};

if (!config.isDev && !config.adminWallet) {
  throw new Error('ADMIN_WALLET is required in production; there is no fallback operator address');
}
if (!config.isDev && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}
