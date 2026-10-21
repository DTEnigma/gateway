/**
 * Aerodrome Slipstream connector — singleton per network, mirroring the
 * Uniswap connector's structure (gateway v2.17 conventions).
 *
 * Scope: CLMM (Slipstream) only; standard AMM pools are doc 03 phase 2.
 * Handles THREE contract generations (see aerodrome.constants.ts).
 */
import { Token } from '@uniswap/sdk-core';
import { Contract } from 'ethers';

import { Ethereum, TokenInfo } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';

import {
  nonfungiblePositionManagerABI,
  poolABI,
  poolFactoryABI,
} from './aerodrome.abis';
import { AerodromeConfig } from './aerodrome.config';
import {
  SlipstreamGeneration,
  getGeneration,
  slipstreamGenerations,
} from './aerodrome.constants';

/** Runtime handles for one Slipstream generation. */
interface GenerationContracts {
  npm: Contract; // NonfungiblePositionManager
  factory: Contract; // PoolFactory
}

export class Aerodrome {
  private static _instances: { [network: string]: Aerodrome };

  private ethereum: Ethereum;
  public config: AerodromeConfig.RootConfig;
  private chainId: number;
  private _ready = false;
  private networkName: string;

  /** One contract set per Slipstream generation (initial, gauge-caps, gauges-v3). */
  private generations: Record<string, GenerationContracts> = {};

  private constructor(network: string) {
    this.networkName = network;
    this.config = AerodromeConfig.config;
  }

  public static async getInstance(network: string): Promise<Aerodrome> {
    if (Aerodrome._instances === undefined) {
      Aerodrome._instances = {};
    }
    if (!(network in Aerodrome._instances)) {
      Aerodrome._instances[network] = new Aerodrome(network);
      await Aerodrome._instances[network].init();
    }
    return Aerodrome._instances[network];
  }

  public async init(): Promise<void> {
    try {
      this.ethereum = await Ethereum.getInstance(this.networkName);
      this.chainId = this.ethereum.chainId;

      for (const gen of slipstreamGenerations) {
        this.generations[gen.name] = {
          npm: new Contract(
            gen.nonfungiblePositionManager,
            nonfungiblePositionManagerABI as any,
            this.ethereum.provider,
          ),
          factory: new Contract(
            gen.poolFactory,
            poolFactoryABI as any,
            this.ethereum.provider,
          ),
        };
      }

      this._ready = true;
      logger.info(`Aerodrome initialized on network: ${this.networkName}`);
    } catch (error) {
      logger.error(`Aerodrome initialization failed: ${error}`);
      throw error;
    }
  }

  public get ready(): boolean {
    return this._ready;
  }

  /** All generations with contract handles. */
  public getGenerations(): SlipstreamGeneration[] {
    return slipstreamGenerations;
  }

  /** Contract handles for a named generation (throws on unknown). */
  public getContracts(generation: string): GenerationContracts {
    const contracts = this.generations[generation];
    if (!contracts) {
      throw new Error(`Generation '${generation}' not initialized`);
    }
    return contracts;
  }

  /** Token metadata via the shared Ethereum chain layer. */
  public async getToken(address: string) {
    return this.ethereum.getToken(address);
  }

  /** Convert gateway TokenInfo -> v3-sdk Token (same as uniswap connector). */
  public getSdkToken(tokenInfo: TokenInfo): Token {
    return new Token(this.chainId, tokenInfo.address, tokenInfo.decimals, tokenInfo.symbol, tokenInfo.name);
  }

  /** First registered wallet (gateway-managed) — used when a route is called
   * without an explicit wallet address. */
  public async getFirstWalletAddress(): Promise<string | null> {
    try {
      return await Ethereum.getFirstWalletAddress();
    } catch (error) {
      logger.error(`Failed to get first wallet address: ${error}`);
      return null;
    }
  }

  /**
   * Read-only Slipstream pool state: immutables (token0/token1/tickSpacing),
   * slot0 (sqrtPriceX96/tick), liquidity. Iterates generations unless one is
   * named. Returns null if no pool exists for the pair+spacing.
   */
  public async getSlipstreamPool(
    tokenA: string,
    tokenB: string,
    tickSpacing: number,
    generation?: string,
  ): Promise<{
    address: string;
    token0: string;
    token1: string;
    tickSpacing: number;
    sqrtPriceX96: string;
    tick: number;
    liquidity: string;
    generation: string;
  } | null> {
    const gens = generation ? [getGeneration(generation)] : slipstreamGenerations;

    for (const gen of gens) {
      const { factory } = this.generations[gen.name];
      if (!factory) continue;

      const poolAddress: string = await factory.getPool(tokenA, tokenB, tickSpacing);
      if (!poolAddress || /^0x0+$/.test(poolAddress)) continue;

      const pool = new Contract(poolAddress, poolABI as any, this.ethereum.provider);
      // Real CLPool surface (fork-verified): separate getters, no immutables().
      const [token0Addr, token1Addr, spacing, slot0, liquidity] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.tickSpacing(),
        pool.slot0(),
        pool.liquidity(),
      ]);

      return {
        address: poolAddress,
        token0: token0Addr,
        token1: token1Addr,
        tickSpacing: Number(spacing),
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        tick: Number(slot0.tick),
        liquidity: liquidity.toString(),
        generation: gen.name,
      };
    }
    return null;
  }
}
