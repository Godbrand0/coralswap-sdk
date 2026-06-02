import { Account, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { TokenListModule } from '../src/modules/tokens';
import { Network } from '../src/types/common';
import { ValidationError, NetworkError, TokenFetchError } from '../src/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN_LIST = {
  name: 'CoralSwap Default',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    {
      address: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 7,
      network: 'testnet',
      logoURI: 'https://example.com/usdc.png',
      tags: ['stablecoin', 'fiat-backed'],
    },
    {
      address: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K',
      name: 'Wrapped XLM',
      symbol: 'wXLM',
      decimals: 7,
      network: 'testnet',
      tags: ['native', 'wrapped'],
    },
    {
      address: 'CA1MAINNETADDRESS000000000000000000000000000000000000000',
      name: 'Mainnet USDC',
      symbol: 'USDC',
      decimals: 7,
      network: 'mainnet',
      tags: ['stablecoin'],
    },
  ],
};

const INVALID_TOKEN_LIST_MISSING_NAME = {
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [],
};

const INVALID_TOKEN_LIST_BAD_TOKEN = {
  name: 'Bad List',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    {
      address: '',
      name: 'Missing Fields',
      symbol: 'BAD',
      decimals: -1,
      network: 'testnet',
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenListModule', () => {
  let mod: TokenListModule;

  beforeEach(() => {
    // Construct with a mock client that has network = TESTNET
    const fakeClient = { network: Network.TESTNET } as any;
    mod = new TokenListModule(fakeClient);
  });

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('parses a valid token list', () => {
      const result = mod.validate(VALID_TOKEN_LIST);
      expect(result.name).toBe('CoralSwap Default');
      expect(result.tokens).toHaveLength(3);
      expect(result.version).toEqual({ major: 1, minor: 0, patch: 0 });
    });

    it('throws ValidationError when name is missing', () => {
      expect(() => mod.validate(INVALID_TOKEN_LIST_MISSING_NAME)).toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError for invalid token fields', () => {
      expect(() => mod.validate(INVALID_TOKEN_LIST_BAD_TOKEN)).toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError for non-object input', () => {
      expect(() => mod.validate('not an object')).toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // filterByNetwork()
  // -------------------------------------------------------------------------

  describe('filterByNetwork', () => {
    it('filters tokens to testnet only', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const testnet = mod.filterByNetwork(all.tokens, Network.TESTNET);
      expect(testnet).toHaveLength(2);
      expect(testnet.every((t) => t.network === Network.TESTNET)).toBe(true);
    });

    it('filters tokens to mainnet only', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const mainnet = mod.filterByNetwork(all.tokens, Network.MAINNET);
      expect(mainnet).toHaveLength(1);
      expect(mainnet[0].symbol).toBe('USDC');
    });

    it('returns empty array when no tokens match', () => {
      const empty = mod.filterByNetwork([], Network.TESTNET);
      expect(empty).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe('search', () => {
    it('searches by symbol (case-insensitive)', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.search(all.tokens, 'usdc');
      expect(results).toHaveLength(2);
    });

    it('searches by name', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.search(all.tokens, 'Wrapped');
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('wXLM');
    });

    it('returns empty for no match', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.search(all.tokens, 'NONEXIST')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // findByAddress()
  // -------------------------------------------------------------------------

  describe('findByAddress', () => {
    it('finds a token by exact address', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const token = mod.findByAddress(
        all.tokens,
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      );
      expect(token).toBeDefined();
      expect(token!.symbol).toBe('USDC');
    });

    it('returns undefined for unknown address', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.findByAddress(all.tokens, 'UNKNOWN')).toBeUndefined();
    });
  });

  describe('filterByTag', () => {
    it('filters tokens by a single tag', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.filterByTag(all.tokens, 'stablecoin');
      expect(results).toHaveLength(2);
      expect(results.map((t) => t.symbol)).toContain('USDC');
    });

    it('returns empty array if tag not found', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.filterByTag(all.tokens, 'non-existent')).toHaveLength(0);
    });
  });

  describe('filterByTags', () => {
    it('filters tokens by multiple tags', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.filterByTags(all.tokens, ['stablecoin', 'fiat-backed']);
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('USDC');
    });

    it('returns empty array if any tag is missing', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.filterByTags(all.tokens, ['stablecoin', 'non-existent'])).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // fetch() — uses mocked global fetch
  // -------------------------------------------------------------------------

  describe('fetch', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('fetches, validates, and filters by client network', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => VALID_TOKEN_LIST,
      }) as any;

      const list = await mod.fetch('https://example.com/tokens.json');
      expect(list.name).toBe('CoralSwap Default');
      // Client network is TESTNET, so only testnet tokens are returned
      expect(list.tokens).toHaveLength(2);
      expect(list.tokens.every((t) => t.network === Network.TESTNET)).toBe(
        true,
      );
    });

    it('throws NetworkError on fetch failure', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(
        new Error('Network unreachable'),
      ) as any;

      await expect(
        mod.fetch('https://bad-url.example.com/tokens.json'),
      ).rejects.toThrow(NetworkError);
    });

    it('throws NetworkError on non-OK response', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any;

      await expect(
        mod.fetch('https://example.com/missing.json'),
      ).rejects.toThrow(NetworkError);
    });

    it('throws ValidationError on invalid JSON body', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }) as any;

      await expect(
        mod.fetch('https://example.com/bad.json'),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError on invalid schema', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ bad: 'data' }),
      }) as any;

      await expect(
        mod.fetch('https://example.com/invalid.json'),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // fetchAll()
  // -------------------------------------------------------------------------

  describe('fetchAll', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns all tokens without network filter', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => VALID_TOKEN_LIST,
      }) as any;

      const list = await mod.fetchAll('https://example.com/tokens.json');
      expect(list.tokens).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // getBalance() / getAllowance() — mocked Soroban RPC
  // -------------------------------------------------------------------------

  describe('on-chain reads', () => {
    const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const OWNER = 'GCZ3MMWYSKUXJL7BG4TLZBRPKJKUAVUH6GMJFSIKHLHAZ4F72ZBLO3DQ';
    const SPENDER = 'GC3LNOLW6C4LMFW57RADS3JLF44LRIUQ2VOHC5JZYS2YH2RVRYPAJUHF';

    const i128Val = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: 'i128' });

    function makeClient(server: Record<string, jest.Mock>) {
      return {
        network: Network.TESTNET,
        networkConfig: {
          networkPassphrase: 'Test SDF Network ; September 2015',
        },
        // Disable retries so failure-path tests run fast.
        config: { maxRetries: 0, retryDelayMs: 0 },
        server: {
          getAccount: jest
            .fn()
            .mockResolvedValue(new Account(SPENDER, '0')),
          simulateTransaction: jest.fn(),
          ...server,
        },
      } as any;
    }

    describe('getBalance', () => {
      it('returns the decoded i128 balance', async () => {
        const client = makeClient({
          simulateTransaction: jest.fn().mockResolvedValue({
            transactionData: {}, result: { retval: i128Val(1_500_000n) },
          }),
        });
        const tokens = new TokenListModule(client);

        const balance = await tokens.getBalance(TOKEN, OWNER);
        expect(balance).toBe(1_500_000n);
        expect(client.server.getAccount).toHaveBeenCalled();
        expect(client.server.simulateTransaction).toHaveBeenCalled();
      });

      it('returns 0n when the simulation has no return value', async () => {
        const client = makeClient({
          simulateTransaction: jest.fn().mockResolvedValue({ transactionData: {}, result: null }),
        });
        const tokens = new TokenListModule(client);

        expect(await tokens.getBalance(TOKEN, OWNER)).toBe(0n);
      });

      it('wraps simulation failures in TokenFetchError', async () => {
        const client = makeClient({
          simulateTransaction: jest.fn().mockResolvedValue({
            error: 'contract trapped',
          }),
        });
        const tokens = new TokenListModule(client);

        await expect(tokens.getBalance(TOKEN, OWNER)).rejects.toThrow(
          TokenFetchError,
        );
      });

      it('wraps RPC errors in TokenFetchError', async () => {
        const client = makeClient({
          getAccount: jest.fn().mockRejectedValue(new Error('RPC down')),
        });
        const tokens = new TokenListModule(client);

        await expect(tokens.getBalance(TOKEN, OWNER)).rejects.toThrow(
          TokenFetchError,
        );
      });
    });

    describe('getAllowance', () => {
      it('returns the decoded i128 allowance', async () => {
        const client = makeClient({
          simulateTransaction: jest.fn().mockResolvedValue({
            transactionData: {}, result: { retval: i128Val(42n) },
          }),
        });
        const tokens = new TokenListModule(client);

        const allowance = await tokens.getAllowance(TOKEN, OWNER, SPENDER);
        expect(allowance).toBe(42n);
      });

      it('wraps simulation failures in TokenFetchError', async () => {
        const client = makeClient({
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ error: 'no such function' }),
        });
        const tokens = new TokenListModule(client);

        await expect(
          tokens.getAllowance(TOKEN, OWNER, SPENDER),
        ).rejects.toThrow(TokenFetchError);
      });
    });
  });
});
