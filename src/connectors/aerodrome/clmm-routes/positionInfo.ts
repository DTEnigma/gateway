/**
 * Aerodrome Slipstream positionInfo route — mirrors uniswap clmm-routes.
 * Iterates the three NPM generations to find the tokenId's owner generation.
 */
import { Contract } from '@ethersproject/contracts';
import { Position as UniV3Position } from '@uniswap/v3-sdk';
import { FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { PositionInfo } from '../../../schemas/clmm-schema';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { slipstreamGenerations } from '../aerodrome.constants';
import { formatTokenAmount, tickToPrice, toV3SdkPool } from '../aerodrome.utils';

export async function getPositionInfo(
  fastify: FastifyInstance,
  network: string,
  positionAddress: string,
): Promise<PositionInfo> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  if (!positionAddress) {
    throw fastify.httpErrors.badRequest('Position token ID is required');
  }

  // Find which generation's NPM owns this tokenId.
  let ownerGen: string | null = null;
  let positionDetails: any = null;
  for (const gen of slipstreamGenerations) {
    const npm = new Contract(
      gen.nonfungiblePositionManager,
      nonfungiblePositionManagerABI as any,
      ethereum.provider,
    );
    try {
      positionDetails = await npm.positions(Number(positionAddress));
      ownerGen = gen.name;
      break; // first generation that doesn't revert wins
    } catch {
      // not this generation — try next
    }
  }
  if (!ownerGen || !positionDetails) {
    throw fastify.httpErrors.notFound(`Position not found: ${positionAddress}`);
  }

  const token0 = await aerodrome.getToken(positionDetails.token0);
  const token1 = await aerodrome.getToken(positionDetails.token1);
  if (!token0 || !token1) {
    throw fastify.httpErrors.badRequest('Token information not found');
  }

  const { tickLower, tickUpper, liquidity } = positionDetails;
  const tickSpacing = Number(positionDetails.tickSpacing);

  // Resolve the pool this position lives in.
  const poolState = await aerodrome.getSlipstreamPool(
    positionDetails.token0,
    positionDetails.token1,
    tickSpacing,
    ownerGen,
  );
  if (!poolState) {
    throw fastify.httpErrors.notFound('Pool not found for position');
  }

  const sdkPool = toV3SdkPool({
    token0,
    token1,
    sqrtPriceX96: JSBI.BigInt(poolState.sqrtPriceX96),
    liquidity: JSBI.BigInt(poolState.liquidity),
    tickCurrent: poolState.tick,
    tickSpacing,
  });

  const position = new UniV3Position({
    pool: sdkPool,
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    liquidity: liquidity.toString(),
  });

  const lowerPriceRaw = tickToPrice(Number(tickLower), token0.decimals, token1.decimals);
  const upperPriceRaw = tickToPrice(Number(tickUpper), token0.decimals, token1.decimals);
  const priceRaw = tickToPrice(poolState.tick, token0.decimals, token1.decimals);

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const token0Amount = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
  const token1Amount = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);
  const feeAmount0 = formatTokenAmount(positionDetails.tokensOwed0.toString(), token0.decimals);
  const feeAmount1 = formatTokenAmount(positionDetails.tokensOwed1.toString(), token1.decimals);

  const invert = !isBaseToken0;
  return {
    address: positionAddress,
    poolAddress: poolState.address,
    baseTokenAddress: (isBaseToken0 ? token0 : token1).address,
    quoteTokenAddress: (isBaseToken0 ? token1 : token0).address,
    baseTokenAmount: isBaseToken0 ? token0Amount : token1Amount,
    quoteTokenAmount: isBaseToken0 ? token1Amount : token0Amount,
    baseFeeAmount: isBaseToken0 ? feeAmount0 : feeAmount1,
    quoteFeeAmount: isBaseToken0 ? feeAmount1 : feeAmount0,
    lowerBinId: Number(tickLower),
    upperBinId: Number(tickUpper),
    lowerPrice: invert ? 1 / upperPriceRaw : lowerPriceRaw,
    upperPrice: invert ? 1 / lowerPriceRaw : upperPriceRaw,
    price: invert ? 1 / priceRaw : priceRaw,
  };
}
