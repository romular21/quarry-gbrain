/**
 * Q2/G2 — gateway.rerank() strict response validation + paid-call usage audit.
 *
 * The prior soft coercion (`typeof number ? : 0`) let malformed provider
 * results corrupt the reordering. Now the gateway rejects non-integer,
 * out-of-range and duplicate indices and non-finite scores as malformed
 * (throw → applyReranker fails open), surfaces nullable usage.search_units,
 * and records a pending → unknown-after-dispatch → terminal paid-call audit
 * that never stores query or document text.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  configureGateway,
  resetGateway,
  rerank,
  RerankError,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';
import {
  readRecentRerankUsage,
  computeRerankUsageAuditFilename,
} from '../../src/core/rerank-usage-audit.ts';

function configureOR(model = 'openrouter:cohere/rerank-4-fast'): void {
  configureGateway({ reranker_model: model, env: { OPENROUTER_API_KEY: 'sk-or-test' } });
}
function mockResp(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}
async function withFreshAuditDir(body: (dir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-usage-gw-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => { await body(tmpDir); });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

afterEach(() => { __setRerankTransportForTests(null); resetGateway(); });

describe('gateway.rerank() — strict validation', () => {
  beforeEach(() => configureOR());

  test('valid full permutation passes through', async () => {
    __setRerankTransportForTests(async () =>
      mockResp({ results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.1 },
      ] }));
    const out = await rerank({ query: 'q', documents: ['a', 'b', 'c'], topN: 3 });
    expect(out).toEqual([
      { index: 2, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.5 },
      { index: 1, relevanceScore: 0.1 },
    ]);
  });

  const malformed: Array<[string, unknown[]]> = [
    ['duplicate index', [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }]],
    ['out-of-range index', [{ index: 5, relevance_score: 0.9 }]],
    ['negative index', [{ index: -1, relevance_score: 0.9 }]],
    ['fractional index', [{ index: 1.5, relevance_score: 0.9 }]],
    ['non-number index', [{ index: '0', relevance_score: 0.9 }]],
    ['null score', [{ index: 0, relevance_score: null }]],
    ['non-number score', [{ index: 0, relevance_score: '0.9' }]],
  ];
  for (const [name, results] of malformed) {
    test(`rejects ${name} as malformed (throws → fail-open)`, async () => {
      __setRerankTransportForTests(async () => mockResp({ results }));
      try {
        await rerank({ query: 'q', documents: ['a', 'b', 'c'], topN: 3 });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RerankError);
        expect((err as RerankError).message.toLowerCase()).toContain('malformed');
      }
    });
  }
});

describe('gateway.rerank() — paid-call usage audit', () => {
  beforeEach(() => configureOR());

  test('success: pending → unknown-after-dispatch → succeeded with usage + estimated cost', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async () =>
        mockResp({ results: [{ index: 0, relevance_score: 0.9 }], usage: { search_units: 1 } }));
      await rerank({ query: 'q', documents: ['d'], topN: 1, operationId: 'a'.repeat(32) });
      const rows = readRecentRerankUsage(7);
      expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'succeeded', 'unknown-after-dispatch']);
      expect(new Set(rows.map((r) => r.call_id)).size).toBe(1);
      const s = rows.find((r) => r.status === 'succeeded')!;
      expect(s.search_units).toBe(1);
      expect(s.estimated_cost_usd).toBe(0.002);
      expect(s.price_card_revision).toBe('2026-07-24');
      expect(s.operation_id).toBe('a'.repeat(32));
      expect(s.provider).toBe('openrouter');
      expect(s.model).toBe('cohere/rerank-4-fast');
      expect(s.document_count).toBe(1);
      expect(s.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  test('missing usage → search_units null (never 0)', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async () => mockResp({ results: [{ index: 0, relevance_score: 0.9 }] }));
      await rerank({ query: 'q', documents: ['d'], topN: 1 });
      const s = readRecentRerankUsage(7).find((r) => r.status === 'succeeded')!;
      expect(s.search_units).toBeNull();
      expect(s.estimated_cost_usd).toBeNull(); // never invent a unit count
      expect(s.operation_id).toBeNull();
    });
  });

  test('HTTP 429 → terminal failed (rate_limit) after unknown-after-dispatch; no query/doc text', async () => {
    await withFreshAuditDir(async (dir) => {
      __setRerankTransportForTests(async () => new Response('rate', { status: 429 }));
      try { await rerank({ query: 'secretquery', documents: ['secretdoc'], topN: 1 }); } catch { /* fail-open */ }
      const rows = readRecentRerankUsage(7);
      expect(rows.some((r) => r.status === 'unknown-after-dispatch')).toBe(true);
      const failed = rows.find((r) => r.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.failure_reason).toBe('rate_limit');
      const raw = fs.readFileSync(path.join(dir, computeRerankUsageAuditFilename()), 'utf8');
      expect(raw).not.toContain('secretquery');
      expect(raw).not.toContain('secretdoc');
    });
  });

  test('malformed-but-200 records failed while preserving billed usage and cost', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async () =>
        mockResp({ results: [{ index: 9, relevance_score: 0.9 }], usage: { search_units: 1 } }));
      try { await rerank({ query: 'q', documents: ['d'], topN: 1 }); } catch { /* fail-open */ }
      const rows = readRecentRerankUsage(7);
      expect(rows.some((r) => r.status === 'succeeded')).toBe(false);
      const failed = rows.find((r) => r.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.search_units).toBe(1);
      expect(failed!.estimated_cost_usd).toBe(0.002);
      expect(failed!.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  test('full-permutation request rejects a short response and records failed', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async () =>
        mockResp({
          results: [{ index: 0, relevance_score: 0.9 }],
          usage: { search_units: 1 },
        }));
      await expect(
        rerank({ query: 'q', documents: ['a', 'b'], topN: 2 }),
      ).rejects.toThrow(RerankError);
      const rows = readRecentRerankUsage(7);
      expect(rows.some((r) => r.status === 'succeeded')).toBe(false);
      expect(rows.find((r) => r.status === 'failed')?.search_units).toBe(1);
    });
  });

  test('negative provider usage is invalid and never creates negative cost', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async () =>
        mockResp({
          results: [{ index: 0, relevance_score: 0.9 }],
          usage: { search_units: -1 },
        }));
      await rerank({ query: 'q', documents: ['d'], topN: 1 });
      const succeeded = readRecentRerankUsage(7).find((r) => r.status === 'succeeded')!;
      expect(succeeded.search_units).toBeNull();
      expect(succeeded.estimated_cost_usd).toBeNull();
    });
  });

  test('real timeout path records cancelled and throws reason=timeout', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));
      try {
        await rerank({ query: 'q', documents: ['d'], topN: 1, timeoutMs: 5 });
        throw new Error('should have timed out');
      } catch (err) {
        expect(err).toBeInstanceOf(RerankError);
        expect((err as RerankError).reason).toBe('timeout');
      }
      const rows = readRecentRerankUsage(7);
      const cancelled = rows.find((r) => r.status === 'cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled!.failure_reason).toBe('timeout');
      expect(cancelled!.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  test('payload-too-large: no audit rows (never dispatched)', async () => {
    await withFreshAuditDir(async () => {
      __setRerankTransportForTests(async () => mockResp({ results: [] }));
      const huge = 'x'.repeat(600_000);
      try { await rerank({ query: 'q', documents: [huge], topN: 1 }); } catch { /* pre-flight reject */ }
      expect(readRecentRerankUsage(7).length).toBe(0);
    });
  });
});
