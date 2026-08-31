import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useFx } from '../../lib/fx';

const MODULE_NAMES: Record<string, string> = {
  '/': 'ARENA',
  '/build': 'LAB',
  '/my-bots': 'BOTNET',
  '/explore': 'BLACK_MARKET',
  '/signals': 'SIGNALS',
  '/leaderboard': 'RANKS',
  '/feed': 'WIRE',
  '/learn': 'ARCHIVE',
  '/control-room': 'CONTROL_ROOM',
};

/**
 * Page changes read as computer state changes: a ~280ms ACCESSING MODULE strip,
 * FULL mode only. Never blocks interaction with the incoming page.
 */
export function ModuleTransition() {
  const { mode } = useFx();
  const location = useLocation();
  const [label, setLabel] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (mode !== 'full') return;
    const name =
      MODULE_NAMES[location.pathname] ??
      (location.pathname.startsWith('/bots/') ? 'MACHINE_DOSSIER'
        : location.pathname.startsWith('/u/') ? 'OPERATOR'
        : null);
    if (!name) return;
    setLabel(name);
    const t = setTimeout(() => setLabel(null), 280);
    return () => clearTimeout(t);
  }, [location.pathname, mode]);

  if (!label) return null;
  return (
    <div className="module-transition" aria-hidden>
      <span>{label}/ ACCESSING MODULE… ██████████</span>
    </div>
  );
}
