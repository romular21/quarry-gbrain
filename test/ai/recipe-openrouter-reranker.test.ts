/**
 * Q2/G2 — OpenRouter reranker touchpoint wiring.
 *
 * Pins the reranker touchpoint added to the OpenRouter recipe so the Quarry
 * site-search reranker (openrouter:cohere/rerank-4-fast) has a real seam:
 *  - URL composes to https://openrouter.ai/api/v1/rerank (touchpoint path '/rerank').
 *  - Body shape {model, query, documents, top_n?}; default model cohere/rerank-4-fast.
 *  - Bearer auth from OPENROUTER_API_KEY + attribution headers on the rerank wire.
 *  - Model allowlist: cohere/rerank-4-fast, cohere/rerank-4-pro, cohere/rerank-v3.5;
 *    invented slugs rejected BEFORE any transport call.
 *  - Conservative INTERNAL 512,000-byte payload guard fires before transport.
 *  - Per-search price metadata present (cost_per_search_usd, price_last_verified).
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  rerank,
  RerankError,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { openrouter } from '../../src/core/ai/recipes/openrouter.ts';

function configureOR(model = 'openrouter:cohere/rerank-4-fast'): void {
  configureGateway({
    reranker_model: model,
    env: { OPENROUTER_API_KEY: 'sk-or-test' },
  });
}

function mockResp(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('OpenRouter reranker touchpoint — wiring', () => {
  beforeEach(() => configureOR());

  test('composes https://openrouter.ai/api/v1/rerank (no path doubling)', async () => {
    let url = '';
    __setRerankTransportForTests(async (u) => {
      url = u;
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(url).toBe('https://openrouter.ai/api/v1/rerank');
    expect(url).not.toContain('/v1/v1/');
    expect(url).not.toContain('/models/rerank');
  });

  test('default model cohere/rerank-4-fast; body {model,query,documents,top_n}', async () => {
    let body: any = null;
    __setRerankTransportForTests(async (_u, init) => {
      body = JSON.parse(init.body as string);
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d1', 'd2'], topN: 2 });
    expect(body).toEqual({
      model: 'cohere/rerank-4-fast',
      query: 'q',
      documents: ['d1', 'd2'],
      top_n: 2,
    });
  });

  test('Bearer auth + attribution headers on the rerank wire', async () => {
    let headers: Headers | null = null;
    __setRerankTransportForTests(async (_u, init) => {
      headers = new Headers(init.headers as HeadersInit);
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(headers!.get('authorization')).toBe('Bearer sk-or-test');
    expect(headers!.get('http-referer')).toBe('https://gbrain.ai');
    expect(headers!.get('x-title')).toBe('gbrain');
  });

  test('allowlist accepts -4-pro and -v3.5', async () => {
    __setRerankTransportForTests(async () => mockResp({ results: [{ index: 0, relevance_score: 1 }] }));
    const pro = await rerank({ query: 'q', documents: ['d'], model: 'openrouter:cohere/rerank-4-pro' });
    expect(pro.length).toBe(1);
    const v35 = await rerank({ query: 'q', documents: ['d'], model: 'openrouter:cohere/rerank-v3.5' });
    expect(v35.length).toBe(1);
  });

  test('rejects an invented slug BEFORE any transport call', async () => {
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [] });
    });
    try {
      await rerank({ query: 'q', documents: ['d'], model: 'openrouter:cohere/rerank-fake-99' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).message).toContain('not listed');
      expect(called).toBe(false);
    }
  });

  test('512,000-byte internal guard fires BEFORE transport', async () => {
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [] });
    });
    const huge = 'x'.repeat(600_000); // > 512,000-byte cap
    try {
      await rerank({ query: 'q', documents: [huge] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('payload_too_large');
      expect(called).toBe(false);
    }
  });

  test('recipe declares per-search price metadata (revision 2026-07-24)', () => {
    const tp = openrouter.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.default_model).toBe('cohere/rerank-4-fast');
    expect(tp!.models).toEqual(['cohere/rerank-4-fast', 'cohere/rerank-4-pro', 'cohere/rerank-v3.5']);
    expect(tp!.path).toBe('/rerank');
    expect(tp!.max_payload_bytes).toBe(512_000);
    expect(tp!.cost_per_search_usd).toBe(0.002);
    expect(tp!.price_last_verified).toBe('2026-07-24');
  });
});
