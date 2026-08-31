import { MAJOR_SYMBOLS, type Instrument } from '@punklabz/shared';

// Instrument registry. Crypto spot on the paper venue is tradable in shadow
// (we have real market data). Other asset classes are registered for the
// unified model but marked non-tradable — no faked data, no execution path.

const registry: Instrument[] = [];

for (const sym of MAJOR_SYMBOLS) {
  const base = sym.replace('USDT', '');
  registry.push({
    id: `CRYPTO_SPOT://binance/${sym}`,
    symbol: sym,
    displayName: `${base}/USDT`,
    assetClass: 'CRYPTO_SPOT',
    venue: 'paper',
    network: null,
    baseAsset: base,
    quoteAsset: 'USDT',
    settlementAsset: 'USDC',
    minNotionalUsd: 1,
    leverageAllowed: 1,
    tradable: true,
  });
}

// registered-but-not-tradable examples across classes — the model is real,
// the execution path is not wired (Sprints 4+ / operator config).
const stubs: Omit<Instrument, 'settlementAsset' | 'minNotionalUsd' | 'leverageAllowed' | 'tradable'>[] = [
  { id: 'CRYPTO_SPOT://base/ETH-USDC', symbol: 'ETH-USDC', displayName: 'ETH/USDC', assetClass: 'CRYPTO_SPOT', venue: 'evm:base', network: 'base', baseAsset: 'ETH', quoteAsset: 'USDC' },
  { id: 'CRYPTO_SPOT://solana/SOL-USDC', symbol: 'SOL-USDC', displayName: 'SOL/USDC', assetClass: 'CRYPTO_SPOT', venue: 'solana', network: 'solana', baseAsset: 'SOL', quoteAsset: 'USDC' },
  { id: 'STOCK://broker/SPY', symbol: 'SPY', displayName: 'SPY (S&P 500 ETF)', assetClass: 'ETF', venue: 'broker', network: null, baseAsset: 'SPY', quoteAsset: 'USD' },
  { id: 'FOREX://broker/EURUSD', symbol: 'EURUSD', displayName: 'EUR/USD', assetClass: 'FOREX', venue: 'broker', network: null, baseAsset: 'EUR', quoteAsset: 'USD' },
  { id: 'PREDICTION://polymarket/BTC-150K-2026/YES', symbol: 'BTC>150K-2026', displayName: 'BTC > $150K by 2026 (YES)', assetClass: 'PREDICTION', venue: 'polymarket', network: 'polygon', baseAsset: 'YES', quoteAsset: 'USDC' },
];
for (const s of stubs) {
  registry.push({
    ...s,
    settlementAsset: s.quoteAsset,
    minNotionalUsd: 1,
    leverageAllowed: 1,
    tradable: false,
    note: 'venue adapter not configured in this build',
  });
}

export function allInstruments(): Instrument[] {
  return registry;
}

export function findInstrument(id: string): Instrument | undefined {
  return registry.find((i) => i.id === id);
}

export function searchInstruments(q: string): Instrument[] {
  const s = q.trim().toUpperCase();
  if (!s) return registry.slice(0, 20);
  return registry.filter(
    (i) => i.symbol.toUpperCase().includes(s) || i.displayName.toUpperCase().includes(s) || i.assetClass.includes(s),
  );
}

/** map a crypto-spot instrument to the engine's mark symbol */
export function markSymbolFor(inst: Instrument): string | null {
  return inst.assetClass === 'CRYPTO_SPOT' && inst.venue === 'paper' ? inst.symbol : null;
}
