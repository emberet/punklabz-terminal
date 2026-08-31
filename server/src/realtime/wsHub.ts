import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * One /ws endpoint, channel-based pub/sub. Clients send {op:'sub'|'unsub', channel}.
 * publish() fans out to subscribers; throttled channels coalesce to the latest
 * payload flushed on an interval.
 */
export class WsHub {
  private wss: WebSocketServer;
  private subs = new Map<WebSocket, Set<string>>();
  private throttled = new Map<string, { latest: unknown; timer: NodeJS.Timeout | null; intervalMs: number }>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      this.subs.set(ws, new Set());
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const channels = this.subs.get(ws);
          if (!channels || typeof msg.channel !== 'string' || msg.channel.length > 64) return;
          if (msg.op === 'sub') channels.add(msg.channel);
          else if (msg.op === 'unsub') channels.delete(msg.channel);
        } catch {
          // ignore
        }
      });
      ws.on('close', () => this.subs.delete(ws));
      ws.on('error', () => this.subs.delete(ws));
    });
  }

  /** immediate fan-out */
  publish(channel: string, data: unknown): void {
    // The socket is unauthenticated. Never publish live-execution timing or
    // payloads here; public/admin screens poll their appropriately scoped HTTP
    // endpoints instead. This also prevents a generic refresh pulse from
    // becoming a side channel for the exact moment an order was broadcast.
    if (channel === 'live') return;
    const frame = JSON.stringify({ channel, data });
    for (const [ws, channels] of this.subs) {
      if (channels.has(channel) && ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  /** coalesced fan-out: at most one frame per intervalMs, latest wins */
  publishThrottled(channel: string, data: unknown, intervalMs = 1000): void {
    let t = this.throttled.get(channel);
    if (!t) {
      t = { latest: data, timer: null, intervalMs };
      this.throttled.set(channel, t);
    }
    t.latest = data;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        const entry = this.throttled.get(channel);
        if (entry) {
          this.publish(channel, entry.latest);
          entry.timer = null;
        }
      }, intervalMs);
    }
  }

  close(): void {
    this.wss.close();
  }
}
