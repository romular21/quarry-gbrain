/**
 * Q2/G2 — search op threads a validated operation_id to the reranker audit.
 *
 * The optional operation_id (exactly 32 lowercase hex) is validated at the MCP
 * boundary (loud reject on a malformed value, BEFORE any provider dispatch) and
 * threaded as an opaque correlation token to hybridSearchCached → applyReranker
 * → the paid-call usage audit. It never affects retrieval, ranking or cache.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import * as hybrid from '../../src/core/search/hybrid.ts';
import { operationsByName, OperationError, type OperationContext } from '../../src/core/operations.ts';

const search = operationsByName.search;

function fakeCtx(): OperationContext {
  return {
    engine: { getConfig: async () => 'false' },
    config: { engine: 'pglite', eval: { capture: false, scrub_pii: true } },
    logger: console,
    dryRun: false,
    remote: true,
    sourceId: 'default',
  } as unknown as OperationContext;
}

describe('search op — operation_id', () => {
  test('publishes the operation_id param', () => {
    expect(search.params.operation_id?.type).toBe('string');
    expect(search.params.operation_id?.description).toContain('32 lowercase hex');
  });

  test('threads a valid 32-hex operation_id to hybridSearchCached', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const spy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(async (_e, _q, opts) => {
      calls.push(opts as Record<string, unknown>);
      return [];
    });
    try {
      await search.handler(fakeCtx(), { query: 'q', operation_id: 'a'.repeat(32) });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operationId).toBe('a'.repeat(32));
  });

  test('absent operation_id threads no operationId', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const spy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(async (_e, _q, opts) => {
      calls.push(opts as Record<string, unknown>);
      return [];
    });
    try {
      await search.handler(fakeCtx(), { query: 'q' });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(1);
    expect('operationId' in calls[0]!).toBe(false);
  });

  test.each([
    ['too short', 'a'.repeat(31)],
    ['too long', 'a'.repeat(33)],
    ['uppercase hex', 'A'.repeat(32)],
    ['non-hex chars', 'g'.repeat(32)],
    ['empty string', ''],
  ])('rejects a malformed operation_id (%s) before dispatch', async (_name, bad) => {
    const spy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(async () => []);
    try {
      await expect(search.handler(fakeCtx(), { query: 'q', operation_id: bad })).rejects.toThrow(OperationError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
