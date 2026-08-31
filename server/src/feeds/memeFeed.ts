import { EventEmitter } from 'node:events';

// Cross-chain memecoin radar. GeckoTerminal's free trending-pools endpoint
// covers every major chain in one call; pump.fun launches stream in separately
// via PumpPortalFeed and are merged by index.ts. No API key needed.

const TRENDING_URL = 'https://api.geckoterminal.com/api/v2/networks/trending_pools?include=base_token&page=1';
const POLL_MS = 60_000;

export interface MemeToken {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  change5m: number | null;
  change1h: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  mcapUsd: number | null;
  source: 'trending' | 'pump_launch';
  ts: number;
}

export class MemeFeed extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private trending: MemeToken[] = [];
  private launches: MemeToken[] = [];

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): MemeToken[] {
    // fresh pump launches first, then trending
    return [...this.launches, ...this.trending].slice(0, 40);
  }

  /** merge a pump.fun launch from PumpPortalFeed */
  addPumpLaunch(mint: string, name: string | null, symbol: string | null): void {
    this.launches.unshift({
      id: `sol:${mint}`,
      chain: 'solana',
      symbol: symbol ?? mint.slice(0, 6),
      name: name ?? 'pump.fun launch',
      priceUsd: null,
      change5m: null,
      change1h: null,
      change24h: null,
      volume24hUsd: null,
      mcapUsd: null,
      source: 'pump_launch',
      ts: Date.now(),
    });
    this.launches = this.launches.slice(0, 8);
    this.emit('update', this.snapshot());
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(TRENDING_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
      const body = (await res.json()) as any;
      const tokens = new Map<string, any>();
      for (const inc of body.included ?? []) {
        if (inc.type === 'token') tokens.set(inc.id, inc.attributes);
      }
      this.trending = (body.data ?? []).slice(0, 30).map((pool: any): MemeToken => {
        const a = pool.attributes ?? {};
        const baseId = pool.relationships?.base_token?.data?.id ?? '';
        const base = tokens.get(baseId) ?? {};
        const chain = String(baseId).split('_')[0] || String(pool.id ?? '').split('_')[0] || '?';
        const pct = (v: unknown) => (v === null || v === undefined ? null : Number(v));
        return {
          id: String(pool.id),
          chain,
          symbol: base.symbol ?? String(a.name ?? '?').split(' / ')[0],
          name: base.name ?? a.name ?? '?',
          priceUsd: a.base_token_price_usd ? Number(a.base_token_price_usd) : null,
          change5m: pct(a.price_change_percentage?.m5),
          change1h: pct(a.price_change_percentage?.h1),
          change24h: pct(a.price_change_percentage?.h24),
          volume24hUsd: a.volume_usd?.h24 ? Number(a.volume_usd.h24) : null,
          mcapUsd: a.market_cap_usd ? Number(a.market_cap_usd) : a.fdv_usd ? Number(a.fdv_usd) : null,
          source: 'trending',
          ts: Date.now(),
        };
      });
      this.emit('update', this.snapshot());
    } catch (e) {
      console.error('meme feed poll failed:', String(e).slice(0, 120));
    }
  }
}
