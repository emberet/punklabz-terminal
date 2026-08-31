import { EventEmitter } from 'node:events';

// Crypto headlines from public RSS feeds — no keys, polled every 5 minutes.
// Titles only; regex parse keeps us dependency-free.

const SOURCES = [
  { name: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'decrypt', url: 'https://decrypt.co/feed' },
];
const POLL_MS = 5 * 60_000;

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  ts: number;
}

export class NewsFeed extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private items: NewsItem[] = [];

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): NewsItem[] {
    return this.items;
  }

  private async poll(): Promise<void> {
    const all: NewsItem[] = [];
    for (const src of SOURCES) {
      try {
        const res = await fetch(src.url, {
          headers: { 'user-agent': 'punklabz-terminal/1.0', accept: 'application/rss+xml, application/xml, text/xml' },
        });
        if (!res.ok) continue;
        const xml = await res.text();
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const item = m[1];
          const title = decode(pick(item, 'title'));
          const link = pick(item, 'link');
          const pub = pick(item, 'pubDate');
          if (!title || !link) continue;
          all.push({
            title: title.slice(0, 160),
            link,
            source: src.name,
            ts: pub ? Date.parse(pub) || Date.now() : Date.now(),
          });
          if (all.filter((i) => i.source === src.name).length >= 12) break;
        }
      } catch (e) {
        console.error(`news poll ${src.name} failed:`, String(e).slice(0, 100));
      }
    }
    if (all.length) {
      const seen = new Set<string>();
      this.items = all
        .sort((a, b) => b.ts - a.ts)
        .filter((i) => {
          const k = i.title.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 30);
      this.emit('update', this.items);
    }
  }
}

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
