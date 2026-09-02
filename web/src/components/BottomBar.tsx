import { useEffect, useState } from 'react';
import type { LiveStatusView } from '@punklabz/shared';
import { api } from '../lib/api';
import { useFx } from '../lib/fx';
import { loreLine } from '../lib/lore';
import { wsClient } from '../lib/ws';

export function BottomBar() {
  const [ping, setPing] = useState<number | null>(null);
  const [execution, setExecution] = useState<LiveStatusView | null>(null);
  const { mode, setMode } = useFx();

  useEffect(() => {
    const load = async () => {
      const t0 = performance.now();
      try {
        const [, status] = await Promise.all([
          api.get('/api/healthz'),
          api.get<LiveStatusView>('/api/live/status'),
        ]);
        setPing(Math.round(performance.now() - t0));
        setExecution(status);
      } catch {
        setPing(null);
      }
    };
    void load();
    const unsubscribe = wsClient.sub('live', () => void load());
    const t = setInterval(load, 30_000);
    return () => {
      unsubscribe();
      clearInterval(t);
    };
  }, []);

  const cycleFx = () => {
    setMode(mode === 'full' ? 'reduced' : mode === 'reduced' ? 'off' : 'full');
  };

  const executionLabel = !execution
    ? 'EXEC STATUS UNKNOWN'
    : execution.halted
      ? 'MAINNET HALTED'
      : execution.phase === 'canary_probe'
        ? `MAINNET CANARY PROBE · ${execution.chainId}`
        : execution.phase === 'canary_exit_recovery'
          ? `MAINNET EXIT RECOVERY · ${execution.chainId}`
        : execution.phase === 'autonomous_canary'
          ? `MAINNET CANARY · ${execution.chainId}`
          : execution.mode === 'live'
            ? `MAINNET LIVE · ${execution.chainId}`
            : execution.mode === 'shadow'
              ? 'SHADOW MODE'
              : 'SIMULATION MODE';
  const executionClass = execution?.halted
    ? 'red'
    : execution?.mode === 'canary' || execution?.mode === 'live'
      ? 'on'
      : 'amber';

  return (
    <div className="bottombar">
      <span>PUNKLABZ://NODE42</span>
      <span>{ping === null ? <span className="red">LINK LOST</span> : <>PING {ping}MS</>}</span>
      <span className="on">WS CONNECTED</span>
      <span className={executionClass}>{executionLabel}</span>
      <span>BUILD 0.6.6</span>
      <button onClick={cycleFx} title="visual effects: full / reduced / off">FX:{mode.toUpperCase()}</button>
      <span className="dim">CTRL+K TERMINAL</span>
      <span className="spacer" />
      <span className="lore">{loreLine()}</span>
    </div>
  );
}
