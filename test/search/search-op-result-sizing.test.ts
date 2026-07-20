import { describe, expect, spyOn, test } from 'bun:test';
import * as hybrid from '../../src/core/search/hybrid.ts';
import { enforceTokenBudget } from '../../src/core/search/token-budget.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { SearchResult } from '../../src/core/types.ts';

describe('search op — explicit result sizing controls', () => {
  const search = operationsByName.search;

  test('publishes the three optional controls', () => {
    expect(search.params.token_budget?.type).toBe('number');
    expect(search.params.autocut?.type).toBe('boolean');
    expect(search.params.adaptive_return?.type).toBe('boolean');
    expect(search.params.autocut?.description).toContain('keyword-only');
    expect(search.params.adaptive_return?.description).toContain('keyword-only');
  });

  test('threads the controls to hybridSearchCached while expansion stays off', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const searchSpy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(
      async (_engine, _query, opts) => {
        calls.push(opts as Record<string, unknown>);
        return [];
      },
    );
    const ctx = {
      engine: { getConfig: async () => 'false' },
      config: { engine: 'pglite', eval: { capture: false, scrub_pii: true } },
      logger: console,
      dryRun: false,
      remote: true,
      sourceId: 'default',
    } as unknown as OperationContext;

    try {
      await search.handler(ctx, {
        query: 'bounded result set',
        limit: 50,
        offset: 0,
        token_budget: 0,
        autocut: false,
        adaptive_return: false,
      });
    } finally {
      searchSpy.mockRestore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      limit: 50,
      offset: 0,
      expansion: false,
      tokenBudget: 0,
      autocut: false,
      adaptiveReturn: false,
    });
  });

  test('zero token budget is an explicit no-drop contract', () => {
    const results = [{ slug: 'msg-synthetic', chunk_text: 'synthetic result' }];
    const bounded = enforceTokenBudget(results as unknown as SearchResult[], 0);

    expect(bounded.results).toEqual(results as unknown as SearchResult[]);
    expect(bounded.meta).toMatchObject({ budget: 0, kept: 1, dropped: 0 });
  });

  test('token budget is also enforced in operator keyword-only mode', async () => {
    const ctx = {
      engine: {
        getConfig: async (key: string) => key === 'search.mcp_keyword_only' ? 'true' : 'false',
        searchKeyword: async () => [
          { slug: 'msg-first', chunk_text: '12345678', score: 1 },
          { slug: 'msg-second', chunk_text: 'abcdefgh', score: 0.5 },
        ],
      },
      config: { engine: 'pglite', eval: { capture: false, scrub_pii: true } },
      logger: console,
      dryRun: false,
      remote: true,
      sourceId: 'default',
    } as unknown as OperationContext;

    const results = await search.handler(ctx, {
      query: 'bounded keyword result set',
      limit: 50,
      offset: 0,
      token_budget: 2,
      autocut: false,
      adaptive_return: false,
    }) as SearchResult[];

    expect(results.map((result) => result.slug)).toEqual(['msg-first']);
  });
});
