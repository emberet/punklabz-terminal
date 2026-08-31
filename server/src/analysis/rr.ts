import type { Candle } from '@punklabz/shared';

// Empirical risk/reward probability: from every k-th historical bar, walk
// forward — did price touch +target% (high) before −stop% (low)? Both in the
// same bar counts as a loss (conservative). Pure + deterministic.

export interface RrResult {
  samples: number;
  wins: number;
  losses: number;
  timeouts: number;
  /** P(target hit before stop), timeouts excluded */
  pWin: number;
  rrRatio: number;
  /** expected % move per trade at 1x, fee-free: pWin·target − (1−pWin)·stop */
  expectancyPct: number;
  /** the same numbers at the requested leverage */
  leverage: number;
  leveragedGainPct: number;
  leveragedLossPct: number;
  leveragedExpectancyPct: number;
  /** stop distance that would wipe 100% equity at this leverage */
  liquidationStopPct: number;
  horizonBars: number;
}

export function rrProbability(
  candles: Candle[],
  opts: { stopPct: number; targetPct: number; leverage?: number; horizonBars?: number; sampleStride?: number },
): RrResult {
  const stop = opts.stopPct / 100;
  const target = opts.targetPct / 100;
  const leverage = Math.max(1, Math.min(25, opts.leverage ?? 1));
  const horizon = opts.horizonBars ?? 720;
  const stride = opts.sampleStride ?? 5;
  if (stop <= 0 || target <= 0) throw new Error('stop and target must be positive');

  let wins = 0;
  let losses = 0;
  let timeouts = 0;

  for (let i = 0; i < candles.length - 1; i += stride) {
    const entry = candles[i].c;
    const targetPx = entry * (1 + target);
    const stopPx = entry * (1 - stop);
    let resolved = false;
    const end = Math.min(candles.length, i + 1 + horizon);
    for (let j = i + 1; j < end; j++) {
      const hitStop = candles[j].l <= stopPx;
      const hitTarget = candles[j].h >= targetPx;
      if (hitStop) {
        losses++; // both-in-one-bar counts as loss
        resolved = true;
        break;
      }
      if (hitTarget) {
        wins++;
        resolved = true;
        break;
      }
    }
    if (!resolved) timeouts++;
  }

  const decided = wins + losses;
  const pWin = decided > 0 ? wins / decided : 0;
  const expectancyPct = (pWin * target - (1 - pWin) * stop) * 100;
  return {
    samples: wins + losses + timeouts,
    wins,
    losses,
    timeouts,
    pWin,
    rrRatio: target / stop,
    expectancyPct,
    leverage,
    leveragedGainPct: opts.targetPct * leverage,
    leveragedLossPct: opts.stopPct * leverage,
    leveragedExpectancyPct: expectancyPct * leverage,
    liquidationStopPct: 100 / leverage,
    horizonBars: horizon,
  };
}
