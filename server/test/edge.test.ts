import { describe, expect, it } from 'vitest';
import { COST_MODEL, edgeForUniverse, edgeLines, estimateEdge } from '../src/live/edge.js';
import { openTestDb } from '../src/db/db.js';
import { evaluateIntent, setLiveMode, updateLimits } from '../src/live/riskEngine.js';

describe('net edge accounting', () => {
  it('net edge = gross − fees − slippage − buffer', () => {
    const e = estimateEdge({ atrPct: 1, captureRatio: 0.5, feeBps: 20, slippageBps: 10, bufferBps: 10 });
    expect(e.grossEdgeBps).toBe(50); // 1% ATR × 0.5 = 0.5% = 50bps
    expect(e.netEdgeBps).toBe(10);
    expect(e.viable).toBe(true);
    expect(e.edgeModel).toBe('atr_excursion_0.5x');
  });

  it('a thin edge that cannot pay its costs is not viable', () => {
    const e = edgeForUniverse('majors', 0.5, 0.5); // 25bps gross vs 40bps costs
    expect(e.grossEdgeBps).toBe(25);
    expect(e.netEdgeBps).toBeLessThan(0);
    expect(e.viable).toBe(false);
  });

  it('pump.fun costs are brutal — needs a huge move to clear', () => {
    const costs = COST_MODEL.pumpfun;
    const total = costs.feeBps + costs.slippageBps + costs.bufferBps;
    expect(total).toBe(600); // 6% round trip
    expect(edgeForUniverse('pumpfun', 5, 0.5).viable).toBe(false); // 2.5% move loses
    expect(edgeForUniverse('pumpfun', 20, 0.5).viable).toBe(true); // 10% move clears
  });

  it('renders the rejection block the terminal shows', () => {
    const lines = edgeLines(edgeForUniverse('majors', 0.62, 0.5));
    expect(lines[0]).toMatch(/EXPECTED EDGE\s+\+0\.31%/);
    expect(lines[4]).toMatch(/NET EDGE\s+−0\.09%/);
  });

  it('the risk engine rejects on net edge even at max confidence', () => {
    const db = openTestDb();
    db.prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('e@x.com','e',1)`).run();
    db.prepare(`INSERT INTO bots (name, kind, strategy_type, config_json, created_at) VALUES ('T','house','momentum','{}',1)`).run();
    setLiveMode(db, 'shadow', 'test');
    db.prepare(`UPDATE live_config SET capital_stage=1 WHERE id=1`).run();
    updateLimits(db, { maxPerTradePct: 10, minCashReservePct: 10 }, 'test');

    const intent = {
      intentId: 'edge_test', botId: 1, instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
      venue: 'paper', side: 'buy' as const, notionalUsd: 0.6, confidence: 100, reason: 'test',
    };
    const thin = edgeForUniverse('majors', 0.3, 0.5); // negative net
    const d1 = evaluateIntent(db, intent, thin);
    expect(d1.approved).toBe(false);
    expect(d1.checks.find((c) => c.name === 'net_edge')?.pass).toBe(false);
    expect(d1.rejectionReason).toContain('net_edge');

    const fat = edgeForUniverse('majors', 2, 0.5); // 100bps gross vs 40bps costs
    const d2 = evaluateIntent(db, { ...intent, intentId: 'edge_test2' }, fat);
    expect(d2.approved).toBe(true);
    expect(d2.checks.find((c) => c.name === 'net_edge')?.pass).toBe(true);
  });
});
