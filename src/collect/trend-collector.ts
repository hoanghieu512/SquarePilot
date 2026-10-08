import type Database from 'better-sqlite3';
import { fetchRenderedHtml } from './browser.js';
import { parseTrends, type Trend } from './parse-trends.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('trends');

const TRENDS_URL = 'https://www.binance.com/en/square/trends';
const APP_DATA_MARKER = '__APP_DATA';

/**
 * A hashtag can rank #1 with 0 views — the page shows brand-new topics before
 * anyone has read them. Posting into an empty room wastes the day's only slot,
 * so views, not rank, decide whether a trend is worth writing about.
 */
export const MIN_VIEW_COUNT = 500;

/** Same story twice in a fortnight reads as a rerun. */
export const REUSE_WINDOW_DAYS = 14;

export interface EligibleTrend extends Trend {
  trendId: number;
}

export interface CollectResult {
  collectedAt: string;
  all: Trend[];
  eligible: EligibleTrend[];
  rejected: { hashtag: string; reason: string }[];
}

export async function fetchTrends(headed = false): Promise<Trend[]> {
  const html = await fetchRenderedHtml({
    url: TRENDS_URL,
    waitForMarker: APP_DATA_MARKER,
    headed,
  });
  return parseTrends(html);
}

/** Append-only: every run is its own snapshot, so trend durability stays visible. */
export function storeTrends(db: Database.Database, trends: Trend[], collectedAt: string): number[] {
  const insert = db.prepare(
    `INSERT INTO trends (hashtag, hashtag_id, rank, view_count, content_count, trading_pairs, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: number[] = [];
  db.transaction(() => {
    for (const t of trends) {
      const info = insert.run(
        t.hashtag,
        t.hashtagId,
        t.rank,
        t.viewCount,
        t.contentCount,
        JSON.stringify(t.tradingPairs),
        collectedAt,
      );
      ids.push(Number(info.lastInsertRowid));
    }
  })();
  return ids;
}

function recentlyPosted(db: Database.Database, windowDays: number, now: Date): Set<string> {
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare('SELECT DISTINCT hashtag FROM posts WHERE published_at >= ?')
    .all(cutoff) as { hashtag: string }[];
  return new Set(rows.map((r) => r.hashtag.toLowerCase()));
}

export interface FilterOptions {
  minViewCount?: number;
  reuseWindowDays?: number;
  /** Injectable clock. Without it the reuse window is measured against the
   *  real date, which makes any test of it rot as soon as time passes. */
  now?: Date;
}

export function filterTrends(
  db: Database.Database,
  trends: Trend[],
  trendIds: number[],
  collectedAt: string,
  options: FilterOptions = {},
): CollectResult {
  const minViews = options.minViewCount ?? MIN_VIEW_COUNT;
  const windowDays = options.reuseWindowDays ?? REUSE_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const used = recentlyPosted(db, windowDays, now);

  const eligible: EligibleTrend[] = [];
  const rejected: { hashtag: string; reason: string }[] = [];

  trends.forEach((trend, i) => {
    if (trend.viewCount < minViews) {
      rejected.push({
        hashtag: trend.hashtag,
        reason: `only ${trend.viewCount} views (minimum ${minViews})`,
      });
      return;
    }
    // Hashtags are case-insensitive on Square: the trends list shows CamelCase
    // while the hashtag page shows lowercase, and both resolve to one topic.
    if (used.has(trend.hashtag.toLowerCase())) {
      rejected.push({ hashtag: trend.hashtag, reason: `already posted within ${windowDays} days` });
      return;
    }
    eligible.push({ ...trend, trendId: trendIds[i]! });
  });

  return { collectedAt, all: trends, eligible, rejected };
}

export async function collectTrends(
  db: Database.Database,
  options: FilterOptions & { headed?: boolean } = {},
): Promise<CollectResult> {
  const trends = await fetchTrends(options.headed);
  const collectedAt = new Date().toISOString();
  const ids = storeTrends(db, trends, collectedAt);

  const result = filterTrends(db, trends, ids, collectedAt, options);
  logger.info(
    `Collected ${trends.length} trends — ${result.eligible.length} eligible, ${result.rejected.length} rejected`,
  );
  for (const r of result.rejected) logger.debug(`  skip ${r.hashtag}: ${r.reason}`);

  return result;
}
