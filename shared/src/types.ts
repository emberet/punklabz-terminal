import type { Interval } from './constants.js';

export interface Candle {
  symbol: string;
  interval: Interval;
  ts: number; // open time, ms epoch
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type BotKind = 'house' | 'quant';
export type BotStatus = 'running' | 'stopped' | 'paused';

export interface BotSummary {
  id: number;
  name: string;
  kind: BotKind;
  strategyType: string;
  status: BotStatus;
  ownerName: string | null;
  equityUsd: number;
  cashUsd: number;
  initialBalanceUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  pnlPct24h: number;
  tradeCount: number;
  winCount: number;
  clonedFromBotId: number | null;
  createdAt: number;
}

export interface PositionView {
  id: number;
  botId: number;
  symbol: string;
  qty: number;
  avgEntry: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  openedAt: number;
}

export interface TradeView {
  id: number;
  botId: number;
  botName?: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  feeUsd: number;
  realizedPnlUsd: number;
  ts: number;
}

export interface LeaderboardRow {
  rank: number;
  botId: number;
  name: string;
  kind: BotKind;
  ownerName: string | null;
  pnlPct: number;
  pnlUsd: number;
  winRate: number;
  tradeCount: number;
  maxDrawdownPct: number;
  ageDays: number;
}

export interface EpochView {
  id: number;
  periodStart: number;
  periodEnd: number;
  totalProfitUsd: number;
  eligibleSupply: number;
  eligibleHolders: number;
  status: 'computed' | 'needs_review' | 'approved' | 'distributing' | 'done';
  claudeSummary: string | null;
  anomalies: string[] | null;
  createdAt: number;
}

export interface PayoutItemView {
  id: number;
  address: string;
  balance: number;
  amountUsd: number;
  status: 'queued' | 'signed' | 'sent' | 'failed';
  txSig: string | null;
}

export interface LedgerEntryView {
  id: number;
  ts: number;
  type: 'seed' | 'fee_creation' | 'fee_reuse' | 'fee_trade_tax';
  amountUsd: number;
  debitAccount: string;
  creditAccount: string;
  memo: string;
}

// ── WebSocket frames ─────────────────────────────────────────────────────────
export type WsClientFrame = { op: 'sub' | 'unsub'; channel: string };

export type WsServerFrame =
  | { channel: 'prices'; data: Record<string, { price: number; changePct24h: number }> }
  | { channel: 'feedstatus'; data: Record<string, { connected: boolean; stale: boolean }> }
  | { channel: 'tape'; data: TradeView }
  | { channel: `bot:${number}`; data: { equityUsd: number; trade?: TradeView } }
  | { channel: 'leaderboard'; data: LeaderboardRow[] }
  | { channel: 'manager'; data: { event: string; epochId: number } };
