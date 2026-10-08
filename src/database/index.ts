import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('database');

let dbInstance: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  if (dbInstance) return dbInstance;

  const isMemory = dbPath === ':memory:';
  if (!isMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Created database directory: ${dir}`);
    }
  }

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  runMigrations(dbInstance);

  logger.info(`Database connected: ${isMemory ? ':memory:' : dbPath}`);
  return dbInstance;
}

export function getDb(): Database.Database {
  if (!dbInstance) throw new Error('Database not initialised — call initDb() first');
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** Drop the singleton so tests can open a fresh :memory: database. */
export function resetDb(): void {
  dbInstance = null;
}

export { runMigrations, TABLE_NAMES } from './migrations.js';
