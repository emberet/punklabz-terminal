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
import { leaderboard } from './api/queries.js';

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
  const server = Fastify({ logger: { level: config.isDev ? 'info' : 'warn' } });
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

  const app: AppContext = { db, engine, executor, candles, hub, holderSource, payoutQueue, feedStatus, prices };
  registerAuthRoutes(server, app);
  registerBotRoutes(server, app);
  registerMiscRoutes(server, app);

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
  });
  engine.on('botUpdate', (u) => hub.publish(`bot:${u.botId}`, u));
  engine.on('botPaused', (p) => hub.publish(`bot:${p.botId}`, p));

  // pump.fun feed
  if (config.pumpFeedEnabled && config.feedMode !== 'replay') {
    const pump = new PumpPortalFeed(db);
    pump.on('launch', (t) => engine.pumpLaunch(t));
    pump.on('update', (t) => engine.pumpUpdate(t));
    pump.on('status', (s: { connected: boolean; stale: boolean }) => {
      feedStatus['pumpportal'] = s;
      hub.publish('feedstatus', feedStatus);
    });
    pump.start();
  }

  // leaderboard broadcast
  setInterval(() => {
    try {
      hub.publish('leaderboard', leaderboard(db, (s) => executor.getMark(s), 86_400_000));
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
