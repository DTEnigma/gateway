/**
 * Aerodrome Slipstream collectFees route — collect(tokenId, recipient, max, max).
 * Slipstream CollectParams identical to UNIv3. tokensOwed are read from
 * positions() before collecting (standard UNIv3-semantics flow).
 */
import { Contract } from '@ethersproject/contracts';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { TransactionStatus } from '../../../schemas/chain-schema';
import { CollectFeesResponseType } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { nonfungiblePositionManagerABI } from '../aerodrome.abis';
import { formatTokenAmount } from '../aerodrome.utils';
import { locatePosition } from './addLiquidity';

const CLMM_COLLECT_GAS_LIMIT = 300000;
const MAX_UINT128 = '0xffffffffffffffffffffffffffffffff';

export async function collectFees(
  network: string,
  positionAddress: string,
): Promise<CollectFeesResponseType> {
  if (!positionAddress) {
    throw httpErrors.badRequest('Position token ID is required');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const { npmAddress, details, token0, token1 } = await locatePosition(aerodrome, ethereum, positionAddress);

  const walletAddress = await requireWallet(ethereum);
  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) throw httpErrors.badRequest('Wallet not found');

  const params = {
    tokenId: Number(positionAddress),
    recipient: walletAddress,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  logger.info(`Slipstream collect: tokenId=${positionAddress}`);

  const npm = new Contract(npmAddress, nonfungiblePositionManagerABI as any, wallet);

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_COLLECT_GAS_LIMIT);
  const tx = await npm.collect(params, txParams);

  const outcome = await ethereum.handleTransactionConfirmation(tx);
  if (!outcome.confirmed) {
    return { signature: outcome.signature, status: TransactionStatus.PENDING };
  }

  return {
    signature: outcome.signature,
    status: TransactionStatus.CONFIRMED,
    data: {
      fee: outcome.fee,
      baseFeeAmountCollected: Number(formatTokenAmount(details.tokensOwed0.toString(), token0.decimals)),
      quoteFeeAmountCollected: Number(formatTokenAmount(details.tokensOwed1.toString(), token1.decimals)),
    },
  };
}

async function requireWallet(_ethereum: Ethereum): Promise<string> {
  const addr = await Ethereum.getFirstWalletAddress();
  if (!addr) throw httpErrors.badRequest('No default wallet found');
  return addr;
}
