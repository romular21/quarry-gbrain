import { describe, expect, spyOn, test } from 'bun:test';
import * as hybrid from '../../src/core/search/hybrid.ts';
import { OperationError, operationsByName, type OperationContext } from '../../src/core/operations.ts';

type ScopeCall = { sourceId?: string; sourceIds?: string[] };

function context(
  engine: Record<string, unknown>,
  allowedSources = ['telegram-gtdqi', 'telegram-t6str'],
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite', eval: { capture: false, scrub_pii: true } },
    logger: console,
    dryRun: false,
    remote: true,
    auth: {
      token: 'synthetic',
      clientId: 'quarry-site',
      scopes: ['read'],
      allowedSources,
    },
  } as unknown as OperationContext;
}

describe('search op — per-call source scope', () => {
  const search = operationsByName.search;

  test('publishes the optional source_id parameter', () => {
    expect(search.params.source_id?.type).toBe('string');
    expect(search.params.source_id?.required).not.toBe(true);
  });

  test('omitted source_id searches the complete granted source set', async () => {
    const calls: ScopeCall[] = [];
    const searchSpy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(
      async (_engine, _query, opts) => {
        calls.push({ sourceId: opts?.sourceId, sourceIds: opts?.sourceIds });
        return [];
      },
    );

    try {
      await search.handler(context({ getConfig: async () => 'false' }), {
        query: 'all granted sources',
      });
    } finally {
      searchSpy.mockRestore();
    }

    expect(calls).toEqual([{ sourceId: undefined, sourceIds: ['telegram-gtdqi', 'telegram-t6str'] }]);
  });

  test('explicit in-grant source_id reaches hybrid search as a scalar scope', async () => {
    const calls: ScopeCall[] = [];
    const searchSpy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(
      async (_engine, _query, opts) => {
        calls.push({ sourceId: opts?.sourceId, sourceIds: opts?.sourceIds });
        return [];
      },
    );

    try {
      await search.handler(context({ getConfig: async () => 'false' }), {
        query: 'one group',
        source_id: 'telegram-t6str',
      });
    } finally {
      searchSpy.mockRestore();
    }

    expect(calls).toEqual([{ sourceId: 'telegram-t6str', sourceIds: undefined }]);
  });

  test('explicit in-grant source_id reaches keyword search as the same scalar scope', async () => {
    const calls: ScopeCall[] = [];
    const engine = {
      getConfig: async (key: string) => key === 'search.mcp_keyword_only' ? 'true' : 'false',
      searchKeyword: async (_query: string, opts: ScopeCall) => {
        calls.push({ sourceId: opts.sourceId, sourceIds: opts.sourceIds });
        return [];
      },
    };

    await search.handler(context(engine), {
      query: 'one group keyword',
      source_id: 'telegram-gtdqi',
    });

    expect(calls).toEqual([{ sourceId: 'telegram-gtdqi', sourceIds: undefined }]);
  });

  test('out-of-grant source_id is denied before config or retrieval work', async () => {
    let engineCalls = 0;
    const engine = {
      getConfig: async () => {
        engineCalls += 1;
        return 'false';
      },
      searchKeyword: async () => {
        engineCalls += 1;
        return [];
      },
    };
    const searchSpy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(async () => {
      engineCalls += 1;
      return [];
    });

    try {
      await expect(search.handler(context(engine), {
        query: 'forbidden source',
        source_id: 'telegram-outside-grant',
      })).rejects.toMatchObject({ code: 'permission_denied' } satisfies Partial<OperationError>);
    } finally {
      searchSpy.mockRestore();
    }

    expect(engineCalls).toBe(0);
  });

  test('scalar-grant caller cannot replace its source_id', async () => {
    let engineCalls = 0;
    const ctx = context({
      getConfig: async () => {
        engineCalls += 1;
        return 'false';
      },
    }, []);
    ctx.sourceId = 'telegram-gtdqi';

    await expect(search.handler(ctx, {
      query: 'forbidden scalar override',
      source_id: 'telegram-t6str',
    })).rejects.toMatchObject({ code: 'permission_denied' } satisfies Partial<OperationError>);

    expect(engineCalls).toBe(0);
  });
});
