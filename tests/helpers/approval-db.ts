import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import type { VisualSchema } from '../../src/compose/data-gate.js';

export function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export interface SeedDraft {
  hashtag?: string;
  outcome?: 'angle' | 'lens' | 'tension';
  sourceRef?: string | null;
  summary?: string | null;
  mode?: string;
  body?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt?: string;
  modelTier?: string;
  escalated?: boolean;
  anchorTier?: string | null;
  anchorRef?: string | null;
}

/** A trend, a selection and a draft that passed every gate. Returns the draft id. */
export function seedDraft(db: Database.Database, over: SeedDraft = {}): number {
  const trend = db
    .prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES (?, 1, 9999, 10, '2026-11-15T00:00:00Z')`,
    )
    .run(over.hashtag ?? '#BTCHolds');
  const selection = db
    .prepare(
      `INSERT INTO selections (trend_id, outcome, source_ref, perspective_summary, mode, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-11-15T00:00:00Z')`,
    )
    .run(
      trend.lastInsertRowid,
      over.outcome ?? 'lens',
      over.sourceRef === undefined ? 'funding-mood' : over.sourceRef,
      over.summary === undefined ? 'Funding is a mood, not a signal' : over.summary,
      over.mode ?? 'observe',
    );
  const draft = db
    .prepare(
      `INSERT INTO drafts
         (selection_id, body, nfc_len, nfd_len, tone_gate, shape_gate, persona_gate, fact_gate,
          anchor_tier, anchor_ref, model_used, escalated, status, created_at)
       VALUES (?, ?, ?, ?, 'pass', 'pass', 'pass', 'pass', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      selection.lastInsertRowid,
      over.body ?? '#BTCHolds\n\nVolume rose 12% while price held $68k.',
      120,
      124,
      over.anchorTier === undefined ? 'stance' : over.anchorTier,
      over.anchorRef ?? null,
      over.modelTier ?? 'free',
      over.escalated ? 1 : 0,
      over.status ?? 'pending',
      over.createdAt ?? '2026-11-15T01:00:00.000Z',
    );
  return Number(draft.lastInsertRowid);
}

export function seedVisual(
  db: Database.Database,
  draftId: number,
  over: {
    schema?: Partial<VisualSchema>;
    pngPath?: string | null;
    imageUrl?: string | null;
    /** Whether the card reached the chat. Default: yes when it has an image URL. */
    offered?: boolean;
  } = {},
): number {
  const schema: Partial<VisualSchema> = over.schema ?? {
    visual_type: 'macro_card',
    mood_variant: 'neutral',
    headline_1: 'BTC HOLDS',
    focal_number: '12%',
    stat_tiles: [
      { label: 'views', value: '137K' },
      { label: 'posts', value: '1.9K' },
    ],
  };
  const imageUrl =
    over.imageUrl === undefined ? `https://public.bnbstatic.com/card-${draftId}.png` : over.imageUrl;
  const info = db
    .prepare(
      `INSERT INTO visuals
         (draft_id, visual_type, mood, schema_json, png_path, bytes, image_url, offered_at, created_at)
       VALUES (?, 'macro_card', 'neutral', ?, ?, 1000, ?, ?, '2026-11-15T01:00:00.000Z')`,
    )
    .run(
      draftId,
      JSON.stringify(schema),
      over.pngPath === undefined ? `/tmp/card-${draftId}.png` : over.pngPath,
      imageUrl,
      (over.offered ?? imageUrl !== null) ? '2026-11-15T01:00:00.000Z' : null,
    );
  return Number(info.lastInsertRowid);
}
