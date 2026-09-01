import type { RhAssetClass } from '@punklabz/shared';

type Capabilities = Record<string, Record<string, string>>;

const TRADABLE = 'TRADING_STATUS_TRADABLE';

function newYorkClock(now: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: value('weekday'), minutes: Number(value('hour')) * 60 + Number(value('minute')) };
}

function capabilityIsTradable(capabilities: Capabilities, name: string, fractionalRequired: boolean): boolean {
  const cap = capabilities[name];
  return fractionalRequired ? cap?.fractional === TRADABLE
    : cap?.whole === TRADABLE || cap?.fractional === TRADABLE;
}

export interface MarketSessionState {
  open: boolean;
  session: 'continuous' | 'overnight' | 'extended' | 'regular' | 'closed';
  reason: string;
}

/** Evaluate the issuer-advertised session in New York time. */
export function marketSessionState(
  assetClass: RhAssetClass,
  capabilities: Capabilities,
  now = new Date(),
): MarketSessionState {
  if (assetClass === 'CRYPTO' || assetClass === 'STABLECOIN') {
    return { open: true, session: 'continuous', reason: 'crypto settlement is continuous' };
  }

  const { weekday, minutes } = newYorkClock(now);
  // The canary routes a fixed $0.50 notional. Stock-token legs therefore need
  // the issuer's fractional capability; whole-share eligibility is not enough.
  const fractionalRequired = true;
  if (capabilityIsTradable(capabilities, 'overnight', fractionalRequired)) {
    const open =
      (weekday === 'Sun' && minutes >= 20 * 60) ||
      ['Mon', 'Tue', 'Wed', 'Thu'].includes(weekday) ||
      (weekday === 'Fri' && minutes < 20 * 60);
    if (open) return { open: true, session: 'overnight', reason: 'eligible Sunday 20:00 through Friday 20:00 ET session' };
  }

  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) {
    return { open: false, session: 'closed', reason: 'stock-token session is closed for the weekend' };
  }
  if (capabilityIsTradable(capabilities, 'extended', fractionalRequired) && minutes >= 7 * 60 && minutes < 20 * 60) {
    return { open: true, session: 'extended', reason: 'eligible 07:00-20:00 ET extended session' };
  }
  if (capabilityIsTradable(capabilities, 'market', fractionalRequired) && minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return { open: true, session: 'regular', reason: 'eligible 09:30-16:00 ET regular session' };
  }
  return { open: false, session: 'closed', reason: 'outside issuer-advertised trading capabilities' };
}
