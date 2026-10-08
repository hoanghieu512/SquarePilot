import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrends, TrendParseError } from '../src/collect/parse-trends.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'trends-page.html');
const html = fs.readFileSync(FIXTURE, 'utf8');

/** Rebuild the page with a mutated __APP_DATA payload. */
function withPayload(mutate: (payload: Record<string, unknown>) => void): string {
  const match = html.match(/<script[^>]*id="__APP_DATA"[^>]*>([\s\S]*?)<\/script>/)!;
  const payload = JSON.parse(match[1]!) as Record<string, unknown>;
  mutate(payload);
  return html.replace(match[1]!, JSON.stringify(payload));
}

function hashTagsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const pageData = payload.pageData as { redux: { ui: { sidebarData: { hashTags: Record<string, unknown>[] } } } };
  return pageData.redux.ui.sidebarData.hashTags;
}

describe('parseTrends', () => {
  it('reads ten trends from a real captured page', () => {
    const trends = parseTrends(html);
    expect(trends).toHaveLength(10);
    for (const t of trends) {
      expect(t.hashtag.startsWith('#')).toBe(true);
      expect(t.viewCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('ranks by list order, starting at one', () => {
    const trends = parseTrends(html);
    expect(trends.map((t) => t.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('treats trading pairs as optional — Binance leaves them empty on most trends', () => {
    // Measured 2026-08-21: tradingPairDTOList empty on all ten,
    // topContent.tradingPairs present on one. Nothing downstream may require them.
    const trends = parseTrends(html);
    expect(trends.every((t) => Array.isArray(t.tradingPairs))).toBe(true);
    for (const pair of trends.flatMap((t) => t.tradingPairs)) {
      expect(pair.symbol).toBeTruthy();
      expect(pair.code).toBeTruthy();
    }
  });

  it('reads pairs from tradingPairDTOList', () => {
    const patched = withPayload((p) => {
      hashTagsOf(p)[0]!.tradingPairDTOList = [{ symbol: 'BTCUSDT', code: 'BTC', priceChange: '-1.2' }];
    });
    expect(parseTrends(patched)[0]!.tradingPairs).toEqual([
      { symbol: 'BTCUSDT', code: 'BTC', priceChange: '-1.2' },
    ]);
  });

  it('reads pairs from topContent.tradingPairs, the field actually populated in practice', () => {
    const patched = withPayload((p) => {
      hashTagsOf(p)[0]!.topContent = { tradingPairs: [{ symbol: 'ETHUSDT', code: 'ETH' }] };
    });
    expect(parseTrends(patched)[0]!.tradingPairs).toEqual([
      { symbol: 'ETHUSDT', code: 'ETH', priceChange: null },
    ]);
  });

  it('merges both pair sources without duplicating a symbol', () => {
    const patched = withPayload((p) => {
      const tag = hashTagsOf(p)[0]!;
      tag.tradingPairDTOList = [{ symbol: 'BTCUSDT', code: 'BTC' }];
      tag.topContent = {
        tradingPairs: [
          { symbol: 'BTCUSDT', code: 'BTC' },
          { symbol: 'BNBUSDT', code: 'BNB' },
        ],
      };
    });
    expect(parseTrends(patched)[0]!.tradingPairs.map((x) => x.symbol)).toEqual(['BTCUSDT', 'BNBUSDT']);
  });

  it('throws naming the missing field when the path changes', () => {
    const broken = withPayload((p) => {
      const pageData = p.pageData as { redux: { ui: { sidebarData: Record<string, unknown> } } };
      delete pageData.redux.ui.sidebarData.hashTags;
    });
    expect(() => parseTrends(broken)).toThrow(TrendParseError);
    expect(() => parseTrends(broken)).toThrow(/hashTags/);
  });

  it('names the exact ancestor that disappeared, not just the leaf', () => {
    const broken = withPayload((p) => {
      const pageData = p.pageData as { redux: { ui: Record<string, unknown> } };
      delete pageData.redux.ui.sidebarData;
    });
    expect(() => parseTrends(broken)).toThrow(/sidebarData/);
  });

  it('throws when a hashtag field is renamed rather than silently dropping the row', () => {
    const broken = withPayload((p) => {
      const tags = hashTagsOf(p);
      delete tags[0]!.hashtag;
    });
    expect(() => parseTrends(broken)).toThrow(/index 0.*hashtag/s);
  });

  it('treats an empty list as a broken page, never as a quiet day', () => {
    const broken = withPayload((p) => {
      const pageData = p.pageData as { redux: { ui: { sidebarData: Record<string, unknown> } } };
      pageData.redux.ui.sidebarData.hashTags = [];
    });
    expect(() => parseTrends(broken)).toThrow(/empty/i);
  });

  it('rejects a Cloudflare challenge page instead of returning nothing', () => {
    expect(() => parseTrends('<html><body>Just a moment...</body></html>')).toThrow(/challenge/i);
  });

  it('rejects malformed JSON', () => {
    const broken = html.replace(/(<script[^>]*id="__APP_DATA"[^>]*>)[\s\S]*?(<\/script>)/, '$1{nope$2');
    expect(() => parseTrends(broken)).toThrow(/not valid JSON/);
  });

  it('tolerates a missing viewCount by defaulting to zero — the filter will drop it anyway', () => {
    const patched = withPayload((p) => {
      const tags = hashTagsOf(p);
      delete tags[0]!.viewCount;
    });
    expect(parseTrends(patched)[0]!.viewCount).toBe(0);
  });
});
