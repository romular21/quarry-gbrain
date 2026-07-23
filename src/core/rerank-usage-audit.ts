/**
 * Quarry Q2/G2 — reranker PAID-CALL usage audit.
 *
 * DISTINCT from `rerank-audit.ts` (which is failure-only). This trail records
 * every paid OpenRouter reranker DISPATCH as an append-only lifecycle so a
 * billed call is never silently lost:
 *
 *   pending → unknown-after-dispatch → succeeded | failed | cancelled
 *
 * Each transition is its own JSONL line, correlated by an opaque per-dispatch
 * `call_id` plus the optional Quarry-threaded `operation_id`. A crash between
 * `unknown-after-dispatch` and a terminal row leaves the trail showing a
 * possibly-billed call — exactly what we want; the cost is NEVER back-filled
 * to zero on unknown.
 *
 * Privacy: this trail stores ONLY counts, provider/model, status, timing and
 * nullable provider usage. It NEVER stores query text, document text or any
 * corpus fragment. It is a small operational trace — NOT a billing ledger,
 * reconciliation service or statistics platform.
 *
 * Best-effort writes via the shared audit primitive: write failures go to
 * stderr but never throw; search continues regardless.
 */

import { createAuditWriter } from './audit/audit-writer.ts';

export type RerankUsageStatus =
  | 'pending'
  | 'unknown-after-dispatch'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface RerankUsageEvent {
  ts: string;
  /** Opaque per-dispatch correlation id (32 lowercase hex). Ties lifecycle rows. */
  call_id: string;
  /** Quarry-threaded operation id (32 lowercase hex) or null for generic callers. */
  operation_id: string | null;
  operation_kind: 'rerank';
  /** Recipe id — e.g. `'openrouter'`. */
  provider: string;
  /** Model id — e.g. `'cohere/rerank-4-fast'`. */
  model: string;
  status: RerankUsageStatus;
  /** Documents sent to the reranker. The COUNT only — never the text. */
  document_count: number;
  /**
   * Provider-reported search units, or null when the provider did not return
   * usage. NEVER fabricated and NEVER recorded as 0 to mean "unknown".
   */
  search_units: number | null;
  /**
   * Estimated USD cost (`cost_per_search_usd` × 1 search per call), or null
   * when the touchpoint declares no per-search price card.
   */
  estimated_cost_usd: number | null;
  /** Price-card revision string (touchpoint `price_last_verified`), or null. */
  price_card_revision: string | null;
  /** Classified failure reason on terminal failed/cancelled rows; null otherwise. */
  failure_reason: string | null;
}

const writer = createAuditWriter<RerankUsageEvent>({
  featureName: 'rerank-usage',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'rerank-usage audit ',
  errorTrailer: '; search continues',
});

/** Append one paid-call lifecycle row. Best-effort; never throws. */
export function logRerankUsage(event: Omit<RerankUsageEvent, 'ts'>): void {
  writer.log(event);
}

/** Read recent paid-call rows (current + previous ISO week, `days` window). */
export function readRecentRerankUsage(days = 7, now: Date = new Date()): RerankUsageEvent[] {
  return writer.readRecent(days, now);
}

/** `rerank-usage-YYYY-Www.jsonl` for a given date (test/consumer helper). */
export function computeRerankUsageAuditFilename(now: Date = new Date()): string {
  return writer.computeFilename(now);
}
