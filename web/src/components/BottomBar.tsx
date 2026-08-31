import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useFx } from '../lib/fx';
import { loreLine } from '../lib/lore';

export function BottomBar() {
  const [ping, setPing] = useState<number | null>(null);
  const { mode, setMode } = useFx();

  useEffect(() => {
    const measure = async () => {
      const t0 = performance.now();
      try {
        await api.get('/api/healthz');
        setPing(Math.round(performance.now() - t0));
      } catch {
        setPing(null);
      }
    };
    void measure();
    const t = setInterval(measure, 30_000);
    return () => clearInterval(t);
  }, []);

  const cycleFx = () => {
    setMode(mode === 'full' ? 'reduced' : mode === 'reduced' ? 'off' : 'full');
  };

  return (
    <div className="bottombar">
      <span>PUNKLABZ://NODE42</span>
      <span>{ping === null ? <span className="red">LINK LOST</span> : <>PING {ping}MS</>}</span>
      <span className="on">WS CONNECTED</span>
      <span className="amber">SIMULATION MODE</span>
      <span>BUILD 0.6.6</span>
      <button onClick={cycleFx} title="visual effects: full / reduced / off">FX:{mode.toUpperCase()}</button>
      <span className="dim">CTRL+K TERMINAL</span>
      <span className="spacer" />
      <span className="lore">{loreLine()}</span>
    </div>
  );
}
