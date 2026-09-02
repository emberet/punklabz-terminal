import { describe, expect, it } from 'vitest';
import { validProductionAppOrigin } from '../src/config.js';

describe('production app origin', () => {
  it('accepts an exact HTTPS origin', () => {
    expect(validProductionAppOrigin('https://punklabz.app')).toBe(true);
  });

  it.each([
    '',
    'http://punklabz.app',
    'https://punklabz.app/control-room',
    'https://punklabz.app/',
    'not-a-url',
  ])('rejects %j', (origin) => {
    expect(validProductionAppOrigin(origin)).toBe(false);
  });
});
