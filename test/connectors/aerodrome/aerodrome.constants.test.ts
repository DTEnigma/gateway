/**
 * Constants integrity: three generations pinned, addresses valid, MixedQuoter
 * present. Guards against silent edits of the address book (Aero-merger risk).
 */
// Mock before any import that reaches ConfigManagerV2 (aerodrome.config reads
// slippage at import time; the real manager bootstraps conf templates on disk).
jest.mock('../../../src/services/config-manager-v2', () => ({
  ConfigManagerV2: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn().mockImplementation((key: string) =>
        key === 'aerodrome.slippagePct' ? 0.5 : undefined,
      ),
      set: jest.fn(),
      getSupportedChainNetworks: jest.fn(() => ['ethereum-mainnet']),
    }),
  },
}));

import {
  AerodromeConfig,
  LATEST_GENERATION,
  getGeneration,
  mixedQuoterV3,
  slipstreamGenerations,
} from '../../../src/connectors/aerodrome/aerodrome.constants';
import { AerodromeConfig as AerodromeConnectorConfig } from '../../../src/connectors/aerodrome/aerodrome.config';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

describe('aerodrome.constants', () => {
  it('pins exactly three generations, oldest -> newest', () => {
    expect(slipstreamGenerations.map((g) => g.name)).toEqual(['initial', 'gauge-caps', 'gauges-v3']);
    expect(LATEST_GENERATION).toBe('gauges-v3');
  });

  it.each(slipstreamGenerations.map((g) => [g.name, g] as const))(
    '%s has valid, unique contract addresses',
    (_name, gen) => {
      expect(gen.nonfungiblePositionManager).toMatch(ADDRESS);
      expect(gen.poolFactory).toMatch(ADDRESS);
      expect(gen.quoter).toMatch(ADDRESS);
      expect(gen.swapRouter).toMatch(ADDRESS);
    },
  );

  it('no address appears in two roles or generations (except by accident of deployment)', () => {
    const all = slipstreamGenerations.flatMap((g) => [
      g.nonfungiblePositionManager,
      g.poolFactory,
      g.quoter,
      g.swapRouter,
    ]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('getGeneration resolves by name and rejects unknowns', () => {
    expect(getGeneration('initial').name).toBe('initial');
    expect(() => getGeneration('velodrome')).toThrow(/Unknown Slipstream generation/);
  });

  it('mixedQuoterV3 is a valid address (cross-factory quoting)', () => {
    expect(mixedQuoterV3).toMatch(ADDRESS);
  });

  it('constants namespace pins chain and fee tiers', () => {
    expect(AerodromeConfig.chain).toBe('ethereum');
    expect(AerodromeConfig.feeTiers).toHaveLength(4);
    for (const tier of AerodromeConfig.feeTiers) {
      expect(tier.tickSpacing).toBeGreaterThan(0);
    }
  });

  it('connector config targets ethereum/base with clmm only', () => {
    expect(AerodromeConnectorConfig.chain).toBe('ethereum');
    expect(AerodromeConnectorConfig.networks).toContain('base');
    expect(AerodromeConnectorConfig.tradingTypes).toEqual(['clmm']);
  });
});
