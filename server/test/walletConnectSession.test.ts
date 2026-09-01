import { describe, expect, it } from 'vitest';
import { selectWalletConnectAccount } from '../../web/src/lib/walletConnectSession';

const address = '0x1234567890abcdef1234567890abcdef12345678';

describe('WalletConnect session chain selection', () => {
  it('ignores a stale persisted chain that the session did not approve', () => {
    const selected = selectWalletConnectAccount({
      namespaces: {
        eip155: {
          accounts: [`eip155:4663:${address}`],
          methods: ['personal_sign'],
        },
      },
    }, 1, [4663, 1]);

    expect(selected).toEqual({ chainId: 4663, address });
  });

  it('keeps the current chain when it is still approved', () => {
    const selected = selectWalletConnectAccount({
      namespaces: {
        eip155: {
          accounts: [`eip155:1:${address}`, `eip155:4663:${address}`],
          methods: ['personal_sign'],
        },
      },
    }, 1, [4663]);

    expect(selected?.chainId).toBe(1);
  });

  it('supports scoped WalletConnect namespaces', () => {
    const selected = selectWalletConnectAccount({
      namespaces: {
        'eip155:8453': {
          accounts: [`eip155:8453:${address}`],
          methods: ['personal_sign'],
        },
      },
    }, 1);

    expect(selected?.chainId).toBe(8453);
  });

  it('rejects sessions without personal_sign permission', () => {
    const selected = selectWalletConnectAccount({
      namespaces: {
        eip155: {
          accounts: [`eip155:1:${address}`],
          methods: ['eth_sendTransaction'],
        },
      },
    }, 1);

    expect(selected).toBeNull();
  });
});
