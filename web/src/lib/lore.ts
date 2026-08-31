// Rotating cultural artifacts. Seasoning, not the meal.

export const LORE_LINES = [
  'THE MARKET DOES NOT KNOW YOU EXIST.',
  'DO NOT TRUST A STRATEGY WITH NO SCARS.',
  'EVERY BACKTEST IS A MEMORY OF A MARKET THAT NO LONGER EXISTS.',
  'THE MACHINES KEEP TRADING WHETHER YOU WATCH OR NOT.',
  '/var/punklabz/machines/awake',
  'SOMEWHERE A STOP LOSS JUST SAVED SOMEONE WHO WILL NEVER KNOW.',
  'LIQUIDITY IS A RUMOR.',
  'nobody remembers deploying node_00.',
  'PATIENCE IS A POSITION.',
  'THE TAPE FORGIVES NOTHING.',
];

export function loreLine(): string {
  // stable for ~10 minutes so it doesn't flicker on rerender
  const bucket = Math.floor(Date.now() / 600_000);
  return LORE_LINES[bucket % LORE_LINES.length];
}
