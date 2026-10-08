import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, TABLE_NAMES } from '../src/database/migrations.js';
import { closeDb, initDb, resetDb } from '../src/database/index.js';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => (r as { name: string }).name);
}

describe('migrations', () => {
  afterEach(() => {
    closeDb();
    resetDb();
  });

  it('creates all nine tables', () => {
    const db = memoryDb();
    const names = tableNames(db);
    for (const table of TABLE_NAMES) {
      expect(names).toContain(table);
    }
    expect(TABLE_NAMES).toHaveLength(9);
    db.close();
  });

  it('is idempotent — running twice changes nothing', () => {
    const db = memoryDb();
    const before = tableNames(db).sort();
    const versionsBefore = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };

    runMigrations(db);

    const after = tableNames(db).sort();
    const versionsAfter = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };

    expect(after).toEqual(before);
    expect(versionsAfter.n).toBe(versionsBefore.n);
    db.close();
  });

  it('rejects a selection outcome outside the ladder', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#Test', 1, 100, 5, '2026-08-20T00:00:00Z')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO selections (trend_id, outcome, created_at)
           VALUES (1, 'generated', '2026-08-20T00:00:00Z')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('records a stop with no source, so quiet days stay auditable', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#Test', 1, 100, 5, '2026-08-20T00:00:00Z')`,
    ).run();

    db.prepare(
      `INSERT INTO selections (trend_id, outcome, rejected_notes, created_at)
       VALUES (1, 'stop', ?, '2026-08-20T00:00:00Z')`,
    ).run(JSON.stringify(['no unused angle', 'all lenses on cooldown', 'no verifiable tension']));

    const row = db.prepare('SELECT outcome, rejected_notes FROM selections').get() as {
      outcome: string;
      rejected_notes: string;
    };
    expect(row.outcome).toBe('stop');
    expect(JSON.parse(row.rejected_notes)).toHaveLength(3);
    db.close();
  });

  it('initDb creates and reuses a single in-memory connection', () => {
    const first = initDb(':memory:');
    const second = initDb(':memory:');
    expect(second).toBe(first);
    expect(tableNames(first)).toContain('drafts');
  });
});
