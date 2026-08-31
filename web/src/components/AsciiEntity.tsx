import { useEffect, useRef } from 'react';
import { useFx } from '../lib/fx';

// THE MACHINE CORE — a procedural ASCII entity that breathes and tracks the
// pointer. Canvas, ~12 FPS on purpose (it should look computational), paused
// when the tab is hidden. Static single frame in REDUCED; hidden in OFF.

const CHARS = ' .:-=+*#%@';

export function AsciiEntity({ width = 40, height = 22, fontSize = 11 }: {
  width?: number; height?: number; fontSize?: number;
}) {
  const { mode } = useFx();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (mode === 'off') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cw = fontSize * 0.62;
    const ch = fontSize * 1.05;
    canvas.width = Math.ceil(width * cw);
    canvas.height = Math.ceil(height * ch);
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.current = {
        x: ((e.clientX - r.left) / r.width - 0.5) * 2,
        y: ((e.clientY - r.top) / r.height - 0.5) * 2,
      };
    };
    window.addEventListener('mousemove', onMove);

    let alive = true;
    let t = 0;

    const frame = () => {
      if (!alive) return;
      if (!document.hidden) {
        t += 1;
        ctx.fillStyle = '#050705';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const breathe = 1 + Math.sin(t / 9) * 0.04;
        const tiltX = pointer.current.x * 0.35;
        const tiltY = pointer.current.y * 0.25;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            // head-ish ellipsoid brightness field with noise + eye sockets
            const nx = ((x / width) * 2 - 1 - tiltX * 0.2) / (0.72 * breathe);
            const ny = ((y / height) * 2 - 1 - tiltY * 0.15) / (0.95 * breathe);
            const d = nx * nx + ny * ny;
            let b = Math.max(0, 1 - d); // core body
            // eye sockets
            const eye = (ex: number) => {
              const dx = nx - ex - tiltX * 0.3;
              const dy = ny + 0.25 - tiltY * 0.2;
              return Math.max(0, 0.16 - (dx * dx + dy * dy) * 3.2);
            };
            b -= eye(-0.38) + eye(0.38);
            // jaw shadow
            if (ny > 0.45) b *= 0.55;
            // scan noise
            b += (Math.sin(x * 3.7 + t / 2.4) * Math.sin(y * 2.9 - t / 3.1)) * 0.06;
            // occasional corruption band
            if (t % 97 < 3 && Math.abs(y - ((t * 3) % height)) < 1) b = Math.random();
            const idx = Math.max(0, Math.min(CHARS.length - 1, Math.floor(b * CHARS.length)));
            const chr = CHARS[idx];
            if (chr !== ' ') {
              ctx.fillStyle = idx > 6 ? '#55ff55' : idx > 3 ? '#2f8f38' : '#174d20';
              ctx.fillText(chr, x * cw, (y + 1) * ch);
            }
          }
        }
      }
      if (mode === 'full') setTimeout(() => requestAnimationFrame(frame), 83); // ~12 FPS
    };
    frame();

    return () => {
      alive = false;
      window.removeEventListener('mousemove', onMove);
    };
  }, [mode, width, height, fontSize]);

  if (mode === 'off') return null;
  return <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '100%' }} aria-hidden />;
}
