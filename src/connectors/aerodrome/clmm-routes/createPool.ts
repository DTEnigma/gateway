/**
 * Aerodrome Slipstream createPool — PoolFactory.createPool(tokenA, tokenB, tickSpacing).
 * Slipstream factory takes tickSpacing (not fee). Rarely used (Aerodrome pools
 * exist); provided for parity with uniswap route.
 */
import { Contract } from '@ethersproject/contracts';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { CreatePoolResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { poolFactoryABI } from '../aerodrome.abis';
import { LATEST_GENERATION, getGeneration } from '../aerodrome.constants';

const CLMM_CREATE_POOL_GAS_LIMIT = 5_000_000;

export async function createPool(
  network: string,
  walletAddress: string,
  baseToken: string,
  quoteToken: string,
  _initialPrice: number,
  tickSpacing: number = 60,
  generation: string = LATEST_GENERATION,
): Promise<CreatePoolResponseType> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);
  const gen = getGeneration(generation);

  // Normalize order: token0 < token1 (factory requirement)
  const [token0, token1] =
    baseToken.toLowerCase() < quoteToken.toLowerCase()
      ? [baseToken, quoteToken]
      : [quoteToken, baseToken];

  // Sanity: both tokens known
  const t0 = await aerodrome.getToken(token0);
  const t1 = await aerodrome.getToken(token1);
  if (!t0 || !t1) throw httpErrors.badRequest('Token information not found');

  // Pool must not already exist
  const factory = new Contract(gen.poolFactory, poolFactoryABI as any, ethereum.provider);
  const existing: string = await factory.getPool(token0, token1, tickSpacing);
  if (existing && !/^0x0+$/.test(existing)) {
    throw httpErrors.badRequest(`Pool already exists: ${existing}`);
  }

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) throw httpErrors.badRequest('Wallet not found');

  const factoryWithSigner = new Contract(gen.poolFactory, poolFactoryABI as any, wallet);
  logger.info(`Slipstream createPool: ${t0.symbol}/${t1.symbol} spacing=${tickSpacing} gen=${gen.name}`);

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_CREATE_POOL_GAS_LIMIT);
  const tx = await factoryWithSigner.createPool(token0, token1, tickSpacing, txParams);

  const outcome = await ethereum.handleTransactionConfirmation(tx);
  if (!outcome.confirmed) {
    return { signature: outcome.signature, status: TransactionStatus.PENDING, poolAddress: '' };
  }

  // Resolve the new pool address
  const poolAddress: string = await factory.getPool(token0, token1, tickSpacing);
  if (!poolAddress || /^0x0+$/.test(poolAddress)) {
    throw httpErrors.internalServerError(
      `Pool creation tx ${outcome.signature} confirmed but pool not found — inspect transaction`,
    );
  }

  return {
    signature: outcome.signature,
    status: TransactionStatus.CONFIRMED,
    poolAddress,
  };
}
