type Handler = (data: unknown) => void;

/** Auto-reconnecting /ws client with channel re-subscription. */
class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 0;

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const channel of this.handlers.keys()) {
        ws.send(JSON.stringify({ op: 'sub', channel }));
      }
    };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        this.handlers.get(frame.channel)?.forEach((h) => h(frame.data));
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  sub(channel: string, handler: Handler): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'sub', channel }));
      }
    }
    this.handlers.get(channel)!.add(handler);
    this.connect();
    return () => {
      const set = this.handlers.get(channel);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.handlers.delete(channel);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 'unsub', channel }));
        }
      }
    };
  }
}

export const wsClient = new WsClient();
