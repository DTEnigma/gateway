/**
 * Aerodrome Slipstream executeSwap — SwapRouter exactInputSingle/exactOutputSingle.
 *
 * ExactInputSingleParams verified vs ISwapRouter.sol (flat struct, tickSpacing
 * replaces UNIv3 fee, sqrtPriceLimitX96 last). Swap event topic is identical
 * to UNIv3 pools (core fork).
 */
import { Contract } from '@ethersproject/contracts';
import { BigNumber, utils } from 'ethers';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { ExecuteSwapResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { poolABI, swapRouterABI } from '../aerodrome.abis';
import { AerodromeConfig } from '../aerodrome.config';
import { getGeneration } from '../aerodrome.constants';
import { formatTokenAmount, readPoolState } from '../aerodrome.utils';
import { quoteSwap } from './quoteSwap';

const CLMM_SWAP_GAS_LIMIT = 350000;

// CLPool Swap event (same signature as UNIv3: sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)
const SWAP_EVENT_TOPIC = utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const SWAP_EVENT_TYPES = ['int256', 'int256', 'uint160', 'uint128', 'int24'];

export async function executeSwap(
  network: string,
  walletAddress: string,
  poolAddress: string,
  baseToken: string,
  side: 'BUY' | 'SELL',
  amount: number,
  slippagePct: number = AerodromeConfig.config.slippagePct,
): Promise<ExecuteSwapResponseType> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) throw httpErrors.badRequest('Wallet not found');

  // Pool context
  const pool = new Contract(poolAddress, poolABI as any, ethereum.provider);
  let immutables: any;
  try {
    const state = await readPoolState(pool);
    immutables = { token0: state.token0, token1: state.token1, tickSpacing: state.tickSpacing };
  } catch {
    throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const baseInfo = await aerodrome.getToken(baseToken);
  if (!baseInfo) throw httpErrors.notFound(sanitizeErrorMessage('Base token not found: {}', baseToken));
  const isBaseToken0 = baseToken.toLowerCase() === immutables.token0.toLowerCase();

  // Quote for slippage bounds
  const quote = await quoteSwap(network, poolAddress, baseToken, side, amount, slippagePct);

  const tokenIn = side === 'SELL' ? baseToken : isBaseToken0 ? immutables.token1 : immutables.token0;
  const tokenOut = side === 'SELL' ? (isBaseToken0 ? immutables.token1 : immutables.token0) : baseToken;
  const tokenInInfo = await aerodrome.getToken(tokenIn);
  const tokenOutInfo = await aerodrome.getToken(tokenOut);

  // Which generation owns this pool? Use latest router by default; the router
  // is permissive across generations for swaps (single contract surface).
  const gen = getGeneration('gauges-v3');
  const router = new Contract(gen.swapRouter, swapRouterABI as any, wallet);

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_SWAP_GAS_LIMIT);

  let tx;
  if (side === 'SELL') {
    const amountIn = utils.parseUnits(amount.toString(), tokenInInfo.decimals);
    // amountOutMinimum from quote (raw minAmountOut is human-scale; recompute raw)
    const minOutRaw = utils.parseUnits(quote.minAmountOut.toFixed(tokenOutInfo.decimals), tokenOutInfo.decimals);
    tx = await router.exactInputSingle(
      {
        tokenIn,
        tokenOut,
        tickSpacing: Number(immutables.tickSpacing),
        recipient: walletAddress,
        deadline,
        amountIn,
        amountOutMinimum: minOutRaw,
        sqrtPriceLimitX96: 0,
      },
      txParams,
    );
  } else {
    const amountOut = utils.parseUnits(amount.toString(), tokenOutInfo.decimals);
    const maxInRaw = utils.parseUnits(quote.maxAmountIn.toFixed(tokenInInfo.decimals), tokenInInfo.decimals);
    tx = await router.exactOutputSingle(
      {
        tokenIn,
        tokenOut,
        tickSpacing: Number(immutables.tickSpacing),
        recipient: walletAddress,
        deadline,
        amountOut,
        amountInMaximum: maxInRaw,
        sqrtPriceLimitX96: 0,
      },
      txParams,
    );
  }

  const outcome = await ethereum.handleTransactionConfirmation(tx);
  if (!outcome.confirmed) {
    return { signature: outcome.signature, status: TransactionStatus.PENDING };
  }

  // Executed amounts from the pool's own Swap event (fill may differ from quote)
  let amountIn = quote.amountIn;
  let amountOut = quote.amountOut;
  const swapLog = outcome.receipt.logs.find(
    (log: any) =>
      log.address.toLowerCase() === poolAddress.toLowerCase() && log.topics[0] === SWAP_EVENT_TOPIC,
  );
  if (swapLog) {
    const [a0, a1] = utils.defaultAbiCoder.decode(SWAP_EVENT_TYPES, swapLog.data) as BigNumber[];
    const rawIn = a0.isNegative() ? a1 : a0;
    const rawOut = a0.isNegative() ? a0 : a1;
    amountIn = Number(utils.formatUnits(rawIn, tokenInInfo.decimals));
    amountOut = Number(utils.formatUnits(rawOut.mul(-1), tokenOutInfo.decimals));
  }

  logger.info(`Slipstream swap executed: ${side} ${amount} ${baseInfo.symbol}, tx=${outcome.signature}`);

  // Balance changes from the base-token perspective (schema contract)
  const baseIsTokenIn = side === 'SELL';
  const baseTokenBalanceChange = baseIsTokenIn ? -amountIn : amountOut;
  const quoteTokenBalanceChange = baseIsTokenIn ? amountOut : -amountIn;

  return {
    signature: outcome.signature,
    status: TransactionStatus.CONFIRMED,
    data: {
      fee: outcome.fee,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      baseTokenBalanceChange,
      quoteTokenBalanceChange,
    },
  };
}
