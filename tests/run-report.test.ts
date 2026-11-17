import { describe, expect, it } from 'vitest';
import type { Candidate, PipelineResult } from '../src/pipeline.js';
import type { Rejection } from '../src/perspective/types.js';
import { explainStop, noPostReport } from '../src/deliver/run-report.js';

const AT = new Date('2026-11-17T06:00:00Z'); // 13:00 in Vietnam

function candidate(hashtag: string, over: Partial<Candidate> = {}): Candidate {
  return {
    trend: { hashtag, hashtagId: 1, rank: 1, viewCount: 9000, contentCount: 90, tradingPairs: [], trendId: 1 },
    topPosts: [],
    selection: { outcome: 'stop', rejected: [] },
    dataGate: null,
    mode: null,
    selectionId: 1,
    ...over,
  } as Candidate;
}

const angleUsed: Rejection = { rung: 'angle', candidate: 'Some angle', reason: 'status is "posted"' };
const noCover: Rejection = { rung: 'lens', candidate: 'the-calendar', reason: 'applies_when does not cover ipo' };
const noTension: Rejection = { rung: 'tension', candidate: 'other trends', reason: '2 tension(s) found, none about #X' };

describe('explainStop', () => {
  it('says where each rung of the ladder ran out', () => {
    expect(explainStop([angleUsed, noCover, noTension])).toBe('all angles used, no lens covers it, no tension about it');
  });

  it('names a lens that lacked evidence or is cooling down', () => {
    const r = explainStop([
      { rung: 'lens', candidate: 'settlement-desk', reason: 'no evidence for "settlement-desk"' },
      { rung: 'lens', candidate: 'the-calendar', reason: 'used 2 days ago, cooldown is 6 days' },
      noCover,
    ]);
    expect(r).toBe(
      'lens without evidence: settlement-desk, lens cooling down: the-calendar, other lenses do not cover it',
    );
  });
});

describe('noPostReport', () => {
  it('reports the trends page, the skipped trends and where each candidate stopped', () => {
    const result: PipelineResult = {
      candidates: [
        candidate('#AnthropicIPOTestsInvestorAppetiteForAI', {
          selection: { outcome: 'stop', rejected: [angleUsed, noCover, noTension] },
        }),
        candidate('#BitcoinHolds', {
          selection: {
            outcome: 'lens',
            perspective: { kind: 'lens', ref: 'the-calendar', summary: 's', evidence: ['e'], guardrails: [] },
            rejected: [],
          },
          dataGate: { ok: false, missing: ['focal_number'], found: [], reason: 'no headline figure in the top posts' },
        }),
      ],
      chosen: null,
      trends: {
        all: 10,
        eligible: 6,
        rejected: [
          { hashtag: '#A B', reason: 'hashtag has spaces, so the post text could not carry it whole' },
          { hashtag: '#Low', reason: 'only 120 views (minimum 1000)' },
          { hashtag: '#Low2', reason: 'only 300 views (minimum 1000)' },
          { hashtag: '#Old', reason: 'already posted within 14 days' },
        ],
      },
    };

    expect(noPostReport(result, AT)).toBe(
      [
        'SquarePilot 13:00: no post this run.',
        '10 trends, 6 eligible (skipped: 1 hashtag with spaces; 2 too few views; 1 posted recently).',
        '- #AnthropicIPOTestsInvestorAppetiteForAI: no perspective (all angles used, no lens covers it, no tension about it)',
        '- #BitcoinHolds: lens, but no card (no headline figure in the top posts)',
      ].join('\n'),
    );
  });

  it('says which gates the last attempt failed when a draft was written and dropped', () => {
    const chosen = candidate('#BitcoinHolds', {
      selection: {
        outcome: 'lens',
        perspective: { kind: 'lens', ref: 'x', summary: 's', evidence: ['e'], guardrails: [] },
        rejected: [],
      },
    });
    const attempt = (n: number, factsOk: boolean, shapeOk: boolean) => ({
      attempt: n,
      tier: 'paid' as const,
      toneOk: true,
      shapeOk,
      personaOk: true,
      factsOk,
      corrections: [],
    });
    const result = {
      candidates: [chosen],
      chosen,
      draft: { ok: false, attempts: [attempt(1, false, true), attempt(2, false, false)] },
    } as unknown as PipelineResult;

    expect(noPostReport(result, AT)).toContain(
      '- #BitcoinHolds: draft failed its gates after 2 attempts (last failed: shape, facts)',
    );
  });

  it('stays within one Zalo message', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      candidate(`#AVeryLongTrendingHashtagNumber${i}ThatGoesOnAndOnForever`, {
        selection: { outcome: 'stop', rejected: [angleUsed, noCover, noTension] },
      }),
    );
    expect(noPostReport({ candidates: many, chosen: null }, AT).length).toBeLessThanOrEqual(1800);
  });
});
