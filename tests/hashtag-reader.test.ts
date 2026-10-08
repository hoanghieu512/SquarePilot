import { describe, expect, it } from 'vitest';
import { parseHashtagPosts, HashtagReadError } from '../src/collect/hashtag-reader.js';

/** Shape captured from the live endpoint on 2026-08-21. */
const realish = {
  code: '000000',
  success: true,
  data: {
    hashtag: '#StrategySellsStockToRepurchasePreferred',
    rank: 2,
    feedData: [
      {
        id: '357218920297201',
        title: null,
        subTitle: null,
        content: '#strategysellsstocktorepurchasepreferred \nStrategy just sold $333.7M of stock...',
        authorName: 'TuilaNamKy',
        likeCount: 4,
        viewCount: 3717,
      },
      {
        id: '357218920297202',
        title: 'A titled article',
        subTitle: null,
        content: null,
        authorName: 'SomeoneElse',
        likeCount: 0,
        viewCount: 12,
      },
    ],
  },
};

describe('parseHashtagPosts', () => {
  it('reads posts from data.feedData', () => {
    const posts = parseHashtagPosts(realish);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      id: '357218920297201',
      authorName: 'TuilaNamKy',
      likeCount: 4,
      viewCount: 3717,
    });
  });

  it('falls back through content, subTitle, then title for the body', () => {
    const posts = parseHashtagPosts(realish);
    expect(posts[0]!.text).toContain('Strategy just sold');
    expect(posts[1]!.text).toBe('A titled article');
  });

  it('drops entries with no readable text', () => {
    const posts = parseHashtagPosts({
      data: { feedData: [{ id: '1', content: null, subTitle: null, title: null }] },
    });
    expect(posts).toHaveLength(0);
  });

  it('throws naming data.feedData when the payload shape changes', () => {
    expect(() => parseHashtagPosts({ data: { vos: [] } })).toThrow(HashtagReadError);
    expect(() => parseHashtagPosts({ data: { vos: [] } })).toThrow(/data\.feedData/);
  });

  it('throws on a response with no data object', () => {
    expect(() => parseHashtagPosts({ code: '000000' })).toThrow(/"data"/);
  });

  it('throws on a non-object response', () => {
    expect(() => parseHashtagPosts(null)).toThrow(/non-object/);
  });
});
