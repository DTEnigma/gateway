/**
 * Aerodrome Slipstream positionsOwned route — mirrors uniswap clmm-routes.
 * Returns hydrated PositionInfo[] across ALL generations (a wallet can hold
 * positions on initial, gauge-caps and gauges-v3 NPMs simultaneously).
 */
import { Contract } from '@ethersproject/contracts';
import { FastifyInstance } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { PositionInfo } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { slipstreamGenerations } from '../aerodrome.constants';

// ERC721Enumerable fragment for enumeration
const ENUMERABLE_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'uint256', name: 'index', type: 'uint256' },
    ],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export async function getPositionsOwned(
  fastify: FastifyInstance,
  network: string,
  walletAddress?: string,
): Promise<PositionInfo[]> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  if (!walletAddress) {
    walletAddress = await aerodrome.getFirstWalletAddress();
    if (!walletAddress) {
      throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
    }
    logger.info(`Using first available wallet address: ${walletAddress}`);
  }

  const results: PositionInfo[] = [];

  for (const gen of slipstreamGenerations) {
    const npm = new Contract(
      gen.nonfungiblePositionManager,
      [...ENUMERABLE_ABI, ...nonfungiblePositionManagerABI] as any,
      ethereum.provider,
    );

    let balance: number;
    try {
      balance = Number(await npm.balanceOf(walletAddress));
    } catch {
      continue; // generation unavailable on this network — skip
    }
    if (balance === 0) continue;

    const tokenIds: bigint[] = await Promise.all(
      Array.from({ length: balance }, (_, i) => npm.tokenOfOwnerByIndex(walletAddress, i)),
    );

    for (const tokenId of tokenIds) {
      try {
        // Reuse the single-position hydration logic (which finds the owning
        // generation itself).
        const info = await getPositionInfoForGeneration(
          fastify, network, tokenId.toString(),
        );
        results.push(info);
      } catch (err) {
        logger.warn(`Skipping position ${tokenId} on ${gen.name}: ${err}`);
      }
    }
  }

  return results;
}

/**
 * Hydrate one position known to belong to `generation`. Exported for reuse;
 * getPositionInfo (unknown generation) lives in positionInfo.ts.
 */
export async function getPositionInfoForGeneration(
  fastify: FastifyInstance,
  network: string,
  positionAddress: string,
): Promise<PositionInfo> {
  // Lazy import to avoid a circular import between the two route modules.
  const { getPositionInfo } = await import('./positionInfo');
  return getPositionInfo(fastify, network, positionAddress);
}
