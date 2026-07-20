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
});
