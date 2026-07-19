/**
 * PostgresSource tests. Synthetic, seam-driven unit tests (no database) run
 * everywhere; a DATABASE_URL-gated integration smoke exercises the real
 * `postgres` client + server-side cursor against a disposable synthetic table.
 */

import { describe, expect, test } from 'bun:test';
import type { IngestionEvent, IngestionSourceContext } from '../../../src/core/ingestion/types.ts';
import { computeContentHash } from '../../../src/core/ingestion/types.ts';
import {
  createPostgresSource,
  PostgresSource,
} from '../../../src/core/ingestion/sources/postgres.ts';
import { IngestionTestHarness } from '../../../src/core/ingestion/test-harness.ts';

const BASE = {
  databaseUrl: 'postgres://unused@localhost/unused',
  query: 'SELECT id, body FROM whatever',
  contentColumn: 'body',
  idColumn: 'id',
};

/** Minimal manual context for cases that need control over abortSignal. */
function makeCtx(overrides: Partial<IngestionSourceContext> = {}): IngestionSourceContext & {
  emitted: IngestionEvent[];
} {
  const emitted: IngestionEvent[] = [];
  return {
    emitted,
    emit(e: IngestionEvent) {
      emitted.push(e);
    },
    engine: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    abortSignal: new AbortController().signal,
    config: {},
    ...overrides,
  };
}

describe('PostgresSource — construction guards', () => {
  test('rejects a non-read-only query', () => {
    expect(() => createPostgresSource({ ...BASE, query: 'DELETE FROM t' })).toThrow(/read-only/i);
    expect(() => createPostgresSource({ ...BASE, query: 'UPDATE t SET x=1' })).toThrow(/read-only/i);
  });
  test('accepts SELECT and WITH (CTE) queries', () => {
    expect(() => createPostgresSource({ ...BASE, query: 'select 1' })).not.toThrow();
    expect(() => createPostgresSource({ ...BASE, query: 'WITH q AS (SELECT 1) SELECT * FROM q' })).not.toThrow();
  });
  test('requires databaseUrl / query / contentColumn / idColumn', () => {
    expect(() => createPostgresSource({ ...BASE, databaseUrl: '' })).toThrow(/databaseUrl/);
    expect(() => createPostgresSource({ ...BASE, contentColumn: '' })).toThrow(/contentColumn/);
    expect(() => createPostgresSource({ ...BASE, idColumn: '' })).toThrow(/idColumn/);
  });
  test('is a migration-mode source', () => {
    const src = createPostgresSource(BASE);
    expect(src.mode).toBe('migration');
    expect(src.kind).toBe('postgres');
  });
});

describe('PostgresSource — emission (seam-driven, harness-validated)', () => {
  test('emits one VALID event per row with content_hash, stable source_uri, metadata', async () => {
    const rows = [
      { id: 7, body: 'first body', author: 'a', channel: 'c1' },
      { id: 42, body: 'second body', author: 'b', channel: 'c2' },
    ];
    const src = createPostgresSource({
      ...BASE,
      sourceUriScheme: 'pg',
      sourceName: 'units',
      metadataColumns: ['author', 'channel'],
      _query: async () => rows,
    });
    const harness = new IngestionTestHarness();
    await harness.run(src);

    // The harness runs validateIngestionEvent on every emit.
    expect(harness.validationErrors).toEqual([]);
    expect(harness.events.length).toBe(2);

    const e0 = harness.events[0]!;
    expect(e0.source_kind).toBe('postgres');
    expect(e0.content).toBe('first body');
    expect(e0.content_hash).toBe(computeContentHash('first body'));
    expect(e0.content_type).toBe('text/markdown');
    expect(e0.source_uri).toBe('pg://units/7');
    expect(e0.untrusted_payload).toBe(false);
    expect(e0.metadata).toMatchObject({ importer: 'postgres', author: 'a', channel: 'c1' });
    expect(harness.events[1]!.source_uri).toBe('pg://units/42');
    expect(src.stats.emitted).toBe(2);
  });

  test('dry-run maps + counts but emits nothing', async () => {
    const src = createPostgresSource({
      ...BASE,
      dryRun: true,
      _query: async () => [{ id: 1, body: 'x' }],
    });
    const harness = new IngestionTestHarness();
    await harness.run(src);
    expect(harness.events.length).toBe(0);
    expect(src.stats.total_rows).toBe(1);
    expect(src.stats.emitted).toBe(1); // counted as would-emit
  });

  test('per-row failure is isolated: bad rows skipped, good rows emitted', async () => {
    const src = createPostgresSource({
      ...BASE,
      _query: async () => [
        { id: 1, body: 'ok' },
        { id: 2, body: null }, // null content -> skipped
        { id: '', body: 'no id' }, // empty id -> skipped
        { id: 3, body: 'also ok' },
      ],
    });
    const harness = new IngestionTestHarness();
    await harness.run(src);
    expect(harness.validationErrors).toEqual([]);
    expect(harness.events.map((e) => e.source_uri)).toEqual([
      'postgres://rows/1',
      'postgres://rows/3',
    ]);
    expect(src.stats.skipped_invalid).toBe(2);
    expect((await src.healthCheck()).status).toBe('warn');
  });

  test('empty result set -> no events, healthy', async () => {
    const src = createPostgresSource({ ...BASE, _query: async () => [] });
    const harness = new IngestionTestHarness();
    await harness.run(src);
    expect(harness.events.length).toBe(0);
    expect((await src.healthCheck()).status).toBe('ok');
  });

  test('honors a pre-aborted signal (emits nothing)', async () => {
    const controller = new AbortController();
    controller.abort();
    const src = new PostgresSource({ ...BASE, _query: async () => [{ id: 1, body: 'x' }] });
    const ctx = makeCtx({ abortSignal: controller.signal });
    await src.start(ctx);
    expect(ctx.emitted.length).toBe(0);
  });

  test('healthCheck is warn before start', async () => {
    const src = createPostgresSource(BASE);
    expect((await src.healthCheck()).status).toBe('warn');
  });
});

// --- Integration smoke: real postgres client + server-side cursor. ---
// Gated on DATABASE_URL (CI docker Postgres), matching the repo's E2E convention.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('PostgresSource — integration (real cursor)', () => {
  test('streams a disposable synthetic table into valid events', async () => {
    const postgres = (await import('postgres')).default;
    // A NON-temp disposable table so the source's own pool/connection can see it.
    const sql2 = postgres(DB_URL!, { max: 1, onnotice: () => {} });
    const tbl = `pg_source_smoke_${process.pid}`;
    try {
      await sql2.unsafe(`CREATE TABLE ${tbl} (id int primary key, body text)`);
      await sql2.unsafe(
        `INSERT INTO ${tbl}(id, body) VALUES (1, 'alpha body'), (2, 'beta body'), (3, 'gamma body')`,
      );
      const src = createPostgresSource({
        databaseUrl: DB_URL!,
        query: `SELECT id, body FROM ${tbl} ORDER BY id`,
        contentColumn: 'body',
        idColumn: 'id',
        batchSize: 2, // force multiple cursor batches
      });
      const harness = new IngestionTestHarness();
      await harness.run(src);
      await src.stop();
      expect(harness.validationErrors).toEqual([]);
      expect(harness.events.map((e) => e.content)).toEqual(['alpha body', 'beta body', 'gamma body']);
      expect(harness.events[0]!.content_hash).toBe(computeContentHash('alpha body'));
    } finally {
      await sql2.unsafe(`DROP TABLE IF EXISTS ${tbl}`);
      await sql2.end({ timeout: 5 });
    }
  });
});
