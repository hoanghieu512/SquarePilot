import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { ConfigError, loadConfig } from '../src/config/index.js';

const validEnv = {
  OPENROUTER_API_KEY: 'sk-or-test',
  CONTENT_CREATOR_DIR: os.tmpdir(),
  VAULT_DIR: os.tmpdir(),
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('names the exact variable that is missing', () => {
    const { OPENROUTER_API_KEY: _omitted, ...withoutKey } = validEnv;
    expect(() => loadConfig(withoutKey)).toThrow(ConfigError);
    expect(() => loadConfig(withoutKey)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('lists every missing variable at once, not just the first', () => {
    try {
      loadConfig({});
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('OPENROUTER_API_KEY');
      expect(message).toContain('CONTENT_CREATOR_DIR');
      expect(message).toContain('VAULT_DIR');
    }
  });

  it('treats whitespace as missing', () => {
    expect(() => loadConfig({ ...validEnv, OPENROUTER_API_KEY: '   ' })).toThrow(/OPENROUTER_API_KEY/);
  });

  it('rejects a prompt-asset directory that does not exist', () => {
    expect(() =>
      loadConfig({ ...validEnv, CONTENT_CREATOR_DIR: '/nope/not/here' }),
    ).toThrow(/CONTENT_CREATOR_DIR/);
  });

  it('falls back to default models when none are given', () => {
    const config = loadConfig(validEnv);
    expect(config.modelFree).toContain(':free');
    expect(config.modelPaid).not.toContain(':free');
  });

  it('honours explicit model overrides', () => {
    const config = loadConfig({
      ...validEnv,
      OPENROUTER_MODEL_FREE: 'some/other:free',
      OPENROUTER_MODEL_PAID: 'some/paid',
    });
    expect(config.modelFree).toBe('some/other:free');
    expect(config.modelPaid).toBe('some/paid');
  });
});
