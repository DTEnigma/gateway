/**
 * Aerodrome Slipstream quotePosition — amounts for a hypothetical range
 * (mirrors uniswap clmm-routes/quotePosition): v3-sdk Position math over
 * live pool state for the desired ticks.
 */
import { CurrencyAmount } from '@uniswap/sdk-core';
import { Contract } from '@ethersproject/contracts';
import { utils } from 'ethers';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { QuotePositionResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { poolABI } from '../aerodrome.abis';
import {
  buildPositionFromAmounts,
  formatTokenAmount,
  nearestUsableTick,
  priceToTick,
  tickToPrice,
} from '../aerodrome.utils';

export async function quotePosition(
  network: string,
  poolAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  lowerPrice: number,
  upperPrice: number,
  slippagePct: number = 0.5,
): Promise<QuotePositionResponseType> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const pool = new Contract(poolAddress, poolABI as any, ethereum.provider);
  let immutables: any, slot0: any, liquidity: any;
  try {
    [immutables, slot0, liquidity] = await Promise.all([
      pool.immutables(),
      pool.slot0(),
      pool.liquidity(),
    ]);
  } catch {
    throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const token0Info = await aerodrome.getToken(immutables.token0);
  const token1Info = await aerodrome.getToken(immutables.token1);
  if (!token0Info || !token1Info) throw httpErrors.badRequest('Token information not found');
  const token0 = aerodrome.getSdkToken(token0Info);
  const token1 = aerodrome.getSdkToken(token1Info);

  const tickSpacing = Number(immutables.tickSpacing);

  // Base orientation: WETH-first, else lower address (connector convention)
  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  // Prices arrive base-quoted; convert to token0/token1 orientation for ticks
  const humanLower = isBaseToken0 ? lowerPrice : 1 / upperPrice;
  const humanUpper = isBaseToken0 ? upperPrice : 1 / lowerPrice;

  let tickLower = nearestUsableTick(priceToTick(humanLower, token0.decimals, token1.decimals), tickSpacing);
  let tickUpper = nearestUsableTick(priceToTick(humanUpper, token0.decimals, token1.decimals), tickSpacing);
  if (tickLower >= tickUpper) {
    throw httpErrors.badRequest('Lower price must be less than upper price');
  }

  const amount0 = CurrencyAmount.fromRawAmount(
    token0,
    JSBI.BigInt(utils.parseUnits(String(isBaseToken0 ? baseTokenAmount : quoteTokenAmount), token0.decimals).toString()),
  );
  const amount1 = CurrencyAmount.fromRawAmount(
    token1,
    JSBI.BigInt(utils.parseUnits(String(isBaseToken0 ? quoteTokenAmount : baseTokenAmount), token1.decimals).toString()),
  );

  const position = buildPositionFromAmounts(
    {
      token0,
      token1,
      sqrtPriceX96: JSBI.BigInt(slot0.sqrtPriceX96.toString()),
      liquidity: JSBI.BigInt(liquidity.toString()),
      tickCurrent: Number(slot0.tick),
      tickSpacing,
    },
    tickLower,
    tickUpper,
    amount0,
    amount1,
  );

  const curPrice = tickToPrice(Number(slot0.tick), token0.decimals, token1.decimals);
  const lpPrice = isBaseToken0 ? curPrice : 1 / curPrice;

  logger.info(
    `Slipstream quotePosition: ticks=[${tickLower},${tickUpper}] amount0=${position.amount0.toSignificant(6)} amount1=${position.amount1.toSignificant(6)}`,
  );

  const baseAmt = isBaseToken0
    ? position.amount0.quotient.toString()
    : position.amount1.quotient.toString();
  const quoteAmt = isBaseToken0
    ? position.amount1.quotient.toString()
    : position.amount0.quotient.toString();
  // Max amounts = desired + slippage headroom (single-sided deposits cap at desired)
  const slippageFactor = 1 + slippagePct / 100;

  return {
    poolAddress,
    baseTokenAmount: Number(formatTokenAmount(baseAmt, (isBaseToken0 ? token0 : token1).decimals)),
    quoteTokenAmount: Number(formatTokenAmount(quoteAmt, (isBaseToken0 ? token1 : token0).decimals)),
    baseLimited: false, // both sides provided -> not single-sided limited
    baseTokenAmountMax: Number(formatTokenAmount(baseAmt, (isBaseToken0 ? token0 : token1).decimals)) * slippageFactor,
    quoteTokenAmountMax: Number(formatTokenAmount(quoteAmt, (isBaseToken0 ? token1 : token0).decimals)) * slippageFactor,
  };
}
