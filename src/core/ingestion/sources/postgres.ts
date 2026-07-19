/**
 * PostgresSource — a generic, configurable, migration-mode IngestionSource
 * that bulk-imports rows from ANY PostgreSQL query into gbrain pages.
 *
 * Design intent: this module is deliberately schema-agnostic. It hardcodes NO
 * table names, NO column semantics, NO connection details. Everything —
 * connection URL, the SELECT query, and how a row maps to a page — is supplied
 * by the caller via the constructor `opts`. Deployments that need a specific
 * corpus wire those specifics in at construction time; nothing about a
 * particular dataset lives here.
 *
 * Read-only by contract:
 *   - The source only ever runs the caller's single configured query and never
 *     issues writes; a cheap guard refuses a query that isn't a SELECT/WITH.
 *   - The REAL enforcement is the database role: point `databaseUrl` at a
 *     login with SELECT-only grants. The guard here is defence-in-depth.
 *
 * Migration semantics: `mode: 'migration'` tells the daemon to bypass the 24h
 * trickle dedup window. Idempotency is delegated downstream — each row emits a
 * stable `source_uri` (`<scheme>://<name>/<id>`) + `content_hash`, and
 * `put_page` dedupes on those. The source keeps no durable state of its own.
 *
 * Streaming: rows are read through a server-side cursor in batches so a large
 * table does not have to fit in memory; the scan cooperates with
 * `ctx.abortSignal` between batches.
 */

import postgres from 'postgres';
import { computeContentHash } from '../types.ts';
import type {
  IngestionSource,
  IngestionSourceContext,
  IngestionContentType,
  IngestionEvent,
  IngestionSourceMode,
  IngestionSourceHealth,
} from '../types.ts';

const POSTGRES_SOURCE_VERSION = '0.1.0';
const DEFAULT_BATCH_SIZE = 500;

export interface PostgresSourceOpts {
  /** postgres:// connection URL. Point it at a SELECT-only role. */
  databaseUrl: string;
  /** The read-only query returning source rows. Caller-supplied; must begin
   *  with SELECT or WITH (guarded). No schema is assumed here. */
  query: string;
  /** Row column whose value is the page text content. */
  contentColumn: string;
  /** Row column whose value stably+uniquely identifies a row. Drives
   *  source_uri and downstream idempotency. */
  idColumn: string;
  /** URI scheme label for provenance (source_uri = `<scheme>://<name>/<id>`).
   *  Default 'postgres'. */
  sourceUriScheme?: string;
  /** Logical source name in source_uri (a generic label, not a table name).
   *  Default 'rows'. */
  sourceName?: string;
  /** content_type stamped on every event. Default 'text/markdown'. */
  contentType?: IngestionContentType;
  /** Row columns copied verbatim into event.metadata for provenance.
   *  Default []. */
  metadataColumns?: string[];
  /** Server-side cursor batch size. Default 500. */
  batchSize?: number;
  /** Dry-run: query + map + validate but do not emit. */
  dryRun?: boolean;
  /** Optional stable instance id (default `postgres:${pid}`). */
  id?: string;
  /** Test seam: alternative row provider that bypasses the real database.
   *  Receives the configured query; returns all rows at once. */
  _query?: (query: string) => Promise<Record<string, unknown>[]>;
}

export interface PostgresSourceStats {
  emitted: number;
  skipped_invalid: number;
  total_rows: number;
  started: boolean;
}

const READ_ONLY_QUERY = /^\s*(?:select|with)\b/i;

export class PostgresSource implements IngestionSource {
  readonly id: string;
  readonly kind = 'postgres';
  readonly mode: IngestionSourceMode = 'migration';

  private readonly opts: Required<
    Omit<PostgresSourceOpts, 'id' | 'metadataColumns' | '_query'>
  > & {
    metadataColumns: string[];
    _query: PostgresSourceOpts['_query'];
  };
  private ctx: IngestionSourceContext | null = null;
  private sql: ReturnType<typeof postgres> | null = null;
  private _stats: PostgresSourceStats = {
    emitted: 0,
    skipped_invalid: 0,
    total_rows: 0,
    started: false,
  };

  constructor(opts: PostgresSourceOpts) {
    if (!opts.databaseUrl) throw new Error('PostgresSource: databaseUrl is required');
    if (!opts.query) throw new Error('PostgresSource: query is required');
    if (!READ_ONLY_QUERY.test(opts.query)) {
      throw new Error(
        'PostgresSource: query must be read-only (begin with SELECT or WITH) -- refusing a ' +
          'potentially mutating statement; the source never writes',
      );
    }
    if (!opts.contentColumn) throw new Error('PostgresSource: contentColumn is required');
    if (!opts.idColumn) throw new Error('PostgresSource: idColumn is required');
    this.id = opts.id ?? `postgres:${process.pid}`;
    this.opts = {
      databaseUrl: opts.databaseUrl,
      query: opts.query,
      contentColumn: opts.contentColumn,
      idColumn: opts.idColumn,
      sourceUriScheme: opts.sourceUriScheme ?? 'postgres',
      sourceName: opts.sourceName ?? 'rows',
      contentType: opts.contentType ?? 'text/markdown',
      metadataColumns: opts.metadataColumns ?? [],
      batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
      dryRun: opts.dryRun ?? false,
      _query: opts._query,
    };
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    this.ctx = ctx;
    this._stats.started = true;
    for await (const batch of this.batches()) {
      if (ctx.abortSignal.aborted) {
        ctx.logger.warn(`[postgres] aborted mid-scan (emitted=${this._stats.emitted})`);
        break;
      }
      for (const row of batch) {
        this._stats.total_rows += 1;
        let event: IngestionEvent;
        try {
          event = this.buildEvent(row);
        } catch (err) {
          this._stats.skipped_invalid += 1;
          ctx.logger.warn(`[postgres] skipped a row: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!this.opts.dryRun) ctx.emit(event);
        this._stats.emitted += 1;
      }
    }
    ctx.logger.info(
      `[postgres] scan complete (rows=${this._stats.total_rows} emitted=${this._stats.emitted} ` +
        `skipped_invalid=${this._stats.skipped_invalid} dry_run=${this.opts.dryRun})`,
    );
  }

  async stop(): Promise<void> {
    this.ctx = null;
    if (this.sql) {
      const sql = this.sql;
      this.sql = null;
      await sql.end({ timeout: 5 });
    }
  }

  async healthCheck(): Promise<IngestionSourceHealth> {
    if (!this._stats.started) return { status: 'warn', message: 'not started yet' };
    if (this._stats.skipped_invalid > 0) {
      return {
        status: 'warn',
        message: `${this._stats.skipped_invalid} row(s) skipped as invalid`,
      };
    }
    return { status: 'ok', message: `${this._stats.emitted} emitted` };
  }

  /** Yields batches of rows. Uses the test seam when provided, else a real
   *  server-side cursor over the configured (read-only) query. */
  private async *batches(): AsyncGenerator<Record<string, unknown>[]> {
    if (this.opts._query) {
      yield await this.opts._query(this.opts.query);
      return;
    }
    this.sql = postgres(this.opts.databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
    // Server-side cursor: stream in batches, never materialize the whole table.
    for await (const rows of this.sql.unsafe(this.opts.query).cursor(this.opts.batchSize)) {
      yield rows as unknown as Record<string, unknown>[];
    }
  }

  private buildEvent(row: Record<string, unknown>): IngestionEvent {
    const rawContent = row[this.opts.contentColumn];
    if (rawContent === null || rawContent === undefined) {
      throw new Error(`content column '${this.opts.contentColumn}' is null/absent`);
    }
    const content = String(rawContent);
    if (content.length === 0) throw new Error(`content column '${this.opts.contentColumn}' is empty`);

    const rawId = row[this.opts.idColumn];
    if (rawId === null || rawId === undefined || String(rawId).length === 0) {
      throw new Error(`id column '${this.opts.idColumn}' is null/absent`);
    }
    const source_uri = `${this.opts.sourceUriScheme}://${this.opts.sourceName}/${String(rawId)}`;

    const metadata: Record<string, unknown> = {};
    for (const col of this.opts.metadataColumns) {
      if (col in row) metadata[col] = row[col];
    }
    // Provenance always wins over a colliding mapped column name.
    metadata.importer = this.kind;
    metadata.importer_version = POSTGRES_SOURCE_VERSION;

    return {
      source_id: this.id,
      source_kind: this.kind,
      source_uri,
      received_at: new Date().toISOString(),
      content_type: this.opts.contentType,
      content,
      content_hash: computeContentHash(content),
      untrusted_payload: false,
      metadata,
    };
  }

  get stats(): Readonly<PostgresSourceStats> {
    return this._stats;
  }
}

/** Factory mirror of createFileWatcherSource / createInboxFolderSource. */
export function createPostgresSource(opts: PostgresSourceOpts): PostgresSource {
  return new PostgresSource(opts);
}
