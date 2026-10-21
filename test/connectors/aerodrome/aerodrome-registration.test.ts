/**
 * Registration tests: aerodrome is present in every dispatch surface the
 * unified trading routes consult — the registry keys, the chain guard, and
 * the dispatch adapters. A connector that misses any surface is unreachable.
 *
 * Follows the repo's established mock pattern (see test/mocks/shared-mocks.ts):
 * the config-manager and logger are mocked before import so the registry's
 * import chain (which reaches the conf-templating bootstrap via
 * chains/ethereum -> services/logger) never touches the filesystem.
 */
jest.mock('../../../src/services/config-manager-v2', () => {
  const storage: Record<string, any> = {
    'server.port': 15888,
    'ethereum-mainnet.nodeURL': 'https://mainnet.infura.io/v3/test',
    'aerodrome.slippagePct': 0.5,
    'uniswap.slippagePct': '0.01',
  };
  return {
    ConfigManagerV2: {
      getInstance: jest.fn().mockReturnValue({
        get: jest.fn().mockImplementation((key: string) => storage[key]),
        set: jest.fn(),
        getNamespace: jest.fn(),
        getSupportedChainNetworks: jest.fn(() => ['ethereum-mainnet']),
      }),
    },
  };
});

jest.mock('../../../src/services/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { CLMM_CONNECTORS, getClmmOps, assertConnectorOnChain } from '../../../src/trading/connector-registry';

describe('aerodrome connector registration', () => {
  it('is in CLMM_CONNECTORS (drives every unified route schema enum)', () => {
    expect(CLMM_CONNECTORS).toContain('aerodrome');
  });

  it('resolves clmm ops on the ethereum chain', () => {
    const ops = getClmmOps('aerodrome', 'ethereum');
    expect(ops.chain).toBe('ethereum');
    expect(typeof ops.quoteSwap).toBe('function');
    expect(typeof ops.executeSwap).toBe('function');
  });

  it('the chain guard rejects it on solana with the ethereum guidance', () => {
    expect(() => assertConnectorOnChain('aerodrome', 'solana', 'clmm')).toThrow(
      /runs on ethereum, not solana/,
    );
  });

  it('quoteSwap dispatch reaches the aerodrome module (fails at network, not dispatch)', async () => {
    const ops = getClmmOps('aerodrome', 'ethereum');
    await expect(
      ops.quoteSwap({
        network: 'nonexistent-network',
        poolAddress: '0x0000000000000000000000000000000000000000',
        baseToken: '0x0',
        side: 'SELL',
        amount: 1,
      }),
    ).rejects.not.toThrow(/has no clmm support/);
  });
});
