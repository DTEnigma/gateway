/**
 * Aerodrome Slipstream removeLiquidity route — decreaseLiquidity(tokenId, ...).
 * `liquidity` param is the onchain uint128 liquidity amount (positionInfo
 * exposes it via the sdk Position). Slipstream struct identical to UNIv3.
 */
import { Contract } from '@ethersproject/contracts';
import { Position as UniV3Position } from '@uniswap/v3-sdk';
import { FastifyInstance } from 'fastify';

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
  fastify: FastifyInstance,
  network: string,
  positionAddress: string,
  liquidity: string, // uint128 raw
): Promise<RemoveLiquidityResponseType> {
  if (!positionAddress || !liquidity) {
    throw httpErrors.badRequest('Position token ID and liquidity are required');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const { details, token0, token1, poolState, generation } = await locatePosition(
    aerodrome, ethereum, positionAddress,
  );

  const wallet = await ethereum.getWallet(await requireWallet(ethereum));
  if (!wallet) throw httpErrors.badRequest('Wallet not found');

  const sdkPool = toV3SdkPool({
    token0,
    token1,
    sqrtPriceX96: poolState.sqrtPriceX96,
    liquidity: poolState.liquidity,
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
      baseTokenAmountRemoved: formatTokenAmount(position.amount0.quotient.toString(), token0.decimals),
      quoteTokenAmountRemoved: formatTokenAmount(position.amount1.quotient.toString(), token1.decimals),
    },
  };
}

function slipstreamNpm(generation: string): string {
  return getGeneration(generation).nonfungiblePositionManager;
}

async function requireWallet(ethereum: Ethereum): Promise<string> {
  const addr = await Ethereum.getFirstWalletAddress();
  if (!addr) throw httpErrors.badRequest('No default wallet found');
  return addr;
}
