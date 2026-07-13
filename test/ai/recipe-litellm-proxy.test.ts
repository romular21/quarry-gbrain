import { describe, expect, test } from 'bun:test';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('recipe: litellm proxy', () => {
  test('registered with expected openai-compatible shape', () => {
    const r = getRecipe('litellm');
    expect(r).toBeDefined();
    expect(r!.id).toBe('litellm');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('http://localhost:4000');
    expect(r!.auth_env?.required ?? []).toEqual([]);
    expect(r!.auth_env?.optional ?? []).toContain('LITELLM_BASE_URL');
    expect(r!.auth_env?.optional ?? []).toContain('LITELLM_API_KEY');
  });

  test('chat touchpoint accepts arbitrary proxied model IDs', () => {
    const r = getRecipe('litellm')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models).toEqual([]);
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(() => assertTouchpoint(r, 'chat', 'gpt-4o')).not.toThrow();
    expect(() => assertTouchpoint(r, 'chat', 'deepseek-v4-pro')).not.toThrow();
  });

  test('embedding touchpoint still uses user-provided models and dimensions', () => {
    const r = getRecipe('litellm')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models).toEqual([]);
    expect(r.touchpoints.embedding!.user_provided_models).toBe(true);
    expect(r.touchpoints.embedding!.default_dims).toBe(0);
    expect(r.touchpoints.embedding!.no_batch_cap).toBe(true);
  });

  test('default auth honors LITELLM_API_KEY and ignores URL-only config', () => {
    const r = getRecipe('litellm')!;

    const noAuth = defaultResolveAuth(r, {}, 'chat');
    expect(noAuth.headerName).toBe('Authorization');
    expect(noAuth.token).toBe('Bearer unauthenticated');

    const urlOnly = defaultResolveAuth(r, { LITELLM_BASE_URL: 'http://proxy.example' }, 'chat');
    expect(urlOnly.token).toBe('Bearer unauthenticated');

    const withKey = defaultResolveAuth(r, {
      LITELLM_BASE_URL: 'http://proxy.example',
      LITELLM_API_KEY: 'sk-litellm-fake',
    }, 'chat');
    expect(withKey.token).toBe('Bearer sk-litellm-fake');
  });
});
