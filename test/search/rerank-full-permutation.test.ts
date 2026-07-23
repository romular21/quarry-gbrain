/**
 * Q2/G2 — applyReranker full-permutation-or-fail-open contract.
 *
 * The prior behavior accepted a partial reranker response and back-filled
 * missing indices, producing a head that mixed reranked and un-reranked rows
 * with rerank_score populated on only some. Q2 requires a COMPLETE permutation
 * (top_n = documents.length); anything else fails open to the unchanged RRF
 * order with NO partial scores stamped.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { applyReranker, type RerankerOpts } from '../../src/core/search/rerank.ts';
import type { SearchResult } from '../../src/core/types.ts';

function makeResult(slug: string, score: number): SearchResult {
  return {
    slug, page_id: 0, title: slug, type: 'note',
    chunk_text: `doc ${slug}`, chunk_source: 'compiled_truth',
    chunk_id: 0, chunk_index: 0, score, stale: false,
  };
}

beforeAll(async () => {
  const { configureGateway } = await import('../../src/core/ai/gateway.ts');
  configureGateway({ env: { ZEROENTROPY_API_KEY: 'test-key' } });
});
afterAll(async () => {
  const { resetGateway } = await import('../../src/core/ai/gateway.ts');
  resetGateway();
});

describe('applyReranker — full-permutation contract', () => {
  test('sends top_n = documents.length and threads operationId', async () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9), makeResult('c', 0.8)];
    let captured: any = null;
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3,
      topNOut: null,
      operationId: 'f'.repeat(32),
      rerankerFn: async (input) => {
        captured = input;
        return input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.1 }));
      },
    };
    await applyReranker('q', results, opts);
    expect(captured.topN).toBe(3);
    expect(captured.operationId).toBe('f'.repeat(32));
  });

  test('partial permutation (fewer than head) fails open — NO partial scores', async () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9), makeResult('c', 0.8)];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3,
      topNOut: null,
      // Only 2 of 3 scored — a partial permutation.
      rerankerFn: async () => [
        { index: 2, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.5 },
      ],
    };
    const out = await applyReranker('q', results, opts);
    // Original RRF order, unchanged.
    expect(out.map((r) => r.slug)).toEqual(['a', 'b', 'c']);
    // CRITICAL: no result may carry a rerank_score after a fail-open.
    for (const r of out) expect((r as any).rerank_score).toBeUndefined();
  });

  test('duplicate index fails open — NO partial scores', async () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9)];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 2,
      topNOut: null,
      rerankerFn: async () => [
        { index: 0, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.5 }, // duplicate
      ],
    };
    const out = await applyReranker('q', results, opts);
    expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
    for (const r of out) expect((r as any).rerank_score).toBeUndefined();
  });

  test('out-of-range index fails open — NO partial scores', async () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9)];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 2,
      topNOut: null,
      rerankerFn: async () => [
        { index: 0, relevanceScore: 0.99 },
        { index: 5, relevanceScore: 0.5 }, // out of range
      ],
    };
    const out = await applyReranker('q', results, opts);
    expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
    for (const r of out) expect((r as any).rerank_score).toBeUndefined();
  });

  test('complete permutation reorders and stamps all head scores', async () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9), makeResult('c', 0.8)];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3,
      topNOut: null,
      rerankerFn: async () => [
        { index: 2, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.5 },
        { index: 1, relevanceScore: 0.1 },
      ],
    };
    const out = await applyReranker('q', results, opts);
    expect(out.map((r) => r.slug)).toEqual(['c', 'a', 'b']);
    expect(out.every((r) => typeof (r as any).rerank_score === 'number')).toBe(true);
  });
});
