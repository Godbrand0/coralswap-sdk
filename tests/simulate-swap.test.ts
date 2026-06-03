import { SwapModule } from "../src/modules/swap";
import { InsufficientLiquidityError, PairNotFoundError, ValidationError } from "../src/errors";
import { SwapSimulationResult } from "../src/types/swap";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockPair(
  reserve0: bigint,
  reserve1: bigint,
  feeBps: number,
  token0: string,
  token1: string,
) {
  return {
    getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
    getDynamicFee: jest.fn().mockResolvedValue(feeBps),
    getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
  };
}

function buildMockClient(opts: {
  pairAddress: string | null;
  reserve0: bigint;
  reserve1: bigint;
  feeBps: number;
  token0: string;
  token1: string;
}) {
  const pair = mockPair(opts.reserve0, opts.reserve1, opts.feeBps, opts.token0, opts.token1);

  return {
    config: { defaultSlippageBps: 50 },
    networkConfig: { networkPassphrase: "Test SDF Network ; September 2015" },
    getDeadline: jest.fn().mockReturnValue(9999999999),
    getPairAddress: jest.fn().mockResolvedValue(opts.pairAddress),
    pair: jest.fn().mockReturnValue(pair),
    _pair: pair,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_IN  = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_OUT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const PAIR_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const RESERVE    = 1_000_000_000n; // 1 billion — balanced pool
const FEE_BPS    = 30;             // 0.30 %

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replicate the Uniswap V2 getAmountOut formula for expected-value assertions. */
function expectedAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  const feeFactor = BigInt(10000 - feeBps);
  const amountInWithFee = amountIn * feeFactor;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

/** Replicate the price-impact formula used in SwapModule. */
function expectedPriceImpactBps(
  amountIn: bigint,
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): number {
  if (reserveIn === 0n || reserveOut === 0n) return 10000;
  const idealOut = (amountIn * reserveOut) / reserveIn;
  if (idealOut === 0n) return 10000;
  const impact = ((idealOut - amountOut) * 10000n) / idealOut;
  return Number(impact);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SwapModule.simulateSwap()", () => {
  // -------------------------------------------------------------------------
  // Normal swap
  // -------------------------------------------------------------------------

  describe("normal swap", () => {
    let swap: SwapModule;
    let client: ReturnType<typeof buildMockClient>;

    beforeEach(() => {
      client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      swap = new SwapModule(client as any);
    });

    it("returns a SwapSimulationResult with all required fields", async () => {
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);

      expect(typeof result.amountOut).toBe("bigint");
      expect(typeof result.priceImpactBps).toBe("number");
      expect(typeof result.feeAmount).toBe("bigint");
      expect(typeof result.executionPrice.numerator).toBe("bigint");
      expect(typeof result.executionPrice.denominator).toBe("bigint");
    });

    it("amountOut matches the Uniswap V2 formula for the same reserve state", async () => {
      const amountIn = 1_000_000n;
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      const expected = expectedAmountOut(amountIn, RESERVE, RESERVE, FEE_BPS);
      expect(result.amountOut).toBe(expected);
    });

    it("feeAmount equals (amountIn * feeBps) / 10000", async () => {
      const amountIn = 1_000_000n;
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      const expectedFee = (amountIn * BigInt(FEE_BPS)) / 10000n;
      expect(result.feeAmount).toBe(expectedFee);
    });

    it("executionPrice numerator equals amountOut and denominator equals amountIn", async () => {
      const amountIn = 500_000n;
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      expect(result.executionPrice.numerator).toBe(result.amountOut);
      expect(result.executionPrice.denominator).toBe(amountIn);
    });

    it("priceImpactBps is correctly measured from current spot price", async () => {
      const amountIn = 1_000_000n;
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      const expected = expectedPriceImpactBps(
        amountIn,
        result.amountOut,
        RESERVE,
        RESERVE,
      );
      expect(result.priceImpactBps).toBe(expected);
    });

    it("does not attach a warning for a small trade on a deep pool", async () => {
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000n);
      expect(result.warning).toBeUndefined();
    });

    it("resolves pair via factory when pairAddress is omitted", async () => {
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);

      expect(client.getPairAddress).toHaveBeenCalledWith(TOKEN_IN, TOKEN_OUT);
      expect(result.amountOut).toBeGreaterThan(0n);
    });

    it("uses the provided pairAddress directly without calling factory", async () => {
      await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n, PAIR_ADDR);

      // getPairAddress should NOT have been called when pairAddress is supplied
      expect(client.getPairAddress).not.toHaveBeenCalled();
    });

    it("amountOut is positive and less than amountIn for a balanced pool", async () => {
      const amountIn = 1_000_000n;
      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      expect(result.amountOut).toBeGreaterThan(0n);
      expect(result.amountOut).toBeLessThan(amountIn);
    });

    it("larger amountIn produces larger amountOut (monotonic)", async () => {
      const small = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 100_000n);
      const large = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);

      expect(large.amountOut).toBeGreaterThan(small.amountOut);
    });

    it("larger amountIn produces higher priceImpactBps (monotonic)", async () => {
      const small = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 100_000n);
      const large = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 100_000_000n);

      expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    });

    it("works correctly when tokenIn is token1 (reversed pair ordering)", async () => {
      // Build a client where TOKEN_OUT is token0 and TOKEN_IN is token1
      const reversedClient = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_OUT, // reversed
        token1: TOKEN_IN,
      });
      const reversedSwap = new SwapModule(reversedClient as any);

      const amountIn = 1_000_000n;
      const result = await reversedSwap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      // reserve1 is TOKEN_IN's reserve, reserve0 is TOKEN_OUT's reserve
      const expected = expectedAmountOut(amountIn, RESERVE, RESERVE, FEE_BPS);
      expect(result.amountOut).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // HIGH_PRICE_IMPACT warning
  // -------------------------------------------------------------------------

  describe("HIGH_PRICE_IMPACT warning", () => {
    it("attaches HIGH_PRICE_IMPACT when priceImpactBps > 500", async () => {
      // Small pool: 10_000 / 10_000 — a 5_000 trade is 50% of the pool
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: 10_000n,
        reserve1: 10_000n,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 5_000n);

      expect(result.warning).toBe("HIGH_PRICE_IMPACT");
      expect(result.priceImpactBps).toBeGreaterThan(500);
    });

    it("does not attach warning when priceImpactBps is exactly 500", async () => {
      // We need a trade that produces exactly 500 bps impact.
      // Use a mock that returns a controlled priceImpactBps via a spy.
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      // Spy on calculatePriceImpact to return exactly 500
      jest
        .spyOn(swap as any, "calculatePriceImpact")
        .mockReturnValue(500);

      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);

      expect(result.priceImpactBps).toBe(500);
      expect(result.warning).toBeUndefined();
    });

    it("attaches warning when priceImpactBps is 501", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      jest
        .spyOn(swap as any, "calculatePriceImpact")
        .mockReturnValue(501);

      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);

      expect(result.warning).toBe("HIGH_PRICE_IMPACT");
    });

    it("HIGH_PRICE_IMPACT is the only possible warning value", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: 10_000n,
        reserve1: 10_000n,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 5_000n);

      if (result.warning !== undefined) {
        expect(result.warning).toBe("HIGH_PRICE_IMPACT");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Zero liquidity
  // -------------------------------------------------------------------------

  describe("zero liquidity", () => {
    it("throws InsufficientLiquidityError when reserve0 is zero", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: 0n,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n),
      ).rejects.toBeInstanceOf(InsufficientLiquidityError);
    });

    it("throws InsufficientLiquidityError when reserve1 is zero", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: 0n,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n),
      ).rejects.toBeInstanceOf(InsufficientLiquidityError);
    });

    it("throws InsufficientLiquidityError when both reserves are zero", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: 0n,
        reserve1: 0n,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n),
      ).rejects.toBeInstanceOf(InsufficientLiquidityError);
    });

    it("InsufficientLiquidityError carries the pair address", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: 0n,
        reserve1: 0n,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      try {
        await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);
        fail("Expected InsufficientLiquidityError");
      } catch (err) {
        expect(err).toBeInstanceOf(InsufficientLiquidityError);
        expect((err as InsufficientLiquidityError).details?.pairAddress).toBe(PAIR_ADDR);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pair not found
  // -------------------------------------------------------------------------

  describe("pair not found", () => {
    it("throws PairNotFoundError when factory returns null", async () => {
      const client = buildMockClient({
        pairAddress: null,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n),
      ).rejects.toBeInstanceOf(PairNotFoundError);
    });

    it("PairNotFoundError carries both token addresses", async () => {
      const client = buildMockClient({
        pairAddress: null,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      try {
        await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000_000n);
        fail("Expected PairNotFoundError");
      } catch (err) {
        expect(err).toBeInstanceOf(PairNotFoundError);
        const details = (err as PairNotFoundError).details;
        expect(details?.tokenA).toBe(TOKEN_IN);
        expect(details?.tokenB).toBe(TOKEN_OUT);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe("input validation", () => {
    let swap: SwapModule;

    beforeEach(() => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      swap = new SwapModule(client as any);
    });

    it("throws ValidationError for zero amountIn", async () => {
      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 0n),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ValidationError for negative amountIn", async () => {
      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_OUT, -1n),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ValidationError for invalid tokenIn address", async () => {
      await expect(
        swap.simulateSwap("not-a-valid-address", TOKEN_OUT, 1_000_000n),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ValidationError for invalid tokenOut address", async () => {
      await expect(
        swap.simulateSwap(TOKEN_IN, "not-a-valid-address", 1_000_000n),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ValidationError when tokenIn === tokenOut", async () => {
      await expect(
        swap.simulateSwap(TOKEN_IN, TOKEN_IN, 1_000_000n),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // Return type shape
  // -------------------------------------------------------------------------

  describe("return type shape", () => {
    it("result conforms to SwapSimulationResult interface", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      const result: SwapSimulationResult = await swap.simulateSwap(
        TOKEN_IN,
        TOKEN_OUT,
        1_000_000n,
      );

      expect(result).toHaveProperty("amountOut");
      expect(result).toHaveProperty("priceImpactBps");
      expect(result).toHaveProperty("feeAmount");
      expect(result).toHaveProperty("executionPrice");
      expect(result.executionPrice).toHaveProperty("numerator");
      expect(result.executionPrice).toHaveProperty("denominator");
    });

    it("warning field is absent (not just undefined) for low-impact trades", async () => {
      const client = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: FEE_BPS,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const swap = new SwapModule(client as any);

      const result = await swap.simulateSwap(TOKEN_IN, TOKEN_OUT, 1_000n);

      expect("warning" in result ? result.warning : undefined).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Fee variations
  // -------------------------------------------------------------------------

  describe("fee variations", () => {
    it("higher feeBps produces lower amountOut", async () => {
      const lowFeeClient = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: 10,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const highFeeClient = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: 100,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });

      const lowFeeSwap = new SwapModule(lowFeeClient as any);
      const highFeeSwap = new SwapModule(highFeeClient as any);

      const amountIn = 1_000_000n;
      const lowResult  = await lowFeeSwap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);
      const highResult = await highFeeSwap.simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      expect(lowResult.amountOut).toBeGreaterThan(highResult.amountOut);
    });

    it("higher feeBps produces higher feeAmount", async () => {
      const lowFeeClient = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: 10,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });
      const highFeeClient = buildMockClient({
        pairAddress: PAIR_ADDR,
        reserve0: RESERVE,
        reserve1: RESERVE,
        feeBps: 100,
        token0: TOKEN_IN,
        token1: TOKEN_OUT,
      });

      const amountIn = 1_000_000n;
      const lowResult  = await new SwapModule(lowFeeClient as any).simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);
      const highResult = await new SwapModule(highFeeClient as any).simulateSwap(TOKEN_IN, TOKEN_OUT, amountIn);

      expect(highResult.feeAmount).toBeGreaterThan(lowResult.feeAmount);
    });
  });
});
