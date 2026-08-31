import { useEffect, useRef, useState } from 'react';
import { useFx } from '../../lib/fx';

const NOISE = '#%$@?!/\\|<>+=~';

/**
 * Text decode-in: P%N#L4B? → PUNKLABZ. For headings and rare system messages,
 * never body text. Runs once per `text`; static in REDUCED/OFF.
 */
export function DecryptText({ text, duration = 450 }: { text: string; duration?: number }) {
  const { mode } = useFx();
  const [display, setDisplay] = useState(mode === 'full' ? '' : text);
  const raf = useRef<number>();

  useEffect(() => {
    if (mode !== 'full') {
      setDisplay(text);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const settled = Math.floor(t * text.length);
      let out = text.slice(0, settled);
      for (let i = settled; i < text.length; i++) {
        out += text[i] === ' ' ? ' ' : NOISE[Math.floor(Math.random() * NOISE.length)];
      }
      setDisplay(out);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [text, mode, duration]);

  return <span>{display}</span>;
}
