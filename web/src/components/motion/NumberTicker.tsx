import { useEffect, useRef, useState } from 'react';
import { useFx } from '../../lib/fx';

/**
 * Mechanical count to a new value on change (~400ms, stepped — no easing
 * butter). OFF mode renders plain. Formats via the supplied formatter.
 */
export function NumberTicker({
  value,
  format = (n: number) => n.toLocaleString('en-US'),
  duration = 400,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
}) {
  const { mode } = useFx();
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const raf = useRef<number>();

  useEffect(() => {
    if (mode === 'off' || prev.current === value) {
      prev.current = value;
      setDisplay(value);
      return;
    }
    const from = prev.current;
    prev.current = value;
    const start = performance.now();
    const steps = 8;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const stepped = Math.round(t * steps) / steps;
      setDisplay(from + (value - from) * stepped);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, mode, duration]);

  return <span>{format(display)}</span>;
}
