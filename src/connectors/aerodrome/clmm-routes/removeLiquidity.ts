/**
 * Aerodrome Slipstream removeLiquidity route — decreaseLiquidity(tokenId, ...).
 * `liquidity` param is the onchain uint128 liquidity amount (positionInfo
 * exposes it via the sdk Position). Slipstream struct identical to UNIv3.
 */
import { Contract } from '@ethersproject/contracts';
import { Position as UniV3Position } from '@uniswap/v3-sdk';
import { FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { RemoveLiquidityResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { getGeneration } from '../aerodrome.constants';
import { formatTokenAmount, toV3SdkPool } from '../aerodrome.utils';
import { locatePosition } from './addLiquidity';

const CLMM_REMOVE_LIQUIDITY_GAS_LIMIT = 400000;

export async function removeLiquidity(
  network: string,
  walletAddress: string,
  positionAddress: string,
  percentageToRemove: number,
  _slippagePct: number = 0.5,
): Promise<RemoveLiquidityResponseType> {
  if (!positionAddress || !(percentageToRemove > 0 && percentageToRemove <= 100)) {
    throw httpErrors.badRequest('Position token ID and percentageToRemove in (0, 100] required');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const { details, token0, token1, poolState, generation } = await locatePosition(
    aerodrome, ethereum, positionAddress,
  );

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) throw httpErrors.badRequest('Wallet not found');

  // percentage -> raw liquidity
  const totalLiquidity = details.liquidity.toString();
  const liquidity = (BigInt(totalLiquidity) * BigInt(Math.floor(percentageToRemove * 100)) / 10000n).toString();

  const sdkPool = toV3SdkPool({
    token0: aerodrome.getSdkToken(token0),
    token1: aerodrome.getSdkToken(token1),
    sqrtPriceX96: JSBI.BigInt(poolState.sqrtPriceX96),
    liquidity: JSBI.BigInt(poolState.liquidity),
    tickCurrent: poolState.tick,
    tickSpacing: Number(details.tickSpacing),
  });

  // Amounts the burned liquidity maps to at current price (slippage floor base)
  const position = new UniV3Position({
    pool: sdkPool,
    tickLower: Number(details.tickLower),
    tickUpper: Number(details.tickUpper),
    liquidity,
  });

  const params = {
    tokenId: Number(positionAddress),
    liquidity,
    amount0Min: position.amount0.quotient.toString(),
    amount1Min: position.amount1.quotient.toString(),
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
  };

  logger.info(`Slipstream decreaseLiquidity: tokenId=${positionAddress} liquidity=${liquidity}`);

  const genNpm = slipstreamNpm(generation);
  const npm = new Contract(genNpm, nonfungiblePositionManagerABI as any, wallet);
  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_REMOVE_LIQUIDITY_GAS_LIMIT);
  const tx = await npm.decreaseLiquidity(params, txParams);

  const outcome = await ethereum.handleTransactionConfirmation(tx);
  if (!outcome.confirmed) {
    return { signature: outcome.signature, status: TransactionStatus.PENDING };
  }

  return {
    signature: outcome.signature,
    status: TransactionStatus.CONFIRMED,
    data: {
      fee: outcome.fee,
      baseTokenAmountRemoved: Number(formatTokenAmount(position.amount0.quotient.toString(), token0.decimals)),
      quoteTokenAmountRemoved: Number(formatTokenAmount(position.amount1.quotient.toString(), token1.decimals)),
    },
  };
}

function slipstreamNpm(generation: string): string {
  return getGeneration(generation).nonfungiblePositionManager;
}
