// Procedural glyph mosaic texture (Y2K flourish, per design handoff).
// Deterministic per seed so a given page keeps its pattern.

const GLYPHS = ['◎', '✕', '▣', '+', '□', '◉', '╳', '×', ' ', ' '];

export function glyphs(rows: number, cols: number, seed: number): string {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) line += GLYPHS[Math.floor(next() * GLYPHS.length)];
    lines.push(line);
  }
  return lines.join('\n');
}
