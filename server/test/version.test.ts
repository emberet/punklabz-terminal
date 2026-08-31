import { describe, expect, it } from 'vitest';
import { isValidBuildInfo } from '../src/api/routes/version.js';

describe('production build identity', () => {
  const valid = {
    commit: 'a'.repeat(40),
    branch: 'main',
    dirty: false,
    builtAt: '2026-09-01T00:00:00Z',
    builtBy: 'deploy@host',
    artifactChecksum: 'b'.repeat(64),
  };

  it('accepts a complete clean release stamp', () => {
    expect(isValidBuildInfo(valid)).toBe(true);
  });

  it.each([
    { ...valid, commit: 'abc1234' },
    { ...valid, dirty: true },
    { ...valid, artifactChecksum: undefined },
    { ...valid, artifactChecksum: 'deadbeef' },
    { ...valid, builtAt: 'not-a-date' },
  ])('rejects an incomplete or unverifiable stamp', (candidate) => {
    expect(isValidBuildInfo(candidate)).toBe(false);
  });
});
