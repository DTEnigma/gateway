/**
 * Aerodrome Slipstream closePosition route — full teardown:
 * decreaseLiquidity(max) -> collect(max) -> burn(tokenId).
 * Mirrors uniswap clmm-routes/closePosition sequencing.
 */
import { Contract } from '@ethersproject/contracts';
import { Position as UniV3Position } from '@uniswap/v3-sdk';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { ClosePositionResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { formatTokenAmount, toV3SdkPool } from '../aerodrome.utils';
import { locatePosition } from './addLiquidity';

const CLMM_CLOSE_POSITION_GAS_LIMIT = 500000;
const MAX_UINT128 = '0xffffffffffffffffffffffffffffffff';

export async function closePosition(
  network: string,
  positionAddress: string,
): Promise<ClosePositionResponseType> {
  if (!positionAddress) {
    throw httpErrors.badRequest('Position token ID is required');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const { npmAddress, details, token0, token1, poolState } = await locatePosition(
    aerodrome, ethereum, positionAddress,
  );

  const walletAddress = await requireWallet(ethereum);
  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) throw httpErrors.badRequest('Wallet not found');

  const npm = new Contract(npmAddress, nonfungiblePositionManagerABI as any, wallet);

  const liquidity = details.liquidity.toString();
  let baseTokenAmountRemoved = '0';
  let quoteTokenAmountRemoved = '0';

  if (liquidity !== '0') {
    // Compute min amounts at current price for the full remaining liquidity
    const sdkPool = toV3SdkPool({
      token0,
      token1,
      sqrtPriceX96: poolState.sqrtPriceX96,
      liquidity: poolState.liquidity,
      tickCurrent: poolState.tick,
      tickSpacing: Number(details.tickSpacing),
    });
    const position = new UniV3Position({
      pool: sdkPool,
      tickLower: Number(details.tickLower),
      tickUpper: Number(details.tickUpper),
      liquidity,
    });

    const decreaseParams = {
      tokenId: Number(positionAddress),
      liquidity,
      amount0Min: position.amount0.quotient.toString(),
      amount1Min: position.amount1.quotient.toString(),
      deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    };
    logger.info(`Slipstream close: decreaseLiquidity tokenId=${positionAddress} liquidity=${liquidity}`);
    const txParams = await ethereum.prepareGasOptions(undefined, CLMM_CLOSE_POSITION_GAS_LIMIT);
    const tx = await npm.decreaseLiquidity(decreaseParams, txParams);
    const outcome = await ethereum.handleTransactionConfirmation(tx);
    if (!outcome.confirmed) {
      return { signature: outcome.signature, status: TransactionStatus.PENDING };
    }
    baseTokenAmountRemoved = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
    quoteTokenAmountRemoved = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);
  }

  // Collect everything owed (principal remainder after decrease + fees)
  const collectParams = {
    tokenId: Number(positionAddress),
    recipient: walletAddress,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };
  logger.info(`Slipstream close: collect tokenId=${positionAddress}`);
  const txParams2 = await ethereum.prepareGasOptions(undefined, CLMM_CLOSE_POSITION_GAS_LIMIT);
  const tx2 = await npm.collect(collectParams, txParams2);
  const outcome2 = await ethereum.handleTransactionConfirmation(tx2);
  if (!outcome2.confirmed) {
    return { signature: outcome2.signature, status: TransactionStatus.PENDING };
  }

  // Burn the NFT (requires zero liquidity + collected tokens)
  logger.info(`Slipstream close: burn tokenId=${positionAddress}`);
  const txParams3 = await ethereum.prepareGasOptions(undefined, CLMM_CLOSE_POSITION_GAS_LIMIT);
  const tx3 = await npm.burn(Number(positionAddress), txParams3);
  const outcome3 = await ethereum.handleTransactionConfirmation(tx3);
  if (!outcome3.confirmed) {
    return { signature: outcome3.signature, status: TransactionStatus.PENDING };
  }

  return {
    signature: outcome3.signature,
    status: TransactionStatus.CONFIRMED,
    data: {
      fee: outcome3.fee,
      baseTokenAmountRemoved,
      quoteTokenAmountRemoved,
    },
  };
}

async function requireWallet(ethereum: Ethereum): Promise<string> {
  const addr = await Ethereum.getFirstWalletAddress();
  if (!addr) throw httpErrors.badRequest('No default wallet found');
  return addr;
}
