/**
 * v0.35.0.0+ — reranker call-site abstraction.
 *
 * Slots into hybridSearch after `dedupResults()` and before
 * `enforceTokenBudget()`. Takes the top `topNIn` candidates by current RRF
 * order, sends them to `gateway.rerank()`, and re-orders by the
 * cross-encoder's relevance score. The un-reranked long tail keeps its
 * original RRF order — preserves recall vs. truncating to topNIn.
 *
 * Fail-open posture: every error class (auth, network, timeout, rate-limit,
 * payload-too-large, unknown) logs to the rerank-audit JSONL and returns
 * the original RRF order unchanged. Search reliability beats reranker
 * quality; a flaky upstream must never break search.
 *
 * Caller (hybridSearch) decides whether the reranker fires via
 * `opts.reranker?.enabled`. Mode-bundle resolution defaults this to `true`
 * for tokenmax and `false` for conservative/balanced.
 */

import { createHash } from 'crypto';
import type { SearchResult } from '../types.ts';
import { rerank as gatewayRerank, RerankError, type RerankInput, type RerankResult } from '../ai/gateway.ts';
import { logRerankFailure, type RerankFailureReason } from '../rerank-audit.ts';

export interface RerankerOpts {
  enabled: boolean;
  /** How many of the top results to send to the reranker (default 30). */
  topNIn: number;
  /** Truncate the reranked output to this many (null = no truncate). */
  topNOut: number | null;
  /** Provider:model override. When undefined, gateway uses configured default. */
  model?: string;
  /** Per-call timeout in ms (default 5000 — propagates to gateway.rerank). */
  timeoutMs?: number;
  /**
   * Test seam — when set, applyReranker calls this instead of gateway.rerank.
   * Production must NEVER set this.
   */
  rerankerFn?: (input: RerankInput) => Promise<RerankResult[]>;
  /**
   * Opaque Quarry operation id (32 lowercase hex) threaded to the paid-call
   * usage audit for cross-system correlation. Used ONLY for the audit — never
   * in ranking or cache identity.
   */
  operationId?: string;
}

/** SHA-256 prefix (8 chars) of the query text for privacy-preserving audit. */
function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Reorder the top `topNIn` results by reranker relevance score. The
 * un-reranked tail (any rows past topNIn) preserves its original RRF
 * position — appended after the reordered head in the same order it had
 * coming in.
 *
 * On reranker failure, logs to ~/.gbrain/audit/rerank-failures-* and
 * returns the input array unmodified. Never throws.
 *
 * Empty input passes through immediately (no upstream call).
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  opts: RerankerOpts,
): Promise<SearchResult[]> {
  if (!opts.enabled || results.length === 0) return results;
  // No documents to rerank when topNIn=0 — pass through (defensive; mode
  // bundles never set 0 in practice).
  if (opts.topNIn <= 0) return results;

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);

  // Document text — chunk_text is the matched span. Fall back to title if
  // empty (shouldn't happen in practice; defensive). Empty docs would
  // confuse the reranker, but we still send them — the upstream model decides.
  const documents = head.map(r => r.chunk_text || r.title || '');

  let reranked: RerankResult[];
  try {
    const rerankerFn = opts.rerankerFn ?? gatewayRerank;
    reranked = await rerankerFn({
      query,
      documents,
      // Score EVERY candidate in the head — top_n = documents.length — so a
      // well-behaved provider returns a COMPLETE permutation. Guarantees a
      // score for the whole input instead of relying on an omission default.
      topN: documents.length,
      timeoutMs: opts.timeoutMs,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.operationId ? { operationId: opts.operationId } : {}),
    });
  } catch (err) {
    const reason: RerankFailureReason =
      err instanceof RerankError ? err.reason : 'unknown';
    const errorSummary = err instanceof Error ? err.message : String(err);
    try {
      logRerankFailure({
        model: opts.model ?? 'unknown',
        reason,
        query_hash: hashQuery(query),
        doc_count: documents.length,
        error_summary: errorSummary,
      });
    } catch {
      // Audit logging must never break search.
    }
    return results;
  }

  // Full-permutation-or-fail-open (Quarry Q2/G2). We asked for a score per
  // candidate (top_n = documents.length), so we require a COMPLETE permutation:
  // exactly one result per head item. A short/partial response would otherwise
  // produce a head that mixes reranked and un-reranked rows with only some
  // rerank_score populated — so anything but a full permutation fails open to
  // the unchanged RRF order.
  if (!Array.isArray(reranked) || reranked.length !== head.length) return results;

  // Validate the permutation BEFORE mutating any result. `head` is a slice of
  // `results` (shared object references), so stamping a score and then bailing
  // would leak partial scores onto the returned RRF order. Two-phase — validate
  // first, mutate only once the whole response is proven a unique, in-range,
  // integer, finite-score permutation — guarantees fail-open leaves results
  // byte-identical. (gateway.rerank already enforces this; the check keeps the
  // apply safe even against a test seam or a future gateway relaxation.)
  const seen = new Set<number>();
  for (const r of reranked) {
    if (
      !Number.isInteger(r.index) || r.index < 0 || r.index >= head.length ||
      seen.has(r.index) || !Number.isFinite(r.relevanceScore)
    ) {
      return results;
    }
    seen.add(r.index);
  }

  // Safe apply: every index is a validated unique integer in range, so
  // head[r.index] is always defined — no unguarded deref can throw.
  const reorderedHead: SearchResult[] = [];
  for (const r of reranked) {
    const item = head[r.index]!;
    // Stamp the reranker score so downstream (telemetry, debug, autocut) sees
    // the new ordering signal. Does NOT replace `score` (RRF; other consumers
    // may depend on it).
    item.rerank_score = r.relevanceScore;
    // v0.40.4 attribution stamp (D12=A) — rank delta. Positive means rank
    // improved (moved closer to top).
    item.reranker_delta = r.index - reorderedHead.length;
    reorderedHead.push(item);
  }

  const combined = [...reorderedHead, ...tail];
  return opts.topNOut !== null && opts.topNOut > 0
    ? combined.slice(0, opts.topNOut)
    : combined;
}
