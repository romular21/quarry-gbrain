import { describe, expect, spyOn, test } from 'bun:test';
import { OperationError, operationsByName, type OperationContext } from '../src/core/operations.ts';
import * as thinkModule from '../src/core/think/index.ts';

type ThinkScopeCall = { sourceId?: string; allowedSources?: string[] };
type MinimalThinkResult = Awaited<ReturnType<typeof thinkModule.runThink>>;

function context(
  engine: Record<string, unknown>,
  allowedSources = ['telegram-gtdqi', 'telegram-isyntez', 'telegram-moderneco', 'telegram-t6str', 'telegram-tqmtoc'],
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite', eval: { capture: false, scrub_pii: true } },
    logger: console,
    dryRun: false,
    remote: true,
    auth: {
      token: 'synthetic',
      clientId: 'quarry-think',
      scopes: ['read', 'write'],
      allowedSources,
    },
  } as unknown as OperationContext;
}

function stubResult(): MinimalThinkResult {
  return {
    question: 'q',
    answer: 'a',
    citations: [],
    gaps: [],
    pagesGathered: 0,
    takesGathered: 0,
    graphHits: 0,
    modelUsed: 'openrouter:anthropic/claude-sonnet-4.6',
    rounds: 1,
    warnings: [],
    diagnostics: {
      pagesFromHybrid: 0,
      takesFromKeyword: 0,
      takesFromVector: 0,
      graphHits: 0,
    },
  };
}

describe('think op — per-call source_id scope', () => {
  const think = operationsByName.think;

  test('publishes the optional source_id parameter', () => {
    expect(think.params.source_id?.type).toBe('string');
    expect(think.params.source_id?.required).not.toBe(true);
  });

  test('omitted source_id keeps the full federated OAuth grant', async () => {
    const calls: ThinkScopeCall[] = [];
    const thinkSpy = spyOn(thinkModule, 'runThink').mockImplementation(async (_engine, opts) => {
      calls.push({ sourceId: opts.sourceId, allowedSources: opts.allowedSources });
      return stubResult();
    });

    try {
      await think.handler(context({ getConfig: async () => 'false' }), {
        question: 'all granted sources',
      });
    } finally {
      thinkSpy.mockRestore();
    }

    expect(calls).toEqual([
      {
        sourceId: undefined,
        allowedSources: ['telegram-gtdqi', 'telegram-isyntez', 'telegram-moderneco', 'telegram-t6str', 'telegram-tqmtoc'],
      },
    ]);
  });

  test('in-grant source_id narrows runThink to a scalar sourceId', async () => {
    const calls: ThinkScopeCall[] = [];
    const thinkSpy = spyOn(thinkModule, 'runThink').mockImplementation(async (_engine, opts) => {
      calls.push({ sourceId: opts.sourceId, allowedSources: opts.allowedSources });
      return stubResult();
    });

    try {
      await think.handler(context({ getConfig: async () => 'false' }), {
        question: 'one group',
        source_id: 'telegram-t6str',
      });
    } finally {
      thinkSpy.mockRestore();
    }

    expect(calls).toEqual([{ sourceId: 'telegram-t6str', allowedSources: undefined }]);
  });

  test('out-of-grant source_id is denied before runThink or provider call', async () => {
    let runThinkCalls = 0;
    const thinkSpy = spyOn(thinkModule, 'runThink').mockImplementation(async () => {
      runThinkCalls += 1;
      return stubResult();
    });

    try {
      await expect(
        think.handler(context({ getConfig: async () => 'false' }), {
          question: 'forbidden source',
          source_id: 'telegram-outside-grant',
        }),
      ).rejects.toMatchObject({ code: 'permission_denied' } satisfies Partial<OperationError>);
    } finally {
      thinkSpy.mockRestore();
    }

    expect(runThinkCalls).toBe(0);
  });
});
