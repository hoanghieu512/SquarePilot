import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import { recentAnchorTiers, recordDraft, type ComposeOutcome } from '../src/compose/compose-draft.js';

function outcome(over: Partial<ComposeOutcome> = {}): ComposeOutcome {
  return {
    ok: false,
    body: '#T\n\nBody.',
    lengths: { nfc: 10, nfd: 10 },
    tier: 'paid',
    escalated: true,
    anchor: { tier: 'bank', ref: 'A01', material: ['x'], mayNameJob: false },
    attempts: [
      {
        attempt: 1,
        tier: 'free',
        toneOk: true,
        shapeOk: true,
        personaOk: false,
        corrections: ['Names the job (QA) but 1 of the last 10 posts already did.'],
      },
      {
        attempt: 2,
        tier: 'paid',
        toneOk: false,
        shapeOk: true,
        personaOk: true,
        corrections: ['E5 - fabricated - "I pulled the last three prints this morning"'],
      },
    ],
    ...over,
  };
}

describe('recordDraft', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#T', 1, 9999, 10, '2026-10-04T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-10-04T00:00:00Z')`,
    ).run();
  });
  afterEach(() => db.close());

  const row = (id: number) =>
    db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Record<string, unknown>;

  it('records which anchor the draft was given', () => {
    const id = recordDraft(db, 1, outcome());

    expect(row(id).anchor_tier).toBe('bank');
    expect(row(id).anchor_ref).toBe('A01');
  });

  it('keeps every attempt, so a gate ping-pong shows up in the database', () => {
    // Before: only the last attempt's tone corrections were stored, and the
    // persona result not at all. Persona then E5 then persona read as "failed".
    const id = recordDraft(db, 1, outcome());
    const attempts = JSON.parse(String(row(id).attempts_json)) as { personaOk: boolean }[];

    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.personaOk).toBe(false);
    expect(String(row(id).attempts_json)).toContain('E5 - fabricated');
  });

  it('records the persona gate of the last attempt in its own column', () => {
    const id = recordDraft(db, 1, outcome());
    expect(row(id).persona_gate).toBe('pass');
  });
});

describe('recentAnchorTiers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#T', 1, 9999, 10, '2026-10-04T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-10-04T00:00:00Z')`,
    ).run();
  });
  afterEach(() => db.close());

  function publish(tier: string, at: string): void {
    const id = recordDraft(
      db,
      1,
      outcome({ anchor: { tier: tier as 'derived', ref: null, material: [], mayNameJob: true } }),
    );
    db.prepare(
      `INSERT INTO posts (draft_id, content_snapshot, hashtag, published_at) VALUES (?, 'b', '#T', ?)`,
    ).run(id, at);
  }

  it('lists the anchor tiers of published posts, newest first', () => {
    publish('derived', '2026-10-01T00:00:00Z');
    publish('stance', '2026-10-03T00:00:00Z');

    expect(recentAnchorTiers(db)).toEqual(['stance', 'derived']);
  });

  it('ignores drafts that were never published', () => {
    recordDraft(db, 1, outcome());
    expect(recentAnchorTiers(db)).toEqual([]);
  });
});
