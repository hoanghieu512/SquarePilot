import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import { filterTrends, storeTrends, MIN_VIEW_COUNT } from '../src/collect/trend-collector.js';
import type { Trend } from '../src/collect/parse-trends.js';

function trend(hashtag: string, viewCount: number, rank = 1): Trend {
  return { hashtag, hashtagId: 1, rank, viewCount, contentCount: 10, tradingPairs: [] };
}

const NOW = '2026-08-21T00:00:00.000Z';
/** Fixed clock: the reuse window is relative, so a real date would make these
 *  assertions rot the moment fourteen days pass. */
const CLOCK = new Date(NOW);

describe('trend storage and filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('appends a snapshot per run rather than overwriting', () => {
    const batch = [trend('#A', 1000), trend('#B', 2000, 2)];
    storeTrends(db, batch, NOW);
    storeTrends(db, batch, '2026-08-21T06:00:00.000Z');

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM trends').get() as { n: number };
    const runs = db.prepare('SELECT COUNT(DISTINCT collected_at) AS n FROM trends').get() as { n: number };
    expect(n).toBe(4);
    expect(runs.n).toBe(2);
  });

  it('drops a trend below the view threshold even when it ranks first', () => {
    const trends = [trend('#BrandNew', 0, 1), trend('#Busy', 20_000, 2)];
    const ids = storeTrends(db, trends, NOW);

    const result = filterTrends(db, trends, ids, NOW);

    expect(result.eligible.map((t) => t.hashtag)).toEqual(['#Busy']);
    expect(result.rejected[0]).toMatchObject({ hashtag: '#BrandNew' });
    expect(result.rejected[0]!.reason).toMatch(/0 views/);
  });

  it('uses a threshold high enough to exclude a freshly created topic', () => {
    expect(MIN_VIEW_COUNT).toBeGreaterThan(0);
  });

  it('skips a hashtag already posted inside the reuse window', () => {
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#Old', 1, 9999, 10, '2026-08-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-08-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO drafts (selection_id, body, nfc_len, nfd_len, model_used, created_at)
       VALUES (1, 'body', 10, 10, 'm', '2026-08-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO posts (draft_id, content_snapshot, hashtag, published_at)
       VALUES (1, 'body', '#Old', '2026-08-19T00:00:00Z')`,
    ).run();

    const trends = [trend('#Old', 9999)];
    const ids = storeTrends(db, trends, NOW);
    const result = filterTrends(db, trends, ids, NOW, { now: CLOCK });

    expect(result.eligible).toHaveLength(0);
    expect(result.rejected[0]!.reason).toMatch(/already posted/);
  });

  it('matches a used hashtag regardless of case, since Square treats them as one topic', () => {
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#Old', 1, 9999, 10, '2026-08-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-08-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO drafts (selection_id, body, nfc_len, nfd_len, model_used, created_at)
       VALUES (1, 'body', 10, 10, 'm', '2026-08-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO posts (draft_id, content_snapshot, hashtag, published_at)
       VALUES (1, 'body', '#strategysells', '2026-08-20T00:00:00Z')`,
    ).run();

    const trends = [trend('#StrategySells', 9999)];
    const ids = storeTrends(db, trends, NOW);
    expect(filterTrends(db, trends, ids, NOW, { now: CLOCK }).eligible).toHaveLength(0);
  });

  it('lets a hashtag back in once it falls outside the reuse window', () => {
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#Old', 1, 9999, 10, '2026-07-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-07-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO drafts (selection_id, body, nfc_len, nfd_len, model_used, created_at)
       VALUES (1, 'body', 10, 10, 'm', '2026-07-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO posts (draft_id, content_snapshot, hashtag, published_at)
       VALUES (1, 'body', '#Old', ?)`,
    ).run(new Date(CLOCK.getTime() - 30 * 86_400_000).toISOString());

    const trends = [trend('#Old', 9999)];
    const ids = storeTrends(db, trends, NOW);
    expect(filterTrends(db, trends, ids, NOW, { now: CLOCK }).eligible).toHaveLength(1);
  });

  it('keeps every trend in `all`, so rejections stay auditable', () => {
    const trends = [trend('#Low', 1), trend('#High', 5000, 2)];
    const ids = storeTrends(db, trends, NOW);
    const result = filterTrends(db, trends, ids, NOW);

    expect(result.all).toHaveLength(2);
    expect(result.eligible).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });
});
