/**
 * Aerodrome Slipstream poolInfo route — mirrors uniswap clmm-routes/poolInfo.
 * Slipstream pool identity: (token0, token1, tickSpacing); fees are dynamic,
 * so feePct is reported as 0 (the SwapRouter's fee modules decide at swap
 * time) unless a static tier is requested.
 */
import { Contract as EthersProjectContract } from '@ethersproject/contracts';
import { FastifyInstance } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { PoolInfo } from '../../../schemas/clmm-schema';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { poolABI } from '../aerodrome.abis';
import { formatTokenAmount, readPoolState, tickToPrice } from '../aerodrome.utils';

export async function getPoolInfo(
  fastify: FastifyInstance,
  network: string,
  poolAddress: string,
  binCount: number = 0,
): Promise<PoolInfo> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  if (!poolAddress) {
    throw fastify.httpErrors.badRequest('Pool address is required');
  }

  const pool = new EthersProjectContract(poolAddress, poolABI as any, ethereum.provider);

  let state: Awaited<ReturnType<typeof readPoolState>>;
  try {
    state = await readPoolState(pool);
  } catch {
    throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }
  const immutables = { token0: state.token0, token1: state.token1, tickSpacing: state.tickSpacing };
  const slot0 = { sqrtPriceX96: state.sqrtPriceX96, tick: state.tick };

  const token0 = await aerodrome.getToken(immutables.token0);
  const token1 = await aerodrome.getToken(immutables.token1);
  if (!token0 || !token1) {
    throw fastify.httpErrors.badRequest('Token information not found for pool');
  }

  const tick = Number(slot0.tick);
  const tickSpacing = Number(immutables.tickSpacing);
  const price = tickToPrice(tick, token0.decimals, token1.decimals);

  // Real ERC20 balances of the pool (virtual liquidity is not a token amount).
  const token0Contract = ethereum.getContract(token0.address, ethereum.provider);
  const token1Contract = ethereum.getContract(token1.address, ethereum.provider);
  const [token0Balance, token1Balance] = await Promise.all([
    ethereum.getERC20BalanceByAddress(token0Contract, poolAddress, token0.decimals),
    ethereum.getERC20BalanceByAddress(token1Contract, poolAddress, token1.decimals),
  ]);

  // Base = WETH convention from positionInfo; for pure stable pairs the
  // lower address wins (deterministic, matches uniswap behavior).
  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const token0Amount = formatTokenAmount(token0Balance.value.toString(), token0.decimals);
  const token1Amount = formatTokenAmount(token1Balance.value.toString(), token1.decimals);

  const result: PoolInfo = {
    address: poolAddress,
    baseTokenAddress: (isBaseToken0 ? token0 : token1).address,
    quoteTokenAddress: (isBaseToken0 ? token1 : token0).address,
    binStep: tickSpacing,
    feePct: 0, // Slipstream fees are dynamic (fee modules); not a pool immutable
    price: isBaseToken0 ? price : 1 / price,
    baseTokenAmount: Number(isBaseToken0 ? token0Amount : token1Amount),
    quoteTokenAmount: Number(isBaseToken0 ? token1Amount : token0Amount),
    activeBinId: tick,
  };

  if (binCount > 0) {
    // per-bin liquidity distribution via pool.ticks(tick) reads — same
    // pattern as the uniswap route; TODO alongside tick-iteration math.
    fastify.log.warn('aerodrome poolInfo: binCount distribution not yet implemented');
  }

  return result;
}
