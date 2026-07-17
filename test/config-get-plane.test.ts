/**
 * #2120 — `gbrain config get` must resolve the file/env plane, not just the
 * DB plane. Pre-fix, `get` called only `engine.getConfig(key)`, so a
 * runtime-effective key in ~/.gbrain/config.json reported not-found while
 * the runtime happily used it.
 *
 * Hermetic: GBRAIN_HOME points at a tmp dir (configDir() honors it) and the
 * engine is a getConfig-only stub — the `get` path touches nothing else.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(dbValues: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => dbValues[key] ?? null,
  } as unknown as BrainEngine;
}

describe('#2120 — config get resolves file plane with DB fallback', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedChatModel: string | undefined;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-config-get-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    savedHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    // loadConfig() overlays this env var onto the file plane — keep it out.
    savedChatModel = process.env.GBRAIN_CHAT_MODEL;
    delete process.env.GBRAIN_CHAT_MODEL;
    logs = [];
    errs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
    if (savedChatModel !== undefined) process.env.GBRAIN_CHAT_MODEL = savedChatModel;
    rmSync(home, { recursive: true, force: true });
  });

  function writeFileConfig(cfg: Record<string, unknown>): void {
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
  }

  test('file-plane key with no DB row is found (the pre-fix not-found bug)', async () => {
    writeFileConfig({ engine: 'pglite', chat_model: 'anthropic:claude-sonnet-4-6' });
    await runConfig(stubEngine({}), ['get', 'chat_model']);
    expect(logs).toContain('anthropic:claude-sonnet-4-6');
    expect(errs.join('\n')).toContain('file/env plane');
  });

  test('file plane wins over DB plane (matches runtime precedence) and reports the shadow', async () => {
    writeFileConfig({ engine: 'pglite', chat_model: 'anthropic:claude-sonnet-4-6' });
    await runConfig(stubEngine({ chat_model: 'openai:gpt-5' }), ['get', 'chat_model']);
    expect(logs).toContain('anthropic:claude-sonnet-4-6');
    expect(logs).not.toContain('openai:gpt-5');
    expect(errs.join('\n')).toContain('shadowed');
  });

  test('DB-plane-only key still resolves (no regression for dotted keys)', async () => {
    writeFileConfig({ engine: 'pglite' });
    await runConfig(stubEngine({ 'search.mode': 'balanced' }), ['get', 'search.mode']);
    expect(logs).toContain('balanced');
    expect(errs.join('\n')).toContain('db plane');
  });

  test('key in neither plane is still not-found (exit 1)', async () => {
    writeFileConfig({ engine: 'pglite' });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    try {
      await expect(runConfig(stubEngine({}), ['get', 'chat_model'])).rejects.toThrow('EXIT:1');
      expect(errs.join('\n')).toContain('Config key not found: chat_model');
    } finally {
      exitSpy.mockRestore();
    }
  });
});
