import { describe, expect, it } from 'vitest';
import {
  USDG_ADDRESS, WETH_ADDRESS, buildWithdrawalPolicy,
} from '../src/live/signing/provisionPrivy.js';
import { renderSweep, type SweepReport } from '../src/ops/sweepToOperator.js';

// THE WITHDRAWAL POLICY.
//
// This policy exists to let money leave, which makes it the most dangerous
// object in the codebase. The tests that matter are not the ones proving it
// permits a withdrawal — they are the ones proving it permits NOTHING ELSE:
// no other destination, no other chain, no other token, and never more than
// the wallet actually holds.

const OPERATOR = '0xfB047FE60FFac1D1A840a6f8C518C28A5f280d23';
const ATTACKER = '0x1111111111111111111111111111111111111111';
const caps = { usdgBaseUnits: 50_003_000n, wethWei: 207_949_868_288_714n, nativeWei: 6_000_000_000_000_000n };

const conditions = (policy: any, ruleIndex: number) => policy.rules[ruleIndex].conditions as any[];
const condition = (policy: any, ruleIndex: number, field: string) =>
  conditions(policy, ruleIndex).find((c) => c.field === field);

describe('the withdrawal policy pins the destination', () => {
  it('names the operator address in every rule that can move value', () => {
    const policy = buildWithdrawalPolicy(OPERATOR, caps) as any;
    expect(policy.rules).toHaveLength(3);
    // the two ERC-20 rules carry the destination in calldata...
    expect(condition(policy, 0, 'transfer.to').value).toBe(OPERATOR);
    expect(condition(policy, 1, 'transfer.to').value).toBe(OPERATOR);
    // ...and the native rule carries it as the transaction target
    expect(condition(policy, 2, 'to').value).toBe(OPERATOR);
  });

  it('mentions no address other than the operator and the two token contracts', () => {
    const policy = buildWithdrawalPolicy(OPERATOR, caps) as any;
    const addresses = JSON.stringify(policy).match(/0x[a-fA-F0-9]{40}/g) ?? [];
    const allowed = new Set([OPERATOR, USDG_ADDRESS, WETH_ADDRESS].map((a) => a.toLowerCase()));
    for (const a of addresses) {
      expect(allowed.has(a.toLowerCase()), `unexpected address in policy: ${a}`).toBe(true);
    }
    expect(JSON.stringify(policy).toLowerCase()).not.toContain(ATTACKER.toLowerCase());
  });

  it('checksums a lowercase destination rather than pinning an unnormalised string', () => {
    // a policy pinned to a lowercase address would refuse the checksummed
    // address the signer actually sends, and the failure would look like a
    // policy violation rather than a formatting bug
    const policy = buildWithdrawalPolicy(OPERATOR.toLowerCase(), caps) as any;
    expect(condition(policy, 2, 'to').value).toBe(OPERATOR);
  });

  it('refuses a malformed destination outright', () => {
    expect(() => buildWithdrawalPolicy('0xnope', caps)).toThrow();
  });
});

describe('the withdrawal policy bounds the amounts', () => {
  it('caps each asset at the balance it was told about, with lte not eq', () => {
    const policy = buildWithdrawalPolicy(OPERATOR, caps) as any;
    const usdg = condition(policy, 0, 'transfer.amount');
    expect(usdg.operator).toBe('lte');
    expect(BigInt(usdg.value)).toBe(caps.usdgBaseUnits);
    const native = condition(policy, 2, 'value');
    // `eq` would be wrong here: a full sweep is balance minus gas, and gas is
    // not known until signing time
    expect(native.operator).toBe('lte');
    expect(BigInt(native.value)).toBe(caps.nativeWei);
  });

  it('pins chain 4663 on every rule', () => {
    const policy = buildWithdrawalPolicy(OPERATOR, caps) as any;
    for (const rule of policy.rules) {
      const chain = rule.conditions.find((c: any) => c.field === 'chain_id');
      expect(chain.operator).toBe('eq');
      expect(chain.value).toBe('4663');
    }
  });

  it('forbids a token transfer from also carrying native value', () => {
    const policy = buildWithdrawalPolicy(OPERATOR, caps) as any;
    for (const i of [0, 1]) expect(condition(policy, i, 'value')).toMatchObject({ operator: 'eq', value: '0x0' });
  });

  it('emits no rule for an asset with a zero balance', () => {
    const policy = buildWithdrawalPolicy(OPERATOR, { ...caps, wethWei: 0n }) as any;
    expect(policy.rules).toHaveLength(2);
    expect(JSON.stringify(policy)).not.toContain(WETH_ADDRESS);
  });

  it('refuses to build an empty policy for an empty wallet', () => {
    expect(() => buildWithdrawalPolicy(OPERATOR, { usdgBaseUnits: 0n, wethWei: 0n, nativeWei: 0n }))
      .toThrow(/holds nothing/);
  });

  it('only ever allows — it never emits a DENY it might rely on', () => {
    // Privy policies are default-deny. A DENY rule here would imply the author
    // thought something was permitted that is not, which is worth catching.
    const policy = buildWithdrawalPolicy(OPERATOR, caps) as any;
    for (const rule of policy.rules) expect(rule.action).toBe('ALLOW');
  });
});

describe('the printed plan', () => {
  it('says plainly when nothing was signed', () => {
    const report: SweepReport = {
      walletAddress: '0xd5788b6694a05366FaaeEfEff35c7a5913D02Ff9',
      destination: OPERATOR, dryRun: true,
      balances: { usdg: 50_003_000n, weth: 0n, native: 6_962_000_000_000_000n },
      steps: [{ what: 'USDG 50.003000', to: USDG_ADDRESS, value: 0n, data: '0x', gas: 90_000n }],
      policyRestored: false,
    };
    const out = renderSweep(report);
    expect(out).toContain('DRY RUN — nothing signed');
    expect(out).toContain(OPERATOR);
    expect(out).toContain('USDG 50.003000');
    expect(out).not.toContain('policy restored');
  });

  it('reports whether the original policy went back', () => {
    const report: SweepReport = {
      walletAddress: '0xd5788b6694a05366FaaeEfEff35c7a5913D02Ff9',
      destination: OPERATOR, dryRun: false,
      balances: { usdg: 0n, weth: 0n, native: 0n },
      steps: [], policyRestored: true,
    };
    expect(renderSweep(report)).toContain('policy restored: true');
  });
});
