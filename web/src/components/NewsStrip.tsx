import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface NewsItem {
  title: string;
  link: string;
  source: string;
  ts: number;
}

export function NewsStrip() {
  const [items, setItems] = useState<NewsItem[]>([]);

  useEffect(() => {
    const load = () =>
      api.get<{ items: NewsItem[] }>('/api/news').then((r) => setItems(r.items)).catch(() => {});
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  if (items.length === 0) return null;
  // duplicated content = seamless loop
  const strip = items.slice(0, 20);
  return (
    <div className="news-strip">
      <span className="news-label">WIRE</span>
      <div className="news-window">
        <div className="news-track">
          {[0, 1].map((dup) => (
            <span key={dup} className="news-run" aria-hidden={dup === 1}>
              {strip.map((n, i) => (
                <a key={`${dup}-${i}`} href={n.link} target="_blank" rel="noopener noreferrer">
                  <span className="news-src">{n.source}</span> {n.title}
                  <span className="news-dot"> ····· </span>
                </a>
              ))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
