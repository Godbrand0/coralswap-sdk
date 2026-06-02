import { z } from 'zod';
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Address,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import { Network } from '@/types/common';
import { Token, TokenList } from '@/types/tokens';
import { DEFAULTS } from '@/config';
import { withRetry, RetryOptions } from '@/utils/retry';
import { NetworkError, ValidationError, TokenFetchError } from '@/errors';

/**
 * Well-known zero account used as the source for read-only simulations.
 * Holds no funds, so no signer is required to read on-chain token state.
 */
const READ_ONLY_SOURCE_ACCOUNT =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

// ---------------------------------------------------------------------------
// Zod schemas — validates token list JSON against Stellar token list standard
// ---------------------------------------------------------------------------

const NetworkSchema = z.nativeEnum(Network);

const TokenSchema = z.object({
  address: z.string().min(1),
  name: z.string().min(1),
  symbol: z.string().min(1).max(12),
  decimals: z.number().int().nonnegative().max(18),
  network: NetworkSchema,
  logoURI: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
});

const TokenListVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
});

const TokenListSchema = z.object({
  name: z.string().min(1),
  version: TokenListVersionSchema,
  timestamp: z.string().optional(),
  tokens: z.array(TokenSchema),
});

// ---------------------------------------------------------------------------
// TokenListModule
// ---------------------------------------------------------------------------

/**
 * Helper module for fetching, validating and filtering Stellar token lists.
 *
 * Token lists follow a JSON schema similar to the Uniswap Token List standard
 * adapted for Stellar/Soroban, with network-aware filtering (Mainnet/Testnet).
 *
 * @example
 * ```ts
 * const tokens = client.tokens();
 * const list = await tokens.fetch('https://example.com/tokenlist.json');
 * console.log(list.tokens); // Token[] filtered to current network
 * ```
 */
export class TokenListModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Fetch a token list from a URL, validate the schema, and return only
   * the tokens matching the client's current network.
   *
   * @param url - URL pointing to a token list JSON.
   * @returns A validated TokenList with tokens filtered by network.
   * @throws {NetworkError} If the fetch request fails.
   * @throws {ValidationError} If the JSON does not match the expected schema.
   */
  async fetch(url: string): Promise<TokenList> {
    const raw = await this.fetchJson(url);
    const list = this.validate(raw);
    return {
      ...list,
      tokens: this.filterByNetwork(list.tokens, this.client.network),
    };
  }

  /**
   * Fetch a token list and return all tokens without network filtering.
   *
   * @param url - URL pointing to a token list JSON.
   * @returns A validated TokenList containing tokens for all networks.
   */
  async fetchAll(url: string): Promise<TokenList> {
    const raw = await this.fetchJson(url);
    return this.validate(raw);
  }

  /**
   * Validate raw JSON data against the token list Zod schema.
   *
   * @param data - Parsed JSON object to validate.
   * @returns A typed TokenList.
   * @throws {ValidationError} If the schema check fails.
   */
  validate(data: unknown): TokenList {
    const result = TokenListSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ValidationError(`Invalid token list schema: ${issues}`, {
        zodErrors: result.error.issues,
      });
    }
    return result.data;
  }

  /**
   * Filter a token array to only include entries matching a given network.
   *
   * @param tokens - Full token array.
   * @param network - Target network to filter by.
   * @returns Tokens belonging to the specified network.
   */
  filterByNetwork(tokens: Token[], network: Network): Token[] {
    return tokens.filter((t) => t.network === network);
  }

  /**
   * Search tokens by symbol or name (case-insensitive).
   *
   * @param tokens - Token array to search.
   * @param query - Search string to match against symbol or name.
   * @returns Matching tokens.
   */
  search(tokens: Token[], query: string): Token[] {
    const q = query.toLowerCase();
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q),
    );
  }

  /**
   * Find a single token by its contract address.
   *
   * @param tokens - Token array to search.
   * @param address - Contract address or asset identifier.
   * @returns The matching token, or undefined.
   */
  findByAddress(tokens: Token[], address: string): Token | undefined {
    return tokens.find((t) => t.address === address);
  }

  /**
   * Filter tokens by a specific tag.
   *
   * @param tokens - Token array to filter.
   * @param tag - The tag to look for (e.g. "stablecoin").
   * @returns Tokens containing the specified tag.
   */
  filterByTag(tokens: Token[], tag: string): Token[] {
    return tokens.filter((t) => t.tags?.includes(tag));
  }

  /**
   * Filter tokens that match ALL specified tags.
   *
   * @param tokens - Token array to filter.
   * @param tags - List of tags that must all be present.
   * @returns Tokens containing all the specified tags.
   */
  filterByTags(tokens: Token[], tags: string[]): Token[] {
    return tokens.filter((t) => tags.every((tag) => t.tags?.includes(tag)));
  }

  // -------------------------------------------------------------------------
  // On-chain reads (SEP-41 token contract)
  // -------------------------------------------------------------------------

  /**
   * Fetch the on-chain token balance for an account.
   *
   * Performs a read-only simulation of the SEP-41 `balance` function using the
   * client's configured RPC endpoint. No signer or funded account is required.
   *
   * @param tokenAddress - Contract address of the token (SEP-41/SAC).
   * @param accountAddress - Stellar address whose balance to query.
   * @returns The balance in raw stroop units (i128) as a `bigint`.
   * @throws {TokenFetchError} If the RPC call or simulation fails.
   *
   * @example
   * ```ts
   * const tokens = client.tokens();
   * const balance = await tokens.getBalance('CDLZ...', 'GABC...');
   * ```
   */
  async getBalance(
    tokenAddress: string,
    accountAddress: string,
  ): Promise<bigint> {
    const contract = new Contract(tokenAddress);
    const op = contract.call(
      'balance',
      nativeToScVal(Address.fromString(accountAddress), { type: 'address' }),
    );
    const result = await this.simulateRead(op, 'getBalance', {
      tokenAddress,
      accountAddress,
    });
    return result ? this.scValToBigInt(result) : 0n;
  }

  /**
   * Fetch the on-chain allowance a spender has over an owner's tokens.
   *
   * Performs a read-only simulation of the SEP-41 `allowance` function using
   * the client's configured RPC endpoint. No signer is required.
   *
   * @param tokenAddress - Contract address of the token (SEP-41/SAC).
   * @param owner - Address that owns the tokens.
   * @param spender - Address approved to spend on behalf of `owner`.
   * @returns The approved allowance in raw stroop units (i128) as a `bigint`.
   * @throws {TokenFetchError} If the RPC call or simulation fails.
   *
   * @example
   * ```ts
   * const tokens = client.tokens();
   * const allowance = await tokens.getAllowance('CDLZ...', 'GOWN...', 'GSPN...');
   * ```
   */
  async getAllowance(
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    const contract = new Contract(tokenAddress);
    const op = contract.call(
      'allowance',
      nativeToScVal(Address.fromString(owner), { type: 'address' }),
      nativeToScVal(Address.fromString(spender), { type: 'address' }),
    );
    const result = await this.simulateRead(op, 'getAllowance', {
      tokenAddress,
      owner,
      spender,
    });
    return result ? this.scValToBigInt(result) : 0n;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Simulate a read-only contract call and return its `ScVal` result.
   *
   * Uses a well-known zero-balance account as the source so no funds or signer
   * are required, and reuses the client's RPC server, network passphrase and
   * retry configuration. Any failure is wrapped in a {@link TokenFetchError}.
   *
   * @param op - The contract operation to simulate.
   * @param label - A label used for retry/logging context.
   * @param context - Additional context attached to a thrown error.
   * @returns The `ScVal` return value, or `null` if the simulation had none.
   */
  private async simulateRead(
    op: xdr.Operation,
    label: string,
    context: Record<string, unknown>,
  ): Promise<xdr.ScVal | null> {
    const retryOptions = this.getRetryOptions();
    try {
      const account = await withRetry(
        () => this.client.server.getAccount(READ_ONLY_SOURCE_ACCOUNT),
        retryOptions,
        undefined,
        `tokens.${label}_getAccount`,
      );

      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.client.networkConfig.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const sim = await withRetry(
        () => this.client.server.simulateTransaction(tx),
        retryOptions,
        undefined,
        `tokens.${label}_simulate`,
      );

      if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
        const errorMessage =
          (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error ??
          'simulation did not succeed';
        throw new TokenFetchError(
          `Failed to fetch token data (${label}): ${errorMessage}`,
          { ...context, simulation: sim },
        );
      }

      return sim.result ? sim.result.retval : null;
    } catch (err) {
      if (err instanceof TokenFetchError) throw err;
      throw new TokenFetchError(
        `Failed to fetch token data (${label}): ${err instanceof Error ? err.message : String(err)}`,
        { ...context, cause: err },
      );
    }
  }

  /**
   * Decode an i128 `ScVal` into a `bigint`.
   */
  private scValToBigInt(val: xdr.ScVal): bigint {
    const parts = val.i128();
    return (
      BigInt(parts.lo().toString()) + (BigInt(parts.hi().toString()) << 64n)
    );
  }

  /**
   * Build retry options from the client's configuration, falling back to
   * SDK defaults for any unset values.
   */
  private getRetryOptions(): RetryOptions {
    const config = this.client.config;
    return {
      maxRetries: config?.maxRetries ?? DEFAULTS.maxRetries,
      retryDelayMs: config?.retryDelayMs ?? DEFAULTS.retryDelayMs,
      maxRetryDelayMs: config?.maxRetryDelayMs ?? DEFAULTS.maxRetryDelayMs,
    };
  }

  /**
   * Perform a GET request and parse the response as JSON.
   */
  private async fetchJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new NetworkError(
        `Failed to fetch token list from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { url },
      );
    }

    if (!response.ok) {
      throw new NetworkError(
        `Token list request failed with HTTP ${response.status}`,
        { url, status: response.status },
      );
    }

    try {
      return await response.json();
    } catch {
      throw new ValidationError('Token list response is not valid JSON', {
        url,
      });
    }
  }
}
