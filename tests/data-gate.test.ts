import { describe, expect, it } from 'vitest';
import { CAPS, extractNumbers, hashtagToHeadline, runDataGate } from '../src/compose/data-gate.js';
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
  return { id: '1', authorName: 'someone', text, likeCount: 0, viewCount: 100 };
}

describe('hashtagToHeadline', () => {
  it('splits CamelCase and digits into readable words', () => {
    expect(hashtagToHeadline('#USJoblessClaimsFallTo206000')).toBe('US JOBLESS CLAIMS FALL TO 206000');
  });

  it('handles a hashtag with symbols', () => {
    expect(hashtagToHeadline('#SanDiskStockJumpsNearly14%')).toContain('14%');
  });
});

describe('extractNumbers', () => {
  it('finds figures worth putting on a card', () => {
    const numbers = extractNumbers([post('Strategy sold $333.7M of stock while BTC fell 2.4%')]);
    expect(numbers).toContain('$333.7M');
    expect(numbers).toContain('2.4%');
  });

  it('ignores bare small integers, which count nothing in particular', () => {
    expect(extractNumbers([post('There are 3 things to note and 12 more later')])).toEqual([]);
  });

  it('drops figures too long for the focal cap', () => {
    const numbers = extractNumbers([post('The value was 123456789012345678 exactly')]);
    expect(numbers.every((n) => n.length <= CAPS.focal_number)).toBe(true);
  });

  it('deduplicates repeated figures', () => {
    const numbers = extractNumbers([post('$5.2B and again $5.2B and once more $5.2B')]);
    expect(numbers.filter((n) => n === '$5.2B')).toHaveLength(1);
  });
});

describe('runDataGate', () => {
  it('passes when the top posts supply a headline figure', () => {
    const result = runDataGate({
      trend: trend(),
      topPosts: [post('Jobless claims fell to 206,000, the lowest print since $1.2B in revisions')],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.available.focal_number).toBeTruthy();
      expect(result.available.stat_tiles!.length).toBeGreaterThanOrEqual(2);
      expect(result.available.brand_mark).toBe('@lavopavden · exploits / tokenomics');
    }
  });

  it('fails when no post carries a usable figure — a stat card with no number is not a visual', () => {
    const result = runDataGate({
      trend: trend(),
      topPosts: [post('Everyone is talking about this today and it feels significant')],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('focal_number');
      expect(result.reason).toMatch(/not a visual/);
    }
  });

  it('fails when there are no posts at all to mine', () => {
    expect(runDataGate({ trend: trend(), topPosts: [] }).ok).toBe(false);
  });

  it('always fills the two tiles that trend metadata guarantees', () => {
    // priceChange is almost always null, so views and posts are the only
    // figures available without reading the posts themselves.
    const result = runDataGate({ trend: trend(), topPosts: [post('BTC hit $79,400 this week')] });
    if (!result.ok) expect.unreachable('gate should have passed');

    const labels = result.available.stat_tiles!.map((t) => t.label);
    expect(labels).toContain('views');
    expect(labels).toContain('posts');
  });

  it('honours the per-field caps from the visual guidelines', () => {
    const result = runDataGate({
      trend: trend({ hashtag: '#AnExtremelyLongHashtagAboutSomethingVeryComplicatedIndeed' }),
      topPosts: [post('The figure was $12.5B in total')],
    });
    if (!result.ok) expect.unreachable('gate should have passed');

    const a = result.available;
    expect(a.headline_1!.length).toBeLessThanOrEqual(CAPS.headline_line);
    expect(a.headline_2?.length ?? 0).toBeLessThanOrEqual(CAPS.headline_line);
    expect(a.focal_number!.length).toBeLessThanOrEqual(CAPS.focal_number);
    for (const tile of a.stat_tiles!) {
      expect(tile.value.length).toBeLessThanOrEqual(CAPS.stat_value);
    }
  });

  it('defaults to the neutral macro card, since a falling number is not a warning', () => {
    const result = runDataGate({ trend: trend(), topPosts: [post('Yield hit 5.12% today')] });
    if (!result.ok) expect.unreachable('gate should have passed');

    expect(result.available.mood_variant).toBe('neutral');
    expect(result.available.visual_type).toBe('macro_card');
    expect(result.available.top_label).toBe('MACRO CARD');
  });

  it('compacts large counts so they fit a tile', () => {
    const result = runDataGate({
      trend: trend({ viewCount: 137_290 }),
      topPosts: [post('claims came in at 206,000')],
    });
    if (!result.ok) expect.unreachable('gate should have passed');

    const views = result.available.stat_tiles!.find((t) => t.label === 'views')!;
    expect(views.value).toBe('137.3K');
  });
});

describe('hashtagToHeadline currency handling', () => {
  it('separates a word that follows a percent sign', () => {
    expect(hashtagToHeadline('#BTCDrops3.4%To$77383')).toBe('BTC DROPS 3.4% TO $77383');
  });

  it('separates a currency figure that runs into the surrounding words', () => {
    expect(hashtagToHeadline('#TRUMPBreaksAbove$3.4HighestSinceMarch21')).toBe(
      'TRUMP BREAKS ABOVE $3.4 HIGHEST SINCE MARCH 21',
    );
  });
});

describe('figures that are not statistics', () => {
  it('skips a bare year, which is the most eye-catching thing on a card and means nothing', () => {
    // Seen on the first rendered card: "FY2026 Q4" put 2026 on the panel.
    const numbers = extractNumbers([post('Micron FY2026 Q4 earnings land at $12.5B')]);
    expect(numbers).not.toContain('2026');
    expect(numbers).toContain('$12.5B');
  });

  it('keeps a four-digit number that is not a year', () => {
    expect(extractNumbers([post('The reading came in at 1,250 units')])).toContain('1,250');
  });

  it('drops a figure too long for a tile rather than truncating it into a different number', () => {
    // Slicing "29,000" to the 8-char cap produced "29," on the first card.
    const result = runDataGate({
      trend: trend(),
      topPosts: [post('Headline was $12.5B, with 29,000,000 units and 86% share')],
    });
    if (!result.ok) expect.unreachable('gate should have passed');

    for (const tile of result.available.stat_tiles!) {
      expect(tile.value).not.toMatch(/[,.]$/);
      expect(tile.value.length).toBeLessThanOrEqual(CAPS.stat_value);
    }
  });
});

describe('numbers mangled by punctuation', () => {
  it('does not take a sentence-ending period as part of the number', () => {
    // Rendered card showed "7." as the headline figure, from "GPT-7. The agent".
    const numbers = extractNumbers([post('They shipped GPT-7. The agent runs $4.2B in volume.')]);
    expect(numbers).not.toContain('7.');
    expect(numbers.every((n) => !/[.,]$/.test(n))).toBe(true);
  });

  it('requires a figure to carry a unit or real magnitude', () => {
    expect(extractNumbers([post('There were 55 posts and 772 views.')])).not.toContain('55');
  });

  it('still keeps figures that mean something', () => {
    const numbers = extractNumbers([post('Volume hit $4.2B, up 86%, across 29,000 wallets.')]);
    expect(numbers).toContain('$4.2B');
    expect(numbers).toContain('86%');
  });
});
