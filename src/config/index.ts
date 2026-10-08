import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  openRouterApiKey: string;
  modelFree: string;
  modelPaid: string;
  contentCreatorDir: string;
  vaultDir: string;
  dbPath: string;
  logLevel: string;
}

/** Vars without a usable default. Missing any of these is fatal. */
const REQUIRED = ['OPENROUTER_API_KEY', 'CONTENT_CREATOR_DIR', 'VAULT_DIR'] as const;

const DEFAULTS = {
  OPENROUTER_MODEL_FREE: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  OPENROUTER_MODEL_PAID: 'anthropic/claude-sonnet-5',
  LOG_LEVEL: 'info',
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Read and validate configuration.
 *
 * Fails at startup rather than mid-pipeline: a run that dies after collecting
 * trends has already burned a Playwright session and may have marked state.
 * `env` is injectable so tests never touch process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in.',
    );
  }

  const contentCreatorDir = env.CONTENT_CREATOR_DIR!.trim();
  const vaultDir = env.VAULT_DIR!.trim();

  // These hold the tone rules and the lens bank. A wrong path here means the
  // bot writes in nobody's voice, which is worse than not writing at all.
  for (const [name, dir] of [
    ['CONTENT_CREATOR_DIR', contentCreatorDir],
    ['VAULT_DIR', vaultDir],
  ] as const) {
    if (!fs.existsSync(dir)) {
      throw new ConfigError(`${name} points to a directory that does not exist: ${dir}`);
    }
  }

  return {
    openRouterApiKey: env.OPENROUTER_API_KEY!.trim(),
    modelFree: env.OPENROUTER_MODEL_FREE?.trim() || DEFAULTS.OPENROUTER_MODEL_FREE,
    modelPaid: env.OPENROUTER_MODEL_PAID?.trim() || DEFAULTS.OPENROUTER_MODEL_PAID,
    contentCreatorDir,
    vaultDir,
    dbPath: env.SQUAREPILOT_DB_PATH?.trim() || path.join(os.homedir(), '.squarepilot', 'squarepilot.db'),
    logLevel: env.LOG_LEVEL?.trim() || DEFAULTS.LOG_LEVEL,
  };
}
