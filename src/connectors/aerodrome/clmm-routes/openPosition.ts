/**
 * Aerodrome Slipstream openPosition route — mirrors uniswap clmm-routes.
 *
 * Slipstream deltas encoded here (verified vs INonfungiblePositionManager.sol):
 *  - mint(MintParams) called DIRECTLY (no multicall wrapper needed — the
 *    uniswap route uses multicall only because addCallParameters bundles
 *    create+approve for ETH pools; Slipstream mint is a single call).
 *  - MintParams carries tickSpacing (identity) + sqrtPriceX96 (init hint; we
 *    pass current pool sqrtP — pool exists, so the hint is only used if the
 *    pool were somehow uninitialized).
 *  - Slippage: amount0Min/amount1Min derived from desired amounts minus
 *    slippagePct.
 */
import { Contract } from '@ethersproject/contracts';
import { CurrencyAmount, Percent } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { OpenPositionResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { LATEST_GENERATION, getGeneration } from '../aerodrome.constants';
import {
  buildPositionFromAmounts,
  formatTokenAmount,
  nearestUsableTick,
  priceToTick,
} from '../aerodrome.utils';

const CLMM_OPEN_POSITION_GAS_LIMIT = 600000;

// ERC-721 Transfer event topic (identical to UNIv3 NPM — OZ ERC721)
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export async function openPosition(
  network: string,
  walletAddress: string,
  lowerPrice: number,
  upperPrice: number,
  poolAddress: string,
  baseTokenAmount?: number,
  quoteTokenAmount?: number,
  slippagePct: number = 0.5,
  generation: string = LATEST_GENERATION,
): Promise<OpenPositionResponseType> {
  if (
    !lowerPrice ||
    !upperPrice ||
    !poolAddress ||
    (baseTokenAmount === undefined && quoteTokenAmount === undefined)
  ) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);
  const gen = getGeneration(generation);

  // Pool state via the connector (immutables + slot0 + liquidity)
  const poolContract = new Contract(poolAddress, poolReaderABI, ethereum.provider);
  let immutables: any, slot0: any, poolLiquidity: any;
  try {
    [immutables, slot0, poolLiquidity] = await Promise.all([
      poolContract.immutables(),
      poolContract.slot0(),
      poolContract.liquidity(),
    ]);
  } catch {
    throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const token0 = await aerodrome.getToken(immutables.token0);
  const token1 = await aerodrome.getToken(immutables.token1);
  if (!token0 || !token1) {
    throw httpErrors.badRequest('Token information not found for pool');
  }

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  const tickSpacing = Number(immutables.tickSpacing);

  // Price -> ticks (decimals-adjusted, same convention as uniswap route)
  const isBaseToken0 =
    (await resolveBaseToken(aerodrome, immutables)).toLowerCase() ===
    immutables.token0.toLowerCase();

  let lowerTick = priceToTick(lowerPrice, token0.decimals, token1.decimals);
  let upperTick = priceToTick(upperPrice, token0.decimals, token1.decimals);
  lowerTick = nearestUsableTick(lowerTick, tickSpacing);
  upperTick = nearestUsableTick(upperTick, tickSpacing);
  if (lowerTick >= upperTick) {
    throw httpErrors.badRequest('Lower price must be less than upper price');
  }

  // Amounts (base/quote -> token0/token1 orientation)
  let token0Amount = CurrencyAmount.fromRawAmount(token0, 0);
  let token1Amount = CurrencyAmount.fromRawAmount(token1, 0);
  if (baseTokenAmount !== undefined) {
    const tok = isBaseToken0 ? token0 : token1;
    const raw = JSBI.BigInt(Math.floor(baseTokenAmount * Math.pow(10, tok.decimals)).toString());
    if (isBaseToken0) token0Amount = CurrencyAmount.fromRawAmount(token0, raw);
    else token1Amount = CurrencyAmount.fromRawAmount(token1, raw);
  }
  if (quoteTokenAmount !== undefined) {
    const tok = isBaseToken0 ? token1 : token0;
    const raw = JSBI.BigInt(Math.floor(quoteTokenAmount * Math.pow(10, tok.decimals)).toString());
    if (isBaseToken0) token1Amount = CurrencyAmount.fromRawAmount(token1, raw);
    else token0Amount = CurrencyAmount.fromRawAmount(token0, raw);
  }

  // Position math via v3-sdk (chain-agnostic arithmetic)
  const position = buildPositionFromAmounts(
    {
      token0,
      token1,
      sqrtPriceX96: JSBI.BigInt(slot0.sqrtPriceX96.toString()),
      liquidity: JSBI.BigInt(poolLiquidity.toString()),
      tickCurrent: Number(slot0.tick),
      tickSpacing,
    },
    lowerTick,
    upperTick,
    token0Amount,
    token1Amount,
  );

  // Slippage mins
  const tolerance = new Percent(Math.floor(slippagePct * 100), 10_000);
  const amount0Min = position.amount0.subtract(position.amount0.multiply(tolerance));
  const amount1Min = position.amount1.subtract(position.amount1.multiply(tolerance));

  // Allowance gates (limits, not max approvals — doc 04 live rule)
  const npmAddress = gen.nonfungiblePositionManager;
  await checkAllowance(ethereum, token0, wallet, npmAddress, position.amount0);
  await checkAllowance(ethereum, token1, wallet, npmAddress, position.amount1);

  // Send mint directly (Slipstream single-call semantics)
  const npm = new Contract(npmAddress, nonfungiblePositionManagerABI as any, wallet);

  const params = {
    token0: immutables.token0,
    token1: immutables.token1,
    tickSpacing,
    tickLower: lowerTick,
    tickUpper: upperTick,
    amount0Desired: position.amount0.quotient.toString(),
    amount1Desired: position.amount1.quotient.toString(),
    amount0Min: amount0Min.quotient.toString(),
    amount1Min: amount1Min.quotient.toString(),
    recipient: walletAddress,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    sqrtPriceX96: slot0.sqrtPriceX96.toString(),
  };

  logger.info(
    `Slipstream mint: ${token0.symbol}/${token1.symbol} spacing=${tickSpacing} ticks=[${lowerTick},${upperTick}] amounts=(${position.amount0.toSignificant(6)}, ${position.amount1.toSignificant(6)})`,
  );

  let tx;
  try {
    const txParams = await ethereum.prepareGasOptions(undefined, CLMM_OPEN_POSITION_GAS_LIMIT);
    tx = await npm.mint(params, txParams);
  } catch (txError: any) {
    logger.error('Transaction failed:', txError);
    throw txError;
  }

  const outcome = await ethereum.handleTransactionConfirmation(tx);
  if (!outcome.confirmed) {
    return { signature: outcome.signature, status: TransactionStatus.PENDING };
  }

  // Scrape the minted NFT id from ERC-721 Transfer(from=0x0) logs
  let positionId = '';
  for (const log of outcome.receipt.logs) {
    if (
      log.address.toLowerCase() === npmAddress.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      positionId = BigNumber.from(log.topics[3]).toString();
      break;
    }
  }
  if (!positionId) {
    throw httpErrors.internalServerError(
      `Position opened in transaction ${outcome.signature} but no position NFT mint was found in its logs. ` +
        `Inspect the transaction to recover the position ID.`,
    );
  }

  const actualToken0 = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
  const actualToken1 = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);

  return {
    signature: outcome.signature,
    status: TransactionStatus.CONFIRMED,
    data: {
      fee: outcome.fee,
      positionAddress: positionId,
      positionRent: 0, // no rent on EVM
      baseTokenAmountAdded: isBaseToken0 ? actualToken0 : actualToken1,
      quoteTokenAmountAdded: isBaseToken0 ? actualToken1 : actualToken0,
    },
  };
}

async function resolveBaseToken(aerodrome: Aerodrome, immutables: any): Promise<string> {
  const t0 = await aerodrome.getToken(immutables.token0);
  const t1 = await aerodrome.getToken(immutables.token1);
  const isBase0 =
    t0?.symbol === 'WETH' ||
    (t1?.symbol !== 'WETH' && immutables.token0.toLowerCase() < immutables.token1.toLowerCase());
  return isBase0 ? immutables.token0 : immutables.token1;
}

async function checkAllowance(
  ethereum: Ethereum,
  token: any,
  wallet: any,
  spender: string,
  required: CurrencyAmount<any>,
): Promise<void> {
  if (required.quotient.toString() === '0') return;
  const tokenContract = ethereum.getContract(token.address, wallet);
  const allowance = await ethereum.getERC20Allowance(tokenContract, wallet, spender, token.decimals);
  const current = BigNumber.from(allowance.value);
  const needed = BigNumber.from(required.quotient.toString());
  logger.info(
    `${token.symbol} allowance: ${formatTokenAmount(current.toString(), token.decimals)} required: ${formatTokenAmount(needed.toString(), token.decimals)}`,
  );
  if (current.lt(needed)) {
    throw httpErrors.badRequest(
      `Insufficient ${token.symbol} allowance. Approve at least ${formatTokenAmount(needed.toString(), token.decimals)} ${token.symbol} for the Position Manager (${spender})`,
    );
  }
}

const poolReaderABI = [
  {
    inputs: [],
    name: 'immutables',
    outputs: [
      { internalType: 'address', name: 'token0', type: 'address' },
      { internalType: 'address', name: 'token1', type: 'address' },
      { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'slot0',
    outputs: [
      { internalType: 'uint160', name: 'sqrtPriceX96', type: 'uint160' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'liquidity',
    outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
