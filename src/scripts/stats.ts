import { ConfigError, loadConfig } from '../config/index.js';
import { closeDb, initDb } from '../database/index.js';
import { computeApprovalStats, formatApprovalStats } from '../stats/approval-stats.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('stats');

function parseSinceArg(argv: string[]): string | undefined {
  const flag = argv.indexOf('--since');
  if (flag === -1) return undefined;
  const val = argv[flag + 1]?.trim();
  if (!val || val.startsWith('--')) {
    throw new Error('--since takes a YYYY-MM-DD or ISO timestamp');
  }
  return val;
}

function main(): void {
  const since = parseSinceArg(process.argv);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const db = initDb(config.dbPath);
  try {
    const stats = computeApprovalStats(db, since !== undefined ? { since } : undefined);
    process.stdout.write(`${formatApprovalStats(stats)}\n`);
  } finally {
    closeDb();
  }
}

try {
  main();
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
