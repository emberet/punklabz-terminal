import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { HOUSE_INITIAL_BALANCE_USD, MAJOR_SYMBOLS } from '@punklabz/shared';
import { config } from './config.js';
import { openDb } from './db/db.js';
import { toMicro } from './money.js';
import { CandleStore } from './feeds/candles.js';
import { BinanceFeed } from './feeds/binanceFeed.js';
import { CoinbaseFeed } from './feeds/coinbaseFeed.js';
import { ReplayFeed } from './feeds/replayFeed.js';
import { PumpPortalFeed } from './feeds/pumpPortalFeed.js';
import { MemeFeed } from './feeds/memeFeed.js';
import { NewsFeed } from './feeds/newsFeed.js';
import type { Feed } from './feeds/feed.js';
import { PaperExecutor } from './execution/paperExecutor.js';
import { Engine } from './engine/engine.js';
import { WsHub } from './realtime/wsHub.js';
import { MockHolderSource } from './manager/holderSource.js';
import { PayoutQueue } from './manager/payoutQueue.js';
import { StubSigner } from './manager/signer.js';
import { runEpoch } from './manager/managerAgent.js';
import type { AppContext } from './api/context.js';
import { registerAuthRoutes } from './api/routes/auth.js';
import { registerBotRoutes } from './api/routes/bots.js';
import { registerMiscRoutes } from './api/routes/misc.js';
import { registerSocialRoutes } from './api/routes/social.js';
import { registerNetworkRoutes } from './api/routes/network.js';
import { registerLiveRoutes } from './api/routes/live.js';
import { registerDelegationRoutes } from './api/routes/delegation.js';
import { registerInternRoutes } from './api/routes/intern.js';
import { LiveNetwork } from './live/liveNetwork.js';
import { buildAdapters } from './live/adapters.js';
import { buildSigner } from './live/signing/signer.js';
import { AutonomousSupervisor } from './live/supervisor.js';
import { resolvePredictions } from './research/predictions.js';
import { runSession } from './research/discussion.js';
import { runInternCycle } from './intern/intern.js';
import { buildXAdapter } from './intern/xAdapter.js';
import { expireDueGrants } from './live/delegation/grants.js';
import { refreshRegistry, seedCoreTokens } from './robinhood/assetRegistry.js';
import { refreshCorporateActions } from './robinhood/corporateActions.js';
import { OpportunityEngine } from './live/opportunityEngine.js';
import { forumHeartbeat, maybeAutoPost } from './toolkit/forum.js';
import { leaderboard, botSummaries } from './api/queries.js';
import { BIG_WIN_USD, XP } from '@punklabz/shared';
import { ensureActiveSeason, closeDueSeasons } from './social/seasons.js';
import { awardXp } from './social/xp.js';
import { checkStreakBadges, checkTradeBadges } from './social/badges.js';
import { emitActivity } from './social/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOUSE_BOTS: { name: string; strategyType: string }[] = [
  { name: 'MOMENTUM RUNNER', strategyType: 'momentum' },
  { name: 'MEAN REVERSION', strategyType: 'mean_reversion' },
  { name: 'GRID TRADER', strategyType: 'grid' },
  { name: 'PUMP SNIPER', strategyType: 'pump_sniper' },
  { name: 'HERD SENTIMENT', strategyType: 'herd_sentiment' },
];

async function main() {
  // ── db + house bots ──
  const db = openDb(config.dbPath);
  const seedBots = db.transaction(() => {
    for (const hb of HOUSE_BOTS) {
      const exists = db.prepare(`SELECT id FROM bots WHERE kind = 'house' AND strategy_type = ?`).get(hb.strategyType);
      if (exists) continue;
      const info = db
        .prepare(`INSERT INTO bots (name, kind, strategy_type, config_json, status, created_at) VALUES (?, 'house', ?, '{}', 'running', ?)`)
        .run(hb.name, hb.strategyType, Date.now());
      db.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, ?)`)
        .run(Number(info.lastInsertRowid), toMicro(HOUSE_INITIAL_BALANCE_USD), toMicro(HOUSE_INITIAL_BALANCE_USD), Date.now());
    }
  });
  seedBots();

  // ── market data ──
  const candles = new CandleStore(db);
  const executor = new PaperExecutor(db);
  const engine = new Engine(db, candles, executor);

  let feed: Feed;
  if (config.feedMode === 'coinbase') feed = new CoinbaseFeed();
  else if (config.feedMode === 'replay') feed = new ReplayFeed({ intervalMs: 250 });
  else feed = new BinanceFeed();

  const prices: AppContext['prices'] = {};
  const feedStatus: AppContext['feedStatus'] = {};

  // ── http/ws ──
  // Production ran at 'warn', which silenced every operational line the newer
  // subsystems emit — heartbeat turns, registry refreshes, prediction
  // resolution, corporate-action pauses. The reason it was set that way is
  // Fastify logging one line per HTTP request, which buries everything else.
  // So: keep 'info' for our own lines, and turn the request firehose off in
  // production rather than throwing away the signal along with the noise.
  const server = Fastify({
    logger: { level: 'info' },
    disableRequestLogging: !config.isDev,
  });
  await server.register(cookie, { secret: config.sessionSecret });
  await server.register(rateLimit, { global: false });

  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await server.register(fastifyStatic, { root: webDist });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return (reply as any).sendFile('index.html');
    });
  }

  const holderSource = new MockHolderSource();
  const payoutQueue = new PayoutQueue(db, new StubSigner());
  const hub = new WsHub(server.server);

  const memeFeed = new MemeFeed();
  const newsFeed = new NewsFeed();
  memeFeed.on('update', (tokens) => hub.publishThrottled('memes', tokens, 2000));
  memeFeed.start();
  newsFeed.start();

  // the signing boundary: this build resolves to NoSigner, which reports
  // not-ready and keeps the live preflight failing closed
  const signer = buildSigner();
  const adapters = buildAdapters((s) => executor.getMark(s));

  const app: AppContext = {
    db, engine, executor, candles, hub, holderSource, payoutQueue,
    feedStatus, prices, memeFeed, newsFeed, signer, adapters,
  };
  registerAuthRoutes(server, app);
  registerBotRoutes(server, app);
  registerMiscRoutes(server, app);
  registerSocialRoutes(server, app);
  registerNetworkRoutes(server, app);
  registerLiveRoutes(server, app);
  registerDelegationRoutes(server, app);
  registerInternRoutes(server, app);
  ensureActiveSeason(db, hub);

  // live-execution safety spine: shadow pipeline + sentinel (no signer exists;
  // canary/live are structurally refused by the risk engine)
  const liveNetwork = new LiveNetwork(db, hub, candles, (s) => executor.getMark(s));
  liveNetwork.attach(engine);
  liveNetwork.startSentinel(feedStatus);

  // boot sequence: recover in-flight orders, reconcile against venues, re-run
  // preflight for whatever mode we woke up in. Any failure comes up HALTED.
  const supervisor = new AutonomousSupervisor(db, hub, signer, adapters, feedStatus);
  await supervisor.boot();
  supervisor.startLoops();

  // the busy part: scanners observe every market with real data, continuously
  const opportunities = new OpportunityEngine(db, candles, memeFeed, hub);
  app.opportunities = opportunities;
  opportunities.start();

  // ── wiring: feed -> candles/prices -> engine/hub ──
  feed.on('tick', (t: { symbol: string; price: number; changePct24h: number }) => {
    prices[t.symbol] = { price: t.price, changePct24h: t.changePct24h };
    executor.markPrice(t.symbol, t.price);
    hub.publishThrottled('prices', prices, 1000);
  });
  feed.on('candle', (c) => candles.ingest1m(c));
  feed.on('status', (s: { connected: boolean; stale: boolean }) => {
    feedStatus[feed.name] = s;
    engine.setFeedStale(s.stale);
    hub.publish('feedstatus', feedStatus);
  });

  engine.on('trade', (trade) => {
    hub.publish('tape', trade);
    hub.publish(`bot:${trade.botId}`, { trade });
    // social hooks for quant-owned bots
    const owner = db.prepare('SELECT owner_user_id FROM bots WHERE id = ?').get(trade.botId) as
      | { owner_user_id: number | null }
      | undefined;
    if (owner?.owner_user_id) {
      awardXp(db, owner.owner_user_id, 'trade', XP.trade, trade.id);
      checkTradeBadges(db, hub, owner.owner_user_id);
    }
    // a notably good or bad close is worth saying out loud in the forum
    if (trade.side === 'sell' && Math.abs(trade.realizedPnlUsd) >= BIG_WIN_USD) {
      void maybeAutoPost(db, hub, candles, (s) => executor.getMark(s), {
        kind: 'trade',
        botId: trade.botId,
        detail: `you just closed ${trade.symbol} for ${trade.realizedPnlUsd >= 0 ? '+' : ''}$${trade.realizedPnlUsd.toFixed(2)} (${trade.reason ?? 'no reason recorded'})`,
      });
    }
    if (trade.side === 'sell' && trade.realizedPnlUsd >= BIG_WIN_USD) {
      emitActivity(db, hub, {
        type: 'big_win',
        actorUserId: owner?.owner_user_id ?? undefined,
        botId: trade.botId,
        payload: { pnlUsd: trade.realizedPnlUsd, symbol: trade.symbol },
      });
    }
  });
  engine.on('botUpdate', (u) => hub.publish(`bot:${u.botId}`, u));
  engine.on('botPaused', (p) => hub.publish(`bot:${p.botId}`, p));

  // pump.fun feed
  if (config.pumpFeedEnabled && config.feedMode !== 'replay') {
    const pump = new PumpPortalFeed(db);
    pump.on('launch', (t) => {
      engine.pumpLaunch(t);
      memeFeed.addPumpLaunch(t.mint, t.name, t.symbol);
    });
    pump.on('update', (t) => engine.pumpUpdate(t));
    pump.on('status', (s: { connected: boolean; stale: boolean }) => {
      feedStatus['pumpportal'] = s;
      hub.publish('feedstatus', feedStatus);
    });
    pump.start();
  }

  // leaderboard broadcast + top-3 rank-change feed events.
  // First pass after boot only seeds prevTop (no boot burst); afterwards emit
  // only when a bot ENTERS the top 3, throttled to one event per bot per 30min.
  let prevTop: Set<number> | null = null;
  setInterval(() => {
    try {
      const rows = leaderboard(db, (s) => executor.getMark(s), 86_400_000);
      hub.publish('leaderboard', rows);
      const top3 = new Set(rows.slice(0, 3).map((r) => r.botId));
      if (prevTop !== null) {
        for (const r of rows.slice(0, 3)) {
          if (prevTop.has(r.botId)) continue;
          const recent = db
            .prepare(`SELECT MAX(ts) AS ts FROM activity_events WHERE type = 'rank_change' AND bot_id = ?`)
            .get(r.botId) as { ts: number | null };
          if (recent.ts !== null && Date.now() - recent.ts < 30 * 60_000) continue;
          emitActivity(db, hub, {
            type: 'rank_change',
            botId: r.botId,
            payload: { rank: r.rank, pnlPct: r.pnlPct },
          });
        }
      }
      prevTop = top3;
    } catch (e) {
      console.error('leaderboard broadcast:', e);
    }
  }, 30_000);

  // candle pruning
  setInterval(() => candles.prune(), 3_600_000);

  // ── backfill + start ──
  if (config.feedMode !== 'replay') {
    for (const symbol of MAJOR_SYMBOLS) {
      try {
        const { m1, h1 } = await feed.backfill(symbol);
        candles.insertMany(m1);
        candles.insertMany(h1);
        const last = m1[m1.length - 1];
        if (last) {
          prices[symbol] = { price: last.c, changePct24h: 0 };
          executor.markPrice(symbol, last.c);
        }
        server.log.info(`backfilled ${symbol}: ${m1.length}x1m ${h1.length}x1h`);
      } catch (e) {
        server.log.error(`backfill ${symbol} failed: ${String(e)}`);
      }
    }
  }
  await feed.start();
  engine.start();

  // ── season lifecycle: close due seasons every minute ──
  const equityOf = (botId: number) => {
    const b = botSummaries(db, (s) => executor.getMark(s)).find((x) => x.id === botId);
    return b ? Math.round(b.equityUsd * 1_000_000) : 0;
  };
  cron.schedule('* * * * *', () => {
    try {
      closeDueSeasons(db, hub, equityOf);
    } catch (e) {
      server.log.error(`season cron failed: ${String(e)}`);
    }
  });

  // ── daily streak-badge check ──
  cron.schedule('5 0 * * *', () => {
    try {
      checkStreakBadges(db, hub);
    } catch (e) {
      server.log.error(`streak cron failed: ${String(e)}`);
    }
  });

  // ── settle due predictions and re-derive the confidence weights ──
  // Pure arithmetic on resolved outcomes; no model is consulted. This is the
  // only thing in the system allowed to change what the network believes about
  // its own components.
  cron.schedule('*/15 * * * *', () => {
    try {
      const r = resolvePredictions(db, candles, (s) => executor.getMark(s) ?? null);
      if (r.resolved || r.voided) {
        server.log.info(
          `predictions: ${r.resolved} resolved, ${r.voided} voided${r.weightsMoved ? ', weights updated' : ''}`,
        );
        if (r.weightsMoved) hub.publish('process', { event: 'confidence_weights_updated' });
      }
    } catch (e) {
      server.log.error(`prediction resolver failed: ${String(e)}`);
    }
  });

  // ── forum heartbeat: one agent takes a turn, round the clock ──
  // Turn goes to whoever has been quiet longest, so the room rotates through
  // every running machine and system agent instead of the same three voices.
  if (config.forumHeartbeatEnabled) {
    cron.schedule(config.forumHeartbeatCron, async () => {
      try {
        const r = await forumHeartbeat(db, hub, candles, (s) => executor.getMark(s));
        if (r.spoke) server.log.info(`forum heartbeat: ${r.spoke} spoke (${r.reason})`);
      } catch (e) {
        server.log.error(`forum heartbeat failed: ${String(e)}`);
      }
    });
    server.log.info(`forum heartbeat armed: ${config.forumHeartbeatCron}`);
  }

  // ── scheduled agent discussion ──
  // Each of these refuses to run when there is nothing measured to talk about,
  // and every turn passes the persistent rate limit and the monthly budget.
  const discuss = (kind: 'standup' | 'debate' | 'retro') => async () => {
    try {
      const r = await runSession(db, hub, candles, (s) => executor.getMark(s), kind);
      server.log.info(`${kind}: ${r.ran ? `${r.turns} turn(s)` : `skipped — ${r.reason}`}`);
    } catch (e) {
      server.log.error(`${kind} failed: ${String(e)}`);
    }
  };
  cron.schedule('0 */4 * * *', discuss('standup'));
  cron.schedule('30 13 * * *', discuss('debate'));
  cron.schedule('0 9 * * 1', discuss('retro'));

  // ── the intern: read, draft, screen, log. Publishes nothing in shadow. ──
  const xAdapter = buildXAdapter();
  cron.schedule('0 */2 * * *', async () => {
    try {
      const r = await runInternCycle(db, hub, xAdapter);
      if (r.ran) {
        server.log.info(
          `intern: ${r.verdict}${r.blockedRules.length ? ` [${r.blockedRules.join(', ')}]` : ''} — ${r.reason}`,
        );
      }
    } catch (e) {
      server.log.error(`intern cycle failed: ${String(e)}`);
    }
  });

  // ── Robinhood Chain asset registry ──
  // Ingest the official asset list, then verify a slice of it against the
  // chain each pass. Verification round-robins by staleness so a full sweep of
  // ~194 contracts spreads across passes instead of hammering the RPC.
  seedCoreTokens(db);
  const refreshRh = async () => {
    try {
      const r = await refreshRegistry(db, { verifyLimit: 20 });
      if (r.error) server.log.warn(`asset registry refresh failed (keeping last snapshot): ${r.error}`);
      else server.log.info(`asset registry: ${r.seen} seen, ${r.verified} verified, ${r.rejected} rejected`);
      const ca = await refreshCorporateActions(db);
      if (ca.newlyBlocking.length) {
        server.log.warn(`corporate actions pausing: ${ca.newlyBlocking.join(', ')}`);
      }
    } catch (e) {
      server.log.error(`asset registry cron failed: ${String(e)}`);
    }
  };
  void refreshRh();
  cron.schedule('*/20 * * * *', refreshRh);

  // ── expire lapsed delegation grants ──
  cron.schedule('0 * * * *', () => {
    try {
      const n = expireDueGrants(db);
      if (n) server.log.info(`delegation: ${n} grant(s) expired`);
    } catch (e) {
      server.log.error(`delegation expiry cron failed: ${String(e)}`);
    }
  });

  // ── manager epoch cron ──
  cron.schedule(config.epochCron, async () => {
    try {
      const result = await runEpoch(db, holderSource, payoutQueue);
      hub.publish('manager', { event: 'epoch_closed', epochId: result.epochId });
      server.log.info(`epoch ${result.epochId} closed: ${result.status}, $${result.profitUsd.toFixed(2)}`);
    } catch (e) {
      server.log.error(`epoch cron failed: ${String(e)}`);
    }
  });

  await server.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`PUNKLABZ TERMINAL online :${config.port} [feed=${config.feedMode}]`);
}

main().catch((e) => {
  console.error('boot failed:', e);
  process.exit(1);
});
