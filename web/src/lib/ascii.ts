// Machine identity: procedural IDs, ASCII avatars, ASCII sparklines.

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

export function asciiSpark(values: number[], width = 12): string {
  if (values.length < 2) return '▁'.repeat(width);
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) sampled.push(values[i]);
  if (sampled[sampled.length - 1] !== values[values.length - 1]) sampled.push(values[values.length - 1]);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;
  return sampled
    .slice(-width)
    .map((v) => SPARK_CHARS[Math.round(((v - min) / range) * 7)])
    .join('');
}

/** deterministic machine id: PLZ-XX-NNNN */
export function machineId(botId: number, name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const letters = 'KXNVZRGWQD';
  const a = letters[h % letters.length];
  const b = letters[(h >>> 4) % letters.length];
  return `PLZ-${a}${b}-${String(1000 + ((botId * 271 + (h % 997)) % 9000))}`;
}

/** tiny deterministic 1-line glyph face per machine */
const AVATAR_PARTS = [
  ['[', '{', '(', '<', '|', '⌈'],
  ['◉', '◎', '□', '▣', '✕', '●', '◇', '¤'],
  ['_', '‗', '=', '~', '-', '∙'],
  ['◉', '◎', '□', '▣', '✕', '●', '◇', '¤'],
  [']', '}', ')', '>', '|', '⌉'],
];

export function machineAvatar(botId: number, name: string): string {
  let h = botId * 2654435761;
  for (const ch of name) h = ((h ^ ch.charCodeAt(0)) * 16777619) >>> 0;
  return AVATAR_PARTS.map((part, i) => part[(h >>> (i * 5)) % part.length]).join('');
}

export const CLASS_LABELS: Record<string, string> = {
  momentum: 'momentum predator',
  mean_reversion: 'panic feeder',
  grid: 'range harvester',
  pump_sniper: 'launch striker',
  herd_sentiment: 'crowd parasite',
  dsl: 'custom organism',
};

export const HOUSE_TAGLINES: Record<string, string> = {
  momentum: 'hunts momentum while everyone sleeps',
  mean_reversion: 'everything returns eventually',
  grid: 'does not predict. only reacts.',
  pump_sniper: 'rare entries. violent exits.',
  herd_sentiment: 'the crowd is a signal, not a friend',
};
