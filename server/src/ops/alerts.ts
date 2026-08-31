import { config } from '../config.js';

export function alertOperator(event: string, detail: string): void {
  if (!config.operatorAlertWebhook) return;
  void fetch(config.operatorAlertWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'punklabz', event, detail: detail.slice(0, 500), ts: Date.now() }),
    signal: AbortSignal.timeout(8_000),
  }).catch((error) => console.error(`operator alert failed (${event}):`, String(error).slice(0, 120)));
}
