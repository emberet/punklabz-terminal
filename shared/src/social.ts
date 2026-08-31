// XP levels, badge ids, and social types shared by server + web.

export const LEVELS = [
  { title: 'NOVICE', minXp: 0 },
  { title: 'PAPERHAND', minXp: 100 },
  { title: 'TRADER', minXp: 300 },
  { title: 'STRATEGIST', minXp: 750 },
  { title: 'QUANT', minXp: 1500 },
  { title: 'SHARK', minXp: 3000 },
  { title: 'WHALE', minXp: 6000 },
  { title: 'LEGEND', minXp: 12000 },
] as const;

export function levelForXp(xp: number): { level: number; title: string; nextAt: number | null } {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i].minXp) idx = i;
  return {
    level: idx + 1,
    title: LEVELS[idx].title,
    nextAt: idx + 1 < LEVELS.length ? LEVELS[idx + 1].minXp : null,
  };
}

export const XP = {
  deploy: 50,
  cloneReceived: 40,
  trade: 2,
  tradeDailyCap: 40,
  backtest: 5,
  backtestDailyCap: 3, // number of awards per day
  dailyLogin: 10,
  season1st: 500,
  seasonTop3: 250,
  seasonTop10: 100,
} as const;

export const BADGES: Record<string, { label: string; description: string }> = {
  first_deploy: { label: 'FIRST DEPLOY', description: 'Deployed a bot' },
  trades_10: { label: '10 TRADES', description: 'Your bots made 10 trades' },
  trades_100: { label: '100 TRADES', description: 'Your bots made 100 trades' },
  clones_5: { label: '5 CLONES', description: 'Your bots were cloned 5 times' },
  season_top10: { label: 'TOP 10', description: 'Finished a season in the top 10' },
  streak_7d: { label: '7 DAY STREAK', description: 'A bot grew 7 days in a row' },
};

export const BIG_WIN_USD = 100;

export interface ActivityEventView {
  id: number;
  type: string;
  actorUserId: number | null;
  actorName: string | null;
  botId: number | null;
  botName: string | null;
  payload: Record<string, unknown>;
  ts: number;
}

export interface ProfileView {
  user: { id: number; displayName: string; createdAt: number; xp: number; level: number; levelTitle: string; nextLevelAt: number | null };
  followers: number;
  following: number;
  isFollowing: boolean;
  badges: { badge: string; seasonId: number; awardedAt: number }[];
  bots: import('./types.js').BotSummary[];
  bestRank: number | null;
  portfolioPnlUsd: number;
  portfolioPnlPct: number;
  clonesReceived: number;
  creatorEarningsUsd: number;
}
