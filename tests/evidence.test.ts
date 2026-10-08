import { describe, expect, it } from 'vitest';
import {
  gatherDataEvidence,
  gatherDocsEvidence,
  gatherForLens,
  gatherAll,
  verifyQuote,
} from '../src/perspective/evidence.js';
import type { Lens } from '../src/perspective/lens-store.js';
import type { Trend } from '../src/collect/parse-trends.js';
import type { HashtagPost } from '../src/collect/hashtag-reader.js';

function trend(over: Partial<Trend> = {}): Trend {
  return {
    hashtag: '#USJoblessClaimsFallTo206000',
    hashtagId: 1,
    rank: 1,
    viewCount: 137_290,
    contentCount: 1856,
    tradingPairs: [],
    ...over,
  };
}

function post(text: string): HashtagPost {
  return { id: '1', authorName: 'a', text, likeCount: 0, viewCount: 10 };
}

function lens(over: Partial<Lens> = {}): Lens {
  return {
    id: 'l',
    path: '/l.md',
    name: 'L',
    appliesWhen: ['macro'],
    evidenceRequired: 'a real figure',
    evidenceSource: 'data',
    cooldownDays: 4,
    lastUsed: null,
    useCount: 0,
    questions: [],
    ...over,
  };
}

describe('verifyQuote', () => {
  it('confirms a quote that really appears in the source', () => {
    const source = 'Citadel proves the session is cryptographically valid. It does not decide policy.';
    expect(verifyQuote('It does not decide policy.', [source])).toBe(true);
  });

  it('rejects a plausible quote that appears nowhere', () => {
    const source = 'Citadel proves the session is cryptographically valid.';
    expect(verifyQuote('Citadel guarantees regulatory compliance end to end.', [source])).toBe(false);
  });

  it('ignores whitespace and case differences', () => {
    expect(verifyQuote('IT   DOES not decide POLICY', ['it does not decide policy today'])).toBe(true);
  });

  it('rejects a fragment too short to identify anything', () => {
    expect(verifyQuote('valid', ['the session is valid'])).toBe(false);
  });
});

describe('gatherDataEvidence', () => {
  it('states the trend numbers in a form that can be recomputed', () => {
    const [first] = gatherDataEvidence(trend(), []);
    expect(first).toContain('137290 views');
    expect(first).toContain('1856 posts');
  });

  it('quotes sentences that carry a figure', () => {
    const evidence = gatherDataEvidence(trend(), [
      post('Jobless claims came in at 206,000 this week, the lowest since March.'),
    ]);
    expect(evidence.some((e) => e.includes('206,000'))).toBe(true);
  });

  it('skips sentences with no figure — there is nothing to check in them', () => {
    const evidence = gatherDataEvidence(trend(), [
      post('This feels like a really important moment for the whole market right now.'),
    ]);
    expect(evidence.filter((e) => e.startsWith('A top post'))).toHaveLength(0);
  });

  it('every quoted sentence can be located in the post it came from', () => {
    const body = 'Claims fell to 206,000 this week. Analysts expected 215,000 instead.';
    const evidence = gatherDataEvidence(trend(), [post(body)]);

    for (const line of evidence.filter((e) => e.startsWith('A top post'))) {
      const quote = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
      expect(verifyQuote(quote, [body])).toBe(true);
    }
  });
});

describe('gatherDocsEvidence', () => {
  it('quotes only lines it can locate in the fetched document', () => {
    const doc = 'The protocol verifies the proof and records a session. Service policy stays off-chain entirely.';
    const evidence = gatherDocsEvidence({ 'https://docs.example/x': doc });

    expect(evidence).toHaveLength(1);
    const quote = evidence[0]!.slice(evidence[0]!.indexOf('"') + 1, evidence[0]!.lastIndexOf('"'));
    expect(verifyQuote(quote, [doc])).toBe(true);
  });
});

describe('gatherForLens', () => {
  it('feeds a data lens from the trend and its posts', () => {
    const result = gatherForLens(lens({ evidenceSource: 'data' }), {
      trend: trend(),
      topPosts: [post('Claims fell to 206,000 this week.')],
    });
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('gives a docs lens nothing when no document was fetched', () => {
    const result = gatherForLens(lens({ evidenceSource: 'docs' }), {
      trend: trend(),
      topPosts: [post('Claims fell to 206,000.')],
    });
    expect(result.evidence).toHaveLength(0);
    expect(result.reason).toMatch(/no document/);
  });

  it('gives an author lens nothing until a person supplies the note', () => {
    const result = gatherForLens(lens({ id: 'settlement-desk', evidenceSource: 'author' }), {
      trend: trend(),
      topPosts: [post('Claims fell to 206,000.')],
    });

    expect(result.evidence).toHaveLength(0);
    expect(result.reason).toMatch(/only the author can supply/);
  });

  it('uses an author note once supplied', () => {
    const result = gatherForLens(lens({ id: 'settlement-desk', evidenceSource: 'author' }), {
      trend: trend(),
      topPosts: [],
      authorNotes: { 'settlement-desk': ['Back office sees the batch, never the individual order.'] },
    });
    expect(result.evidence).toHaveLength(1);
  });

  it('defaults an unknown source to author, the conservative choice', () => {
    // A lens whose file forgets evidence_source must not be silently fed
    // scraped numbers as if they were the author's own knowledge.
    const l = lens({ evidenceSource: 'author' });
    expect(gatherForLens(l, { trend: trend(), topPosts: [post('206,000 claims')] }).evidence).toHaveLength(0);
  });
});

describe('gatherAll', () => {
  it('returns entries only for lenses that actually have evidence', () => {
    const evidence = gatherAll(
      [
        lens({ id: 'data-lens', evidenceSource: 'data' }),
        lens({ id: 'author-lens', evidenceSource: 'author' }),
      ],
      { trend: trend(), topPosts: [post('Claims fell to 206,000 this week.')] },
    );

    expect(Object.keys(evidence)).toEqual(['data-lens']);
  });
});
