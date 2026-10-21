/**
 * Unit tests for Aerodrome Slipstream math utils — the pure, highest-value
 * layer. Values cross-checked against v3-sdk reference outputs.
 */
import JSBI from 'jsbi';
import { CurrencyAmount, Token } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';

import {
  MIN_TICK,
  MAX_TICK,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  nearestUsableTick,
  priceToTick,
  tickToPrice,
  toV3SdkPool,
  applySlippage,
  nearestFeeAmountForSpacing,
  formatTokenAmount,
} from '../../../src/connectors/aerodrome/aerodrome.utils';

const TOKEN0 = new Token(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC', 'USD Coin'); // Base USDC
const TOKEN1 = new Token(8453, '0x4200000000000000000000000000000000000006', 18, 'WETH', 'Wrapped Ether'); // Base WETH

describe('aerodrome.utils', () => {
  describe('tick math (v3-sdk TickMath parity)', () => {
    it('tick 0 -> sqrtPrice 2^96', () => {
      expect(getSqrtRatioAtTick(0).toString()).toBe(JSBI.BigInt(2 ** 96).toString());
    });

    it('round-trips tick -> sqrtPrice -> tick across the grid', () => {
      for (const tick of [-887220, -60, -1, 0, 1, 60, 12345, 887220]) {
        expect(getTickAtSqrtRatio(getSqrtRatioAtTick(tick))).toBe(tick);
      }
    });

    it('rejects out-of-range ticks', () => {
      expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow();
      expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow();
    });

    it('MIN/MAX sqrt ratios match v3-sdk constants', () => {
      expect(getSqrtRatioAtTick(MIN_TICK).toString()).toBe('4295128739');
      expect(getSqrtRatioAtTick(MAX_TICK).toString()).toBe('1461446703485210103287273052203988822378723970342');
    });
  });

  describe('priceToTick / tickToPrice', () => {
    it('decimals-adjusted round trip for USDC/WETH (6/18) within one tick', () => {
      // priceToTick floors to the containing tick, so the recovered price can
      // sit up to one tick (1bp) below the input. Relative tolerance, not
      // absolute digits, is the correct assertion.
      const p = 2000 * Math.pow(10, 6 - 18); // raw
      const tick = priceToTick(p, 6, 18);
      const back = tickToPrice(tick, 6, 18);
      expect(Math.abs(back - p) / p).toBeLessThan(0.0001); // < 1 tick
      expect(back).toBeLessThanOrEqual(p);
    });

    it('rejects non-positive prices', () => {
      expect(() => priceToTick(0, 18, 18)).toThrow();
      expect(() => priceToTick(-1, 18, 18)).toThrow();
    });
  });

  describe('nearestUsableTick', () => {
    it('snaps to spacing boundaries', () => {
      expect(nearestUsableTick(61, 60)).toBe(60);
      expect(nearestUsableTick(31, 60)).toBe(60); // rounds half away from zero
      expect(nearestUsableTick(-31, 60)).toBe(-60);
      expect(nearestUsableTick(7, 10)).toBe(10);
    });

    it('rejects invalid spacing and out-of-range snaps', () => {
      expect(() => nearestUsableTick(0, 0)).toThrow();
      // 887350 rounds to 887400 > MAX_TICK (887272) -> throws; note 887260
      // rounds to 887200 which is IN range (v3-sdk checks the rounded result).
      expect(() => nearestUsableTick(887350, 200)).toThrow();
      expect(() => nearestUsableTick(-887350, 200)).toThrow();
    });
  });

  describe('toV3SdkPool (Slipstream identity mapping)', () => {
    it('maps tickSpacing to the cosmetic FeeAmount and preserves SDK sort order', () => {
      const pool = toV3SdkPool({
        token0: TOKEN0,
        token1: TOKEN1,
        sqrtPriceX96: getSqrtRatioAtTick(0),
        liquidity: JSBI.BigInt(0),
        tickCurrent: 0,
        tickSpacing: 10,
      });
      expect(pool.fee).toBe(FeeAmount.LOW);
      expect(pool.tickSpacing).toBe(10);
      // v3-sdk Pool sorts by address: WETH (0x4200…) < USDC (0x8335…) on Base,
      // matching the on-chain Slipstream token0/token1 ordering from immutables().
      expect(pool.token0.address).toBe(TOKEN1.address);
      expect(pool.token1.address).toBe(TOKEN0.address);
    });

    it('known spacings map to their tiers', () => {
      expect(nearestFeeAmountForSpacing(1)).toBe(FeeAmount.LOWEST);
      expect(nearestFeeAmountForSpacing(10)).toBe(FeeAmount.LOW);
      expect(nearestFeeAmountForSpacing(60)).toBe(FeeAmount.MEDIUM);
      expect(nearestFeeAmountForSpacing(200)).toBe(FeeAmount.HIGH);
    });
  });

  describe('applySlippage', () => {
    it('subtracts the tolerance from the desired amount', () => {
      const desired = CurrencyAmount.fromRawAmount(TOKEN0, JSBI.BigInt(1000 * 10 ** 6)); // 1000 USDC
      const min = applySlippage(desired, 0.5); // 0.5%
      expect(Number(min.toExact())).toBeCloseTo(995, 5);
    });
  });

  describe('formatTokenAmount', () => {
    it('formats raw integers with decimals', () => {
      expect(formatTokenAmount('1234567890', 6)).toBe('1234.567890');
      expect(formatTokenAmount('0', 18)).toBe('0.000000000000000000');
    });

    it('handles values smaller than their decimals', () => {
      expect(formatTokenAmount('42', 6)).toBe('0.000042');
    });
  });
});
