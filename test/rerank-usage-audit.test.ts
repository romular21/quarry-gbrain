/**
 * Quarry Q2/G2 — reranker paid-call usage audit.
 *
 * Uses withEnv() per test-isolation rule R1 (never mutate process.env directly
 * outside *.serial.test.ts). Each test runs in a fresh tmp GBRAIN_AUDIT_DIR.
 *
 * Pins:
 *  - append-only lifecycle: pending → unknown-after-dispatch → terminal, all
 *    correlated by one call_id;
 *  - nullable search_units / estimated_cost round-trip faithfully (never 0-for-unknown);
 *  - the event shape carries NO query or document text field.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  logRerankUsage,
  readRecentRerankUsage,
  computeRerankUsageAuditFilename,
  type RerankUsageEvent,
} from '../src/core/rerank-usage-audit.ts';

async function withFreshAuditDir(body: (tmpDir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-usage-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      await body(tmpDir);
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function baseRow(over: Partial<RerankUsageEvent> = {}): Omit<RerankUsageEvent, 'ts'> {
  return {
    call_id: 'a'.repeat(32),
    operation_id: 'b'.repeat(32),
    operation_kind: 'rerank',
    provider: 'openrouter',
    model: 'cohere/rerank-4-fast',
    status: 'pending',
    document_count: 50,
    duration_ms: null,
    search_units: null,
    estimated_cost_usd: null,
    price_card_revision: '2026-07-24',
    failure_reason: null,
    ...over,
  };
}

describe('rerank-usage audit', () => {
  test('append-only lifecycle: pending → unknown-after-dispatch → succeeded (one call_id)', async () => {
    await withFreshAuditDir(() => {
      const call = 'c'.repeat(32);
      logRerankUsage(baseRow({ call_id: call, status: 'pending' }));
      logRerankUsage(baseRow({ call_id: call, status: 'unknown-after-dispatch' }));
      logRerankUsage(baseRow({
        call_id: call,
        status: 'succeeded',
        duration_ms: 12.5,
        search_units: 3,
        estimated_cost_usd: 0.006,
      }));
      const rows = readRecentRerankUsage(7).filter((r) => r.call_id === call);
      expect(rows.map((r) => r.status).sort()).toEqual(
        ['pending', 'succeeded', 'unknown-after-dispatch'],
      );
      const succeeded = rows.find((r) => r.status === 'succeeded')!;
      expect(succeeded.duration_ms).toBe(12.5);
      expect(succeeded.search_units).toBe(3);
      expect(succeeded.estimated_cost_usd).toBe(0.006);
      expect(succeeded.price_card_revision).toBe('2026-07-24');
    });
  });

  test('unknown usage stays null — never 0', async () => {
    await withFreshAuditDir(() => {
      logRerankUsage(baseRow({ status: 'succeeded', search_units: null, estimated_cost_usd: null }));
      const row = readRecentRerankUsage(7)[0]!;
      expect(row.search_units).toBeNull();
      expect(row.estimated_cost_usd).toBeNull();
    });
  });

  test('terminal failed row carries a failure_reason', async () => {
    await withFreshAuditDir(() => {
      logRerankUsage(baseRow({ status: 'failed', failure_reason: 'rate_limit' }));
      const row = readRecentRerankUsage(7)[0]!;
      expect(row.status).toBe('failed');
      expect(row.failure_reason).toBe('rate_limit');
    });
  });

  test('event shape carries NO query or document text', async () => {
    await withFreshAuditDir((dir) => {
      logRerankUsage(baseRow({ status: 'succeeded', search_units: 5 }));
      const file = path.join(dir, computeRerankUsageAuditFilename());
      const raw = fs.readFileSync(file, 'utf8');
      const keys = Object.keys(JSON.parse(raw.trim().split('\n')[0]!));
      for (const forbidden of ['query', 'documents', 'document', 'text', 'query_hash', 'chunk_text']) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });
});
