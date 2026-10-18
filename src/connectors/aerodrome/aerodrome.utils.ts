/**
 * Aerodrome Slipstream utils.
 *
 * Math strategy: Slipstream is a UNIv3-core fork — same Q64.96 sqrtP, same
 * tick grid, same liquidity arithmetic. Gateway already depends on
 * @uniswap/v3-sdk (^3.31.0) and @uniswap/sdk-core (^7.18.0) for the uniswap
 * connector; their TickMath/SqrtPriceMath are pure chain-agnostic functions.
 * We WRAP them rather than re-deriving magic constants by hand (a from-memory
 * port of the constant chain is exactly how silent amount-math bugs happen).
 *
 * Hand-rolled parts are ONLY the Slipstream-specific bits:
 *  - pool identity is (token0, token1, tickSpacing): NO static fee field in
 *    mint(); swap fees are dynamic (CustomSwapFeeModule / DynamicSwapFeeModule)
 *  - PositionManager calldata (see abis/)
 */
import JSBI from 'jsbi';
import { Percent, Token, CurrencyAmount } from '@uniswap/sdk-core';
import {
  TickMath,
  SqrtPriceMath,
  LiquidityMath,
  Position as UniV3Position,
  Pool as UniV3Pool,
  nearestUsableTick,
  FeeAmount,
} from '@uniswap/v3-sdk';

export { nearestUsableTick };
export const MIN_TICK = TickMath.MIN_TICK;
export const MAX_TICK = TickMath.MAX_TICK;
export const MIN_SQRT_RATIO = TickMath.MIN_SQRT_RATIO;
export const MAX_SQRT_RATIO = TickMath.MAX_SQRT_RATIO;

// ---------------------------------------------------------------------------
// Price <-> tick
// ---------------------------------------------------------------------------

/** Human price -> containing tick (floor), decimals-adjusted. Identical
 * convention to the uniswap clmm-routes priceToTickWithDecimals. */
export function priceToTick(
  humanPrice: number,
  decimals0: number,
  decimals1: number,
): number {
  if (!(humanPrice > 0)) {
    throw new Error(`price must be > 0, got ${humanPrice}`);
  }
  const rawPrice = humanPrice * Math.pow(10, decimals1 - decimals0);
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001));
}

/** Tick -> decimals-adjusted human price. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  const rawPrice = Math.pow(1.0001, tick);
  return rawPrice / Math.pow(10, decimals1 - decimals0);
}

export function getSqrtRatioAtTick(tick: number): JSBI {
  return TickMath.getSqrtRatioAtTick(tick);
}

export function getTickAtSqrtRatio(sqrtRatioX96: JSBI): number {
  return TickMath.getTickAtSqrtRatio(sqrtRatioX96);
}

// ---------------------------------------------------------------------------
// Amounts <-> liquidity (thin wrappers over v3-sdk SqrtPriceMath)
// ---------------------------------------------------------------------------

export function getAmount0Delta(
  sqrtA: JSBI,
  sqrtB: JSBI,
  liquidity: JSBI,
  roundUp = true,
): JSBI {
  return SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp);
}

export function getAmount1Delta(
  sqrtA: JSBI,
  sqrtB: JSBI,
  liquidity: JSBI,
  roundUp = true,
): JSBI {
  return SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp);
}

export function maxLiquidityForAmounts(
  sqrtRatioCurrentX96: JSBI,
  sqrtA: JSBI,
  sqrtB: JSBI,
  amount0: JSBI,
  amount1: JSBI,
): JSBI {
  return SqrtPriceMath.maxLiquidityForAmounts(
    sqrtRatioCurrentX96,
    sqrtA,
    sqrtB,
    amount0,
    amount1,
  );
}

export function addLiquidityDelta(current: JSBI, delta: JSBI): JSBI {
  return LiquidityMath.addDelta(current, delta);
}

// ---------------------------------------------------------------------------
// Slipstream pool position math via v3-sdk Pool/Position
// ---------------------------------------------------------------------------

export interface SlipstreamPoolState {
  token0: Token;
  token1: Token;
  sqrtPriceX96: JSBI;
  liquidity: JSBI;
  tickCurrent: number;
  tickSpacing: number; // Slipstream identity field (replaces UNIv3 fee)
}

/** Build a v3-sdk Pool view over Slipstream state. `fee` is cosmetic here —
 * Slipstream fees are dynamic; we pass the closest FeeAmount for sdk shape
 * compatibility only and never use pool.fee for accounting. */
export function toV3SdkPool(state: SlipstreamPoolState): UniV3Pool {
  return new UniV3Pool(
    state.token0,
    state.token1,
    nearestFeeAmountForSpacing(state.tickSpacing),
    state.sqrtPriceX96,
    state.liquidity,
    state.tickCurrent,
  );
}

/** Position amounts for a range given one-side amounts — mirrors the
 * uniswap openPosition.ts flow (Position.fromAmounts) but over Slipstream
 * state. Slippage mins are derived by the caller from slippagePct. */
export function buildPositionFromAmounts(
  state: SlipstreamPoolState,
  tickLower: number,
  tickUpper: number,
  amount0: CurrencyAmount<Token>,
  amount1: CurrencyAmount<Token>,
): UniV3Position {
  return UniV3Position.fromAmounts({
    pool: toV3SdkPool(state),
    tickLower,
    tickUpper,
    amount0: amount0.quotient,
    amount1: amount1.quotient,
    useFullPrecision: true,
  });
}

/** Derive amount0Min/amount1Min from desired amounts and slippage pct —
 * same convention as uniswap routes (Percent in bps of 10000). */
export function applySlippage(
  desired: CurrencyAmount<Token>,
  slippagePct: number,
): CurrencyAmount<Token> {
  const tolerance = new Percent(Math.floor(slippagePct * 100), 10_000);
  return desired.subtract(desired.multiply(tolerance) as CurrencyAmount<Token>);
}

// ---------------------------------------------------------------------------
// Slipstream specifics
// ---------------------------------------------------------------------------

/** Map tickSpacing to a cosmetic FeeAmount for v3-sdk Pool construction. */
export function nearestFeeAmountForSpacing(tickSpacing: number): FeeAmount {
  switch (tickSpacing) {
    case 1:
      return FeeAmount.LOWEST; // 100  (0.01%)
    case 10:
      return FeeAmount.LOW; //   500  (0.05%)
    case 60:
      return FeeAmount.MEDIUM; // 3000 (0.30%)
    case 200:
      return FeeAmount.HIGH; //  10000 (1.00%)
    default:
      return FeeAmount.MEDIUM;
  }
}

/** Format raw onchain amount to human number (display/logging only). */
export function formatTokenAmount(raw: JSBI | string, decimals: number): string {
  const s = raw.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, '0');
  const int = padded.slice(0, padded.length - decimals) || '0';
  const frac = decimals > 0 ? '.' + padded.slice(padded.length - decimals) : '';
  return (neg ? '-' : '') + int + frac;
}
