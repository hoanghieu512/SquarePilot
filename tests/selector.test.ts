import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import { recordSelection, selectPerspective } from '../src/perspective/selector.js';
import type { Angle } from '../src/perspective/angle-store.js';
import type { Lens } from '../src/perspective/lens-store.js';
import type { Trend } from '../src/collect/parse-trends.js';

const NOW = new Date('2026-08-21T00:00:00Z');

function trend(hashtag = '#USJoblessClaimsFallTo206000', over: Partial<Trend> = {}): Trend {
  return {
    hashtag,
    hashtagId: 1,
    rank: 1,
    viewCount: 137_290,
    contentCount: 1856,
    tradingPairs: [],
    ...over,
  };
}

function angle(over: Partial<Angle> = {}): Angle {
  return {
    path: '/vault/angles/a.md',
    articleId: 'a',
    title: 'Jobless claims and the settlement calendar',
    date: new Date('2026-08-15T00:00:00Z'),
    score: 8,
    status: 'unused',
    tags: ['jobless', 'macro'],
    guardrails: [],
    body: '',
    ...over,
  };
}

function lens(over: Partial<Lens> = {}): Lens {
  return {
    id: 'settlement-desk',
    path: '/vault/lenses/settlement-desk.md',
    name: 'Settlement Desk',
    appliesWhen: ['jobless', 'macro'],
    evidenceRequired: 'one concrete detail from the job',
    evidenceSource: 'author',
    cooldownDays: 4,
    lastUsed: null,
    useCount: 0,
    questions: [],
    ...over,
  };
}

const GOOD_EVIDENCE = ['Order state moves to settled only after the depository confirms, T+2.'];

describe('selectPerspective ladder', () => {
  it('refuses an angle that shares only one generic word with the trend', () => {
    // A Babylon TBV angle and #BitcoinBestWeekSinceMarch2023 share "bitcoin"
    // and nothing else. Pairing them is the stitched-together failure.
    const t = trend('#BitcoinBestWeekSinceMarch2023', { viewCount: 2503, contentCount: 263 });
    const result = selectPerspective({
      trend: t,
      allTrends: [t],
      angles: [angle({ title: 'Babylon TBV: native bitcoin collateral', tags: ['babylon', 'bitcoin'] })],
      lenses: [],
      now: NOW,
    });

    expect(result.outcome).not.toBe('angle');
    expect(result.rejected.some((r) => /too thin to pair/.test(r.reason))).toBe(true);
  });

  it('takes an angle first when one matches the trend', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [angle()],
      lenses: [lens()],
      lensEvidence: { 'settlement-desk': GOOD_EVIDENCE },
      now: NOW,
    });

    expect(result.outcome).toBe('angle');
  });

  it('falls to a lens when no angle matches', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [angle({ tags: ['solana'], title: 'Something about Solana bridges' })],
      lenses: [lens()],
      lensEvidence: { 'settlement-desk': GOOD_EVIDENCE },
      now: NOW,
    });

    expect(result.outcome).toBe('lens');
    if (result.outcome === 'lens') expect(result.perspective.ref).toBe('settlement-desk');
  });

  it('never uses an angle that has already been posted', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [angle({ status: 'posted' })],
      lenses: [],
      now: NOW,
    });

    expect(result.outcome).not.toBe('angle');
    expect(result.rejected.some((r) => r.reason.includes('posted'))).toBe(true);
  });

  it('never uses an angle older than the age limit', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [angle({ date: new Date('2026-05-03T00:00:00Z') })],
      lenses: [],
      now: NOW,
    });

    expect(result.outcome).not.toBe('angle');
    expect(result.rejected.some((r) => /days old/.test(r.reason))).toBe(true);
  });

  it('drops a lens with no evidence instead of using it weakened', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [],
      lenses: [lens()],
      lensEvidence: {}, // nothing was found
      now: NOW,
    });

    expect(result.outcome).not.toBe('lens');
    expect(result.rejected.some((r) => r.rung === 'lens' && /no evidence/.test(r.reason))).toBe(true);
  });

  it('skips a lens on cooldown', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [],
      lenses: [lens({ lastUsed: new Date('2026-08-20T00:00:00Z') })],
      lensEvidence: { 'settlement-desk': GOOD_EVIDENCE },
      now: NOW,
    });

    expect(result.outcome).not.toBe('lens');
    expect(result.rejected.some((r) => /cooldown/.test(r.reason))).toBe(true);
  });

  it('reaches a tension when two trends frame one story differently', () => {
    const a = trend('#DollarHits3MonthLow', { viewCount: 19_191, contentCount: 417 });
    const b = trend('#DollarFallsTo10WeekLow', { viewCount: 48_963, contentCount: 722 });

    const result = selectPerspective({
      trend: a,
      allTrends: [a, b],
      angles: [],
      lenses: [],
      now: NOW,
    });

    expect(result.outcome).toBe('tension');
    if (result.outcome === 'tension') {
      expect(result.perspective.summary).toContain('#DollarHits3MonthLow');
      expect(result.perspective.evidence.length).toBeGreaterThan(0);
    }
  });

  it('finds a scale tension when attention and discussion are far apart', () => {
    // 900 views across 90 posts: people are writing past an audience that is
    // not there. That imbalance is itself the observation.
    const t = trend('#TalkingToNobody', { viewCount: 900, contentCount: 90 });
    const result = selectPerspective({ trend: t, allTrends: [t], angles: [], lenses: [], now: NOW });

    expect(result.outcome).toBe('tension');
    if (result.outcome === 'tension') {
      expect(result.perspective.summary).toMatch(/outrunning the readership/);
    }
  });

  it('stops when every rung is exhausted, and returns no perspective at all', () => {
    const result = selectPerspective({
      trend: trend('#SomethingUnrelatedEntirely', { viewCount: 900, contentCount: 10 }),
      allTrends: [trend('#SomethingUnrelatedEntirely', { viewCount: 900, contentCount: 10 })],
      angles: [],
      lenses: [],
      now: NOW,
    });

    expect(result.outcome).toBe('stop');
    expect(result).not.toHaveProperty('perspective');
  });

  it('explains every rung it walked, even on a stop', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [angle({ status: 'posted' })],
      lenses: [lens({ appliesWhen: ['protocol'] })],
      now: NOW,
    });

    const rungs = new Set(result.rejected.map((r) => r.rung));
    expect(rungs.has('angle')).toBe(true);
    expect(rungs.has('lens')).toBe(true);
  });

  it('carries angle guardrails through to the chosen perspective', () => {
    const result = selectPerspective({
      trend: trend(),
      allTrends: [trend()],
      angles: [angle({ guardrails: ['Né hẳn price speculation $DUSK — brief cấm hoàn toàn.'] })],
      lenses: [],
      now: NOW,
    });

    if (result.outcome === 'angle') {
      expect(result.perspective.guardrails[0]).toMatch(/price speculation/);
    } else {
      expect.unreachable('expected the angle rung to win');
    }
  });
});

describe('recordSelection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#X', 1, 1000, 10, '2026-08-21T00:00:00Z')`,
    ).run();
  });
  afterEach(() => db.close());

  it('writes a stop row so a quiet day is distinguishable from a broken selector', () => {
    const result = selectPerspective({
      trend: trend('#Nothing', { viewCount: 900, contentCount: 10 }),
      allTrends: [trend('#Nothing', { viewCount: 900, contentCount: 10 })],
      angles: [angle({ status: 'posted' })],
      lenses: [],
      now: NOW,
    });

    recordSelection(db, 1, result, null);

    const row = db.prepare('SELECT outcome, source_ref, rejected_notes FROM selections').get() as {
      outcome: string;
      source_ref: string | null;
      rejected_notes: string;
    };
    expect(row.outcome).toBe('stop');
    expect(row.source_ref).toBeNull();
    expect(JSON.parse(row.rejected_notes).length).toBeGreaterThan(0);
  });
});

describe('consensus tension hygiene', () => {
  it('ignores the hashtag itself, in split, joined, and cashtag form', () => {
    // Every post under a tag repeats the tag. Counting those repeats reported a
    // consensus on every trend and meant nothing.
    const t = trend('#TRUMPBreaksAbove$3.4HighestSinceMarch21', { viewCount: 5900, contentCount: 102 });
    const posts = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      authorName: 'a',
      text: '#trumpbreaksabove$3.4highestsincemarch21 $TRUMP is moving again today',
      likeCount: 0,
      viewCount: 10,
    }));

    const result = selectPerspective({
      trend: t,
      allTrends: [t],
      angles: [],
      lenses: [],
      topPosts: posts,
      now: NOW,
    });

    if (result.outcome === 'tension') {
      const joined = result.perspective.evidence.join(' ');
      expect(joined).not.toMatch(/trumpbreaksabove/);
      expect(joined).not.toMatch(/\$trump/i);
    }
  });
});
