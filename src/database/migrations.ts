import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('migrations');

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- Append-only snapshot, one row per hashtag per collector run.
      -- Keeping history is what lets us tell a durable trend from a spike.
      CREATE TABLE IF NOT EXISTS trends (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        hashtag       TEXT    NOT NULL,
        hashtag_id    INTEGER,
        rank          INTEGER NOT NULL,
        view_count    INTEGER NOT NULL DEFAULT 0,
        content_count INTEGER NOT NULL DEFAULT 0,
        trading_pairs TEXT    NOT NULL DEFAULT '[]',
        collected_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trends_hashtag   ON trends(hashtag);
      CREATE INDEX IF NOT EXISTS idx_trends_collected ON trends(collected_at);

      -- Index of angles/*.md in the vault. The file stays the place a human
      -- edits; this table only mirrors it, keyed by path.
      CREATE TABLE IF NOT EXISTS angles (
        path       TEXT PRIMARY KEY,
        article_id TEXT,
        title      TEXT,
        angle_date TEXT,
        score      REAL,
        status     TEXT NOT NULL DEFAULT 'unused',
        tags       TEXT NOT NULL DEFAULT '[]',
        guardrails TEXT,
        used_at    TEXT,
        synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_angles_status ON angles(status);

      -- Index of lenses/*.md. The file declares the rules; this table only
      -- counts usage, so cooldown survives an edit to the file.
      CREATE TABLE IF NOT EXISTS lenses (
        id                  TEXT PRIMARY KEY,
        path                TEXT NOT NULL UNIQUE,
        name                TEXT NOT NULL,
        applies_when        TEXT NOT NULL DEFAULT '[]',
        evidence_required   TEXT NOT NULL,
        cooldown_days       INTEGER NOT NULL DEFAULT 4,
        last_used           TEXT,
        use_count           INTEGER NOT NULL DEFAULT 0,
        synced_at           TEXT NOT NULL
      );

      -- Rejected tensions are kept on purpose: this is the rung most prone to
      -- fabrication, so it is the one we need to be able to audit.
      CREATE TABLE IF NOT EXISTS tensions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_id    INTEGER NOT NULL REFERENCES trends(id),
        claim       TEXT    NOT NULL,
        evidence    TEXT,
        accepted    INTEGER NOT NULL DEFAULT 0,
        reject_note TEXT,
        created_at  TEXT    NOT NULL
      );

      -- Every ladder run, including the ones that ended in "stop". Without the
      -- stops we cannot tell a quiet day from a broken selector.
      CREATE TABLE IF NOT EXISTS selections (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_id       INTEGER NOT NULL REFERENCES trends(id),
        outcome        TEXT    NOT NULL CHECK (outcome IN ('angle','lens','tension','stop')),
        source_ref     TEXT,
        mode           TEXT,
        rejected_notes TEXT    NOT NULL DEFAULT '[]',
        data_gate      TEXT,
        created_at     TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_selections_outcome ON selections(outcome);

      CREATE TABLE IF NOT EXISTS drafts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        selection_id   INTEGER NOT NULL REFERENCES selections(id),
        body           TEXT    NOT NULL,
        nfc_len        INTEGER NOT NULL,
        nfd_len        INTEGER NOT NULL,
        shape_vector   TEXT,
        tone_gate      TEXT,
        shape_gate     TEXT,
        model_used     TEXT    NOT NULL,
        escalated      INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','expired')),
        reject_reason  TEXT,
        created_at     TEXT    NOT NULL,
        resolved_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

      CREATE TABLE IF NOT EXISTS visuals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id    INTEGER NOT NULL REFERENCES drafts(id),
        visual_type TEXT    NOT NULL,
        mood        TEXT    NOT NULL CHECK (mood IN ('risk','neutral')),
        schema_json TEXT    NOT NULL,
        png_path    TEXT,
        bytes       INTEGER,
        created_at  TEXT    NOT NULL
      );

      -- content_snapshot is immutable: the record of what actually went out,
      -- independent of any later edit to the draft or the vault file.
      CREATE TABLE IF NOT EXISTS posts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id         INTEGER NOT NULL REFERENCES drafts(id),
        square_post_id   TEXT,
        content_snapshot TEXT    NOT NULL,
        hashtag          TEXT    NOT NULL,
        md_path          TEXT,
        png_path         TEXT,
        published_at     TEXT    NOT NULL
      );

      -- Separate from drafts so calls that produced nothing still get counted.
      CREATE TABLE IF NOT EXISTS llm_calls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id      INTEGER REFERENCES drafts(id),
        purpose       TEXT    NOT NULL,
        model         TEXT    NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL    NOT NULL DEFAULT 0,
        ok            INTEGER NOT NULL DEFAULT 1,
        error         TEXT,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_calls_model ON llm_calls(model);
    `,
  },
  {
    version: 2,
    name: 'draft_anchor_and_attempts',
    sql: `
      -- Which Rule E5 tier the pipeline assigned, so the derived quota can be
      -- counted and a week of runs shows where the anchor ladder lands.
      ALTER TABLE drafts ADD COLUMN anchor_tier TEXT
        CHECK (anchor_tier IN ('raw','bank','derived','stance'));
      ALTER TABLE drafts ADD COLUMN anchor_ref TEXT;
      -- tone_gate kept only the last attempt's tone result. Persona failing,
      -- then E5 failing on the rewrite, then persona again left no trace.
      ALTER TABLE drafts ADD COLUMN persona_gate TEXT;
      ALTER TABLE drafts ADD COLUMN attempts_json TEXT;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();

    logger.info(`Applied migration ${migration.version}: ${migration.name}`);
  }
}

export const MIGRATION_COUNT = MIGRATIONS.length;

export const TABLE_NAMES = [
  'trends',
  'angles',
  'lenses',
  'tensions',
  'selections',
  'drafts',
  'visuals',
  'posts',
  'llm_calls',
] as const;
