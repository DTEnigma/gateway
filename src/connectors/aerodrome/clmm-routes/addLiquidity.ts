/**
 * Aerodrome Slipstream addLiquidity route — increaseLiquidity(tokenId, ...).
 * Mirrors uniswap clmm-routes/addLiquidity; Slipstream params struct is
 * identical to UNIv3 (verified vs INonfungiblePositionManager.sol).
 */
import { Contract } from '@ethersproject/contracts';
import { CurrencyAmount, Percent } from '@uniswap/sdk-core';
import { Position as UniV3Position } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { AddLiquidityResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { slipstreamGenerations } from '../aerodrome.constants';
import { formatTokenAmount, toV3SdkPool } from '../aerodrome.utils';

const CLMM_ADD_LIQUIDITY_GAS_LIMIT = 400000;

export async function addLiquidity(
  network: string,
  positionAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct: number = 0.5,
): Promise<AddLiquidityResponseType> {
  if (!positionAddress || (baseTokenAmount === 0 && quoteTokenAmount === 0)) {
    throw httpErrors.badRequest('Position token ID and amounts are required');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  // Locate the owning generation + position details
  const { npm: npmContract, details, token0, token1, poolState } = await locatePosition(
    aerodrome, ethereum, positionAddress,
  );

  const wallet = await ethereum.getWallet(await requireWallet(ethereum));
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  const sdkPool = toV3SdkPool({
    token0: aerodrome.getSdkToken(token0),
    token1: aerodrome.getSdkToken(token1),
    sqrtPriceX96: JSBI.BigInt(poolState.sqrtPriceX96),
    liquidity: JSBI.BigInt(poolState.liquidity),
    tickCurrent: poolState.tick,
    tickSpacing: Number(details.tickSpacing),
  });

  const position = new UniV3Position({
    pool: sdkPool,
    tickLower: Number(details.tickLower),
    tickUpper: Number(details.tickUpper),
    liquidity: details.liquidity.toString(),
  });

  // Orientation: WETH-first base convention (same as positionInfo)
  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const baseTok = isBaseToken0 ? token0 : token1;
  const quoteTok = isBaseToken0 ? token1 : token0;
  const amount0 = CurrencyAmount.fromRawAmount(
    aerodrome.getSdkToken(token0),
    JSBI.BigInt(Math.floor((isBaseToken0 ? baseTokenAmount : quoteTokenAmount) * Math.pow(10, token0.decimals))),
  );
  const amount1 = CurrencyAmount.fromRawAmount(
    aerodrome.getSdkToken(token1),
    JSBI.BigInt(Math.floor((isBaseToken0 ? quoteTokenAmount : baseTokenAmount) * Math.pow(10, token1.decimals))),
  );

  // New liquidity delta from amounts (v3-sdk math over the current pool state)
  const nextPosition = UniV3Position.fromAmounts({
    pool: sdkPool,
    tickLower: Number(details.tickLower),
    tickUpper: Number(details.tickUpper),
    amount0: amount0.quotient,
    amount1: amount1.quotient,
    useFullPrecision: true,
  });
  const liquidityDelta = JSBI.subtract(nextPosition.liquidity, position.liquidity);
  if (!JSBI.greaterThan(liquidityDelta, JSBI.BigInt(0))) {
    throw httpErrors.badRequest('Computed liquidity delta is not positive for given amounts');
  }

  // Slippage mins
  const tolerance = new Percent(Math.floor(slippagePct * 100), 10_000);
  const amount0Min = nextPosition.amount0.subtract(nextPosition.amount0.multiply(tolerance));
  const amount1Min = nextPosition.amount1.subtract(nextPosition.amount1.multiply(tolerance));

  const params = {
    tokenId: Number(positionAddress),
    amount0Desired: nextPosition.amount0.quotient.toString(),
    amount1Desired: nextPosition.amount1.quotient.toString(),
    amount0Min: amount0Min.quotient.toString(),
    amount1Min: amount1Min.quotient.toString(),
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
  };

  logger.info(
    `Slipstream increaseLiquidity: tokenId=${positionAddress} delta=${liquidityDelta.toString()} amounts=(${nextPosition.amount0.toSignificant(6)}, ${nextPosition.amount1.toSignificant(6)})`,
  );

  const npm = new Contract(npmContract.address, nonfungiblePositionManagerABI as any, wallet);
  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_ADD_LIQUIDITY_GAS_LIMIT);
  const tx = await npm.increaseLiquidity(params, txParams);

  const outcome = await ethereum.handleTransactionConfirmation(tx);
  if (!outcome.confirmed) {
    return { signature: outcome.signature, status: TransactionStatus.PENDING };
  }

  return {
    signature: outcome.signature,
    status: TransactionStatus.CONFIRMED,
    data: {
      fee: outcome.fee,
      baseTokenAmountAdded: Number(formatTokenAmount(nextPosition.amount0.quotient.toString(), baseTok.decimals)),
      quoteTokenAmountAdded: Number(formatTokenAmount(nextPosition.amount1.quotient.toString(), quoteTok.decimals)),
    },
  };
}

async function requireWallet(_ethereum: Ethereum): Promise<string> {
  const addr = await Ethereum.getFirstWalletAddress();
  if (!addr) throw httpErrors.badRequest('No default wallet found');
  return addr;
}

/** Locate a position across generations; returns hydrated context. */
export async function locatePosition(aerodrome: Aerodrome, ethereum: Ethereum, positionAddress: string) {
  for (const gen of slipstreamGenerations) {
    const npm = new Contract(
      gen.nonfungiblePositionManager,
      nonfungiblePositionManagerABI as any,
      ethereum.provider,
    );
    let details: any;
    try {
      details = await npm.positions(Number(positionAddress));
    } catch {
      continue;
    }
    const token0 = await aerodrome.getToken(details.token0);
    const token1 = await aerodrome.getToken(details.token1);
    if (!token0 || !token1) throw httpErrors.badRequest('Token information not found');

    const poolState = await aerodrome.getSlipstreamPool(
      details.token0, details.token1, Number(details.tickSpacing), gen.name,
    );
    if (!poolState) throw httpErrors.notFound('Pool not found for position');

    return { npm, npmAddress: gen.nonfungiblePositionManager, details, token0, token1, poolState, generation: gen.name };
  }
  throw httpErrors.notFound(`Position not found: ${positionAddress}`);
}
