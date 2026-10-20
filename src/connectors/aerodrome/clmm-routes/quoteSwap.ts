/**
 * Aerodrome Slipstream quoteSwap — v3-sdk trade simulation over pool state
 * (mirrors uniswap clmm-routes/quoteSwap). Registry signature:
 * (network, poolAddress, baseToken, side, amount, slippagePct) — counter-token
 * resolved from pool immutables.
 */
import { Token, Currency, CurrencyAmount, Percent, TradeType } from '@uniswap/sdk-core';
import { Route as V3Route, Trade as V3Trade } from '@uniswap/v3-sdk';
import { Contract } from '@ethersproject/contracts';
import { utils } from 'ethers';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { QuoteSwapResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { poolABI } from '../aerodrome.abis';
import { AerodromeConfig } from '../aerodrome.config';
import { formatTokenAmount, toV3SdkPool } from '../aerodrome.utils';

export async function quoteSwap(
  network: string,
  poolAddress: string,
  baseToken: string,
  side: 'BUY' | 'SELL',
  amount: number,
  slippagePct: number = AerodromeConfig.config.slippagePct,
): Promise<QuoteSwapResponseType> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);
  if (!ethereum.ready()) await ethereum.init();

  // Pool state
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

  // Resolve base + counter tokens from the pool itself
  const token0Info = await aerodrome.getToken(immutables.token0);
  const token1Info = await aerodrome.getToken(immutables.token1);
  if (!token0Info || !token1Info) {
    throw httpErrors.badRequest('Token information not found for pool');
  }
  const token0 = aerodrome.getSdkToken(token0Info);
  const token1 = aerodrome.getSdkToken(token1Info);

  const isBaseToken0 = baseToken.toLowerCase() === token0.address.toLowerCase();
  const base = isBaseToken0 ? token0 : token1;
  const counter = isBaseToken0 ? token1 : token0;

  const sdkPool = toV3SdkPool({
    token0,
    token1,
    sqrtPriceX96: JSBI.BigInt(slot0.sqrtPriceX96.toString()),
    liquidity: JSBI.BigInt(liquidity.toString()),
    tickCurrent: Number(slot0.tick),
    tickSpacing: Number(immutables.tickSpacing),
  });

  const exactIn = side === 'SELL';
  const inputToken: Token = exactIn ? base : counter;
  const outputToken: Token = exactIn ? counter : base;

  const route = new V3Route([sdkPool], inputToken, outputToken);
  let trade: V3Trade<Currency, Currency, TradeType>;
  if (exactIn) {
    const raw = utils.parseUnits(amount.toString(), inputToken.decimals);
    trade = await V3Trade.fromRoute(
      route,
      CurrencyAmount.fromRawAmount(inputToken, JSBI.BigInt(raw.toString())),
      TradeType.EXACT_INPUT,
    );
  } else {
    const raw = utils.parseUnits(amount.toString(), outputToken.decimals);
    trade = await V3Trade.fromRoute(
      route,
      CurrencyAmount.fromRawAmount(outputToken, JSBI.BigInt(raw.toString())),
      TradeType.EXACT_OUTPUT,
    );
  }

  const tolerance = new Percent(Math.floor(slippagePct * 100), 10_000);
  const minAmountOut = exactIn
    ? trade.minimumAmountOut(tolerance).quotient.toString()
    : trade.outputAmount.quotient.toString();
  const maxAmountIn = exactIn
    ? trade.inputAmount.quotient.toString()
    : trade.maximumAmountIn(tolerance).quotient.toString();

  const price = parseFloat(trade.executionPrice.toSignificant(10));
  const priceImpactPct = parseFloat(trade.priceImpact.toSignificant(4)) / 100;

  logger.info(
    `Slipstream quote: ${side} ${amount} ${base.symbol} on ${poolAddress} -> in=${trade.inputAmount.toSignificant(6)} out=${trade.outputAmount.toSignificant(6)}`,
  );

  return {
    poolAddress,
    tokenIn: inputToken.address,
    tokenOut: outputToken.address,
    amountIn: Number(formatTokenAmount(trade.inputAmount.quotient.toString(), inputToken.decimals)),
    amountOut: Number(formatTokenAmount(trade.outputAmount.quotient.toString(), outputToken.decimals)),
    price,
    priceImpactPct,
    minAmountOut: Number(formatTokenAmount(minAmountOut, outputToken.decimals)),
    maxAmountIn: Number(formatTokenAmount(maxAmountIn, inputToken.decimals)),
  };
}

/** Resolve the counter token of a pool for a given base token (registry helper). */
export async function resolveCounterToken(
  network: string,
  poolAddress: string,
  baseToken: string,
): Promise<string> {
  const ethereum = await Ethereum.getInstance(network);
  const pool = new Contract(poolAddress, poolABI as any, ethereum.provider);
  const immutables = await pool.immutables();
  const isBaseToken0 = baseToken.toLowerCase() === immutables.token0.toLowerCase();
  return isBaseToken0 ? immutables.token1 : immutables.token0;
}
