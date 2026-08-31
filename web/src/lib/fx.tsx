import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Visual-effects mode: FULL (everything) / REDUCED (functional motion only) /
// OFF (static). Persisted; initializes to REDUCED when the OS asks for
// reduced motion. Body classes let CSS gate every ambient effect.

export type FxMode = 'full' | 'reduced' | 'off';

const FxContext = createContext<{ mode: FxMode; setMode: (m: FxMode) => void }>({
  mode: 'full',
  setMode: () => {},
});

function initialMode(): FxMode {
  try {
    const saved = localStorage.getItem('plz.fxmode') as FxMode | null;
    if (saved === 'full' || saved === 'reduced' || saved === 'off') return saved;
  } catch { /* private mode */ }
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return 'reduced';
  }
  return 'full';
}

export function FxProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<FxMode>(initialMode);

  useEffect(() => {
    document.body.classList.remove('fx-full', 'fx-reduced', 'fx-off');
    document.body.classList.add(`fx-${mode}`);
  }, [mode]);

  // occasional hardware artifacts: CRT sync displacement + luminance variance.
  // FULL only; long random intervals; paused while tab hidden.
  useEffect(() => {
    if (mode !== 'full') return;
    let alive = true;
    const schedule = (fn: () => void, min: number, max: number) => {
      const tick = () => {
        if (!alive) return;
        if (!document.hidden) fn();
        setTimeout(tick, min + Math.random() * (max - min));
      };
      setTimeout(tick, min + Math.random() * (max - min));
    };
    schedule(() => {
      document.body.classList.add('crt-sync');
      setTimeout(() => document.body.classList.remove('crt-sync'), 180);
    }, 20_000, 60_000);
    schedule(() => {
      document.body.classList.add('crt-flicker');
      setTimeout(() => document.body.classList.remove('crt-flicker'), 80);
    }, 8_000, 30_000);
    return () => {
      alive = false;
    };
  }, [mode]);

  const setMode = (m: FxMode) => {
    setModeState(m);
    try {
      localStorage.setItem('plz.fxmode', m);
    } catch { /* private mode */ }
  };

  return <FxContext.Provider value={{ mode, setMode }}>{children}</FxContext.Provider>;
}

export function useFx() {
  return useContext(FxContext);
}
