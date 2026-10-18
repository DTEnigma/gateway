/**
 * Aerodrome Slipstream contract addresses & constants on Base.
 *
 * Sources (verified 2026-10-18):
 *   https://github.com/aerodrome-finance/slipstream README — Deployments tables
 *
 * THREE deployment generations are live on Base simultaneously:
 *   - "initial"     (oldest pools)
 *   - "gauge-caps"  (cap enforcement + redistributor)
 *   - "gauges-v3"   (latest; ALL NEW gauges/pools deploy from here)
 *
 * Existing positions live on old generations; new pools are created on the
 * latest. The connector must therefore track factories/NPMs per generation.
 * Slipstream is a Uniswap V3 fork: tick math, sqrtPriceX96, ERC-721 position
 * semantics are identical; fee-token handling in collect() differs.
 */

export namespace AerodromeConfig {
  export const chain = 'ethereum';
  export const network = 'base';

  // Slipstream fee tiers -> tick spacing. VERIFY per-pool via
  // pool.immutables(); do NOT assume UNIv3 spacings everywhere.
  // Known Slipstream tiers: 0.01%, 0.05%, 0.30%, 1.00% (spacings 1, 10, 60, 200).
  export const feeTiers = [
    { fee: 100, tickSpacing: 1 },      // 0.01%
    { fee: 500, tickSpacing: 10 },     // 0.05%
    { fee: 3000, tickSpacing: 60 },    // 0.30%
    { fee: 10000, tickSpacing: 200 },  // 1.00%
  ];
}

/** One Slipstream deployment generation. */
export interface SlipstreamGeneration {
  name: 'initial' | 'gauge-caps' | 'gauges-v3';
  nonfungiblePositionManager: string;
  poolFactory: string;
  quoter: string;
  swapRouter: string;
}

/** All three generations, oldest -> newest. Source: slipstream README. */
export const slipstreamGenerations: SlipstreamGeneration[] = [
  {
    name: 'initial',
    nonfungiblePositionManager: '0x827922686190790b37229fd06084350E74485b72',
    poolFactory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    quoter: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0', // QuoterV2 (initial)
    swapRouter: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
  },
  {
    name: 'gauge-caps',
    nonfungiblePositionManager: '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F',
    poolFactory: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
    quoter: '0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C',
    swapRouter: '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D',
  },
  {
    name: 'gauges-v3',
    nonfungiblePositionManager: '0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53',
    poolFactory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
    quoter: '0x514c8B5f54112481E28028F1166Bd78501089259',
    swapRouter: '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F',
  },
];

/** Default generation for NEW positions/pools. */
export const LATEST_GENERATION = slipstreamGenerations[slipstreamGenerations.length - 1].name;

/** MixedRouteQuoterV3 — quotes across all 3 CL factories (bitmask-encoded). */
export const mixedQuoterV3 = '0xCd2A7D98e82D6107eac1828ce8DeAA6acB65b555';

/** Resolve a generation by name (throws on unknown). */
export function getGeneration(name: string): SlipstreamGeneration {
  const gen = slipstreamGenerations.find((g) => g.name === name);
  if (!gen) {
    throw new Error(
      `Unknown Slipstream generation '${name}'. Known: ${slipstreamGenerations.map((g) => g.name).join(', ')}`,
    );
  }
  return gen;
}
