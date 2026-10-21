/**
 * Aerodrome Slipstream CLMM Position Lifecycle — anvil Base mainnet-fork test.
 *
 * Executes the full LP lifecycle against REAL Slipstream contracts on a forked
 * Base mainnet (zero risk, deterministic wallet):
 *   1. Open position with initial liquidity
 *   2. Add liquidity
 *   3. Remove liquidity (50%)
 *   4. Collect fees
 *   5. Close position (remove rest + burn NFT)
 *
 * Follows the repo lifecycle-test pattern (direct route-function calls,
 * skipped unless MANUAL_TEST=true) — see pancakeswap-sol-position-lifecycle.
 *
 * Topology: this jest run and `anvil` both live in the same container/network;
 * gateway's ethereum-base network must point at the anvil RPC.
 *
 * Run (one line, from repo root, inside the node:22 container):
 *   MANUAL_TEST=true GATEWAY_TEST_MODE=dev ANVIL_FORK_RPC=http://127.0.0.1:8545 \
 *   GATEWAY_PASSPHRASE=<passphrase> pnpm exec jest --runInBand \
 *   test/lifecycle/aerodrome-slipstream-position-lifecycle.test.ts
 *
 * Harness (starts anvil + funds the test wallet first):
 *   tests/connector-e2e/run-lifecycle.sh  (from the HummingLP monorepo)
 */
import { ethers } from 'ethers';

// Anvil deterministic account #0 (well-known, fork-only — never fund on mainnet)
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const TEST_CONFIG = {
  network: 'base', // gateway network name for ethereum-base
  // WETH/USDC Slipstream pool — resolved live from the gauges-v3 factory
  // (falls back to SLIPSTREAM_POOL env if set)
  poolAddress: process.env.SLIPSTREAM_POOL || '',
  tickSpacing: Number(process.env.SLIPSTREAM_TICK_SPACING || 10), // fork-verified tier for gauges-v3 WETH/USDC
  // Wide range around WETH/USDC to stay in-range through the test
  lowerPrice: 1500,
  upperPrice: 4500,
  baseTokenAmount: 0.001, // WETH
  quoteTokenAmount: 4, // USDC
  slippagePct: 2,
};

const describeTest = process.env.MANUAL_TEST === 'true' ? describe : describe.skip;

describeTest('Aerodrome Slipstream CLMM Position Lifecycle — ANVIL FORK', () => {
  let walletAddress: string;
  let positionAddress: string;
  const forkRpc = process.env.ANVIL_FORK_RPC || 'http://127.0.0.1:8545';

  beforeAll(async () => {
    // Direct provider over the fork for funding; gateway's own network config
    // (ethereum-base -> nodeURL) must point at the same fork RPC.
    const provider = new ethers.providers.JsonRpcProvider(forkRpc);
    const wallet = new ethers.Wallet(ANVIL_PK, provider);
    walletAddress = wallet.address;

    // Fork-only: bypass gateway's encrypted wallet store — routes receive the
    // deterministic anvil signer directly. What the fork validates is route
    // logic (params, calldata, event decoding); keystore handling is gateway's
    // own tested machinery and stays out of scope here.
    const { Ethereum } = await import('../../src/chains/ethereum/ethereum');
    const ethInstance = await Ethereum.getInstance(TEST_CONFIG.network);
    const forkWallet = new ethers.Wallet(ANVIL_PK, ethInstance.provider);
    jest.spyOn(ethInstance, 'getWallet').mockResolvedValue(forkWallet as any);
    jest.spyOn(ethInstance, 'ready').mockReturnValue(true);

    // Resolve the WETH/USDC Slipstream pool from the latest factory
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    if (!TEST_CONFIG.poolAddress) {
      const { getGeneration } = await import('../../src/connectors/aerodrome/aerodrome.constants');
      const factory = new ethers.Contract(
        getGeneration('gauges-v3').poolFactory,
        ['function getPool(address,address,int24) view returns (address)'],
        provider,
      );
      // token0/token1 order is sorted by address; getPool is order-insensitive.
      // Fork-verified 2026-10-21: gauges-v3 WETH/USDC exists at spacing 10.
      TEST_CONFIG.poolAddress = await factory.getPool(WETH, USDC, TEST_CONFIG.tickSpacing);
      console.log(`Resolved Slipstream WETH/USDC (spacing ${TEST_CONFIG.tickSpacing}): ${TEST_CONFIG.poolAddress}`);
    }
    expect(TEST_CONFIG.poolAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Impersonate a WETH-rich account and fund the test wallet
    // (anvil_impersonateAccount + transfer). Whale: Base WETH holder.
    const whale = process.env.WETH_WHALE || '0x0000000000000000000000000000000000000000';
    if (whale !== '0x0000000000000000000000000000000000000000') {
      await provider.send('anvil_impersonateAccount', [whale]);
      const whaleProvider = new ethers.providers.JsonRpcProvider(forkRpc);
      const wethContract = new ethers.Contract(
        WETH,
        ['function transfer(address to, uint256 amount) returns (bool)'],
        await provider.getSigner(whale) as any,
      );
      await wethContract.transfer(walletAddress, ethers.utils.parseEther('1'));
      void whaleProvider;
    }
  });

  it('step 1: opens a new Slipstream position', async () => {
    const { openPosition } = await import('../../src/connectors/aerodrome/clmm-routes/openPosition');
    const result = await openPosition(
      TEST_CONFIG.network,
      walletAddress,
      TEST_CONFIG.lowerPrice,
      TEST_CONFIG.upperPrice,
      TEST_CONFIG.poolAddress,
      TEST_CONFIG.baseTokenAmount,
      TEST_CONFIG.quoteTokenAmount,
      TEST_CONFIG.slippagePct,
    );
    expect(result.status).toBe(2); // TransactionStatus.CONFIRMED
    positionAddress = (result as any).data?.positionAddress ?? (result as any).positionAddress;
    expect(positionAddress).toBeTruthy();
  });

  it('step 2: adds liquidity', async () => {
    const { addLiquidity } = await import('../../src/connectors/aerodrome/clmm-routes/addLiquidity');
    const result = await addLiquidity(
      TEST_CONFIG.network,
      walletAddress,
      positionAddress,
      TEST_CONFIG.baseTokenAmount / 2,
      TEST_CONFIG.quoteTokenAmount / 2,
      TEST_CONFIG.slippagePct,
    );
    expect(result.status).toBe(2);
  });

  it('step 3: removes 50% of liquidity', async () => {
    const { removeLiquidity } = await import('../../src/connectors/aerodrome/clmm-routes/removeLiquidity');
    const result = await removeLiquidity(
      TEST_CONFIG.network,
      walletAddress,
      positionAddress,
      50,
      TEST_CONFIG.slippagePct,
    );
    expect(result.status).toBe(2);
  });

  it('step 4: collects fees (may be zero on a fresh fork)', async () => {
    const { collectFees } = await import('../../src/connectors/aerodrome/clmm-routes/collectFees');
    const result = await collectFees(TEST_CONFIG.network, walletAddress, positionAddress);
    expect(result.status).toBe(2);
  });

  it('step 5: closes the position (remove rest + burn)', async () => {
    const { closePosition } = await import('../../src/connectors/aerodrome/clmm-routes/closePosition');
    const result = await closePosition(TEST_CONFIG.network, walletAddress, positionAddress);
    expect(result.status).toBe(2);
  });
});
