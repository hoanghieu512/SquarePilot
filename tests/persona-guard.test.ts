import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import {
  PERSONA_CAP_WINDOW,
  checkPersona,
  detectPersona,
  recentPostBodies,
} from '../src/compose/persona-guard.js';

const NAMES_JOB = "I've been a QA for eight years, and this looks familiar.";
const SHOWS_JOB = 'Put the expectation beside the outcome and the gap is the story. It usually is.';

describe('detectPersona', () => {
  it('catches the English forms', () => {
    expect(detectPersona(NAMES_JOB).mentionsPersona).toBe(true);
    expect(detectPersona('My day job is testing trading systems.').mentionsPersona).toBe(true);
  });

  it('catches the Vietnamese forms', () => {
    expect(detectPersona('Mình làm QA 8 năm rồi.').mentionsPersona).toBe(true);
    expect(detectPersona('Nghề của mình là kiểm thử.').mentionsPersona).toBe(true);
  });

  it('lets reasoning that shows the job through, without naming it', () => {
    // The craft answer: the discipline shows in how the argument is built.
    expect(detectPersona(SHOWS_JOB).mentionsPersona).toBe(false);
    expect(detectPersona('Suspect the inputs before you blame the system.').mentionsPersona).toBe(false);
  });

  it('does not fire on "quality" or "quantity" containing the letters', () => {
    expect(detectPersona('The quality of the data is the question.').mentionsPersona).toBe(false);
  });
});

describe('checkPersona', () => {
  it('allows naming the job when recent posts did not', () => {
    expect(checkPersona(NAMES_JOB, [SHOWS_JOB, SHOWS_JOB, SHOWS_JOB]).ok).toBe(true);
  });

  it('blocks a second mention inside the window', () => {
    const verdict = checkPersona(NAMES_JOB, [NAMES_JOB, SHOWS_JOB, SHOWS_JOB]);

    expect(verdict.ok).toBe(false);
    expect(verdict.recentCount).toBe(1);
    expect(verdict.reason).toMatch(/1 of the last 10/);
  });

  it('tells the drafter what to do instead of naming the job', () => {
    const verdict = checkPersona(NAMES_JOB, [NAMES_JOB]);
    expect(verdict.reason).toMatch(/stated position/);
    expect(verdict.reason).toMatch(/not in a byline/);
    expect(verdict.reason).toMatch(/synonym/);
  });

  it('never blocks a draft that does not name the job, however many recent ones did', () => {
    const verdict = checkPersona(SHOWS_JOB, [NAMES_JOB, NAMES_JOB, NAMES_JOB]);
    expect(verdict.ok).toBe(true);
  });

  it('only looks back as far as the window', () => {
    // The mention sits at position eleven, outside the ten-post window.
    const older = [...Array(10).fill(SHOWS_JOB), NAMES_JOB];
    expect(checkPersona(NAMES_JOB, older).ok).toBe(true);
  });

  it('keeps the window wide enough that one mention is genuinely rare', () => {
    // 1 in 10, set 2026-09-30. Must match the X pipeline's numbers.
    expect(PERSONA_CAP_WINDOW).toBe(10);
  });

  it('reproduces the X-pipeline failure: four in five would be blocked', () => {
    // Measured 2026-09-27 on outputs/x: 4 of 5 posts named the job. Under this
    // cap the second one onward is refused.
    const history = [NAMES_JOB, NAMES_JOB, NAMES_JOB, SHOWS_JOB, SHOWS_JOB];
    const verdict = checkPersona(NAMES_JOB, history);
    expect(verdict.ok).toBe(false);
    expect(verdict.recentCount).toBe(3);
  });
});

describe('recentPostBodies', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#T', 1, 9999, 10, '2026-09-30T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-09-30T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO drafts (selection_id, body, nfc_len, nfd_len, model_used, created_at)
       VALUES (1, 'b', 1, 1, 'm', '2026-09-30T00:00:00Z')`,
    ).run();
  });
  afterEach(() => db.close());

  it('returns published bodies newest first', () => {
    const insert = db.prepare(
      `INSERT INTO posts (draft_id, content_snapshot, hashtag, published_at) VALUES (1, ?, '#T', ?)`,
    );
    insert.run('older', '2026-09-01T00:00:00Z');
    insert.run('newer', '2026-09-20T00:00:00Z');

    expect(recentPostBodies(db)).toEqual(['newer', 'older']);
  });

  it('honours the window size', () => {
    const insert = db.prepare(
      `INSERT INTO posts (draft_id, content_snapshot, hashtag, published_at) VALUES (1, ?, '#T', ?)`,
    );
    for (let i = 0; i < 14; i++) {
      insert.run(`post-${i}`, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`);
    }

    expect(recentPostBodies(db)).toHaveLength(PERSONA_CAP_WINDOW);
  });
});
