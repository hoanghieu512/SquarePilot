import { describe, expect, it } from 'vitest';
import {
  HARD_CAP_NFD,
  TextValidationError,
  composePost,
  formatCount,
  measure,
  withinCap,
} from '../src/compose/text-validation.js';

const VI = 'Lệnh mua USDT gần đây, mình thấy hai mức giá cách nhau vài dòng: 25.793 và 26.672 đồng một USDT.';

describe('measure', () => {
  it('counts NFD higher than NFC for Vietnamese with diacritics', () => {
    const { nfc, nfd } = measure(VI);
    expect(nfd).toBeGreaterThan(nfc);
    // Measured ratio on real posts sits near 1.26; anything at 1.0 means the
    // NFD normalisation silently stopped working.
    expect(nfd / nfc).toBeGreaterThan(1.1);
  });

  it('counts English identically in both forms', () => {
    const { nfc, nfd } = measure('Jobless claims fell to 206,000 this week.');
    expect(nfc).toBe(nfd);
  });
});

describe('formatCount', () => {
  it('shows both numbers for Vietnamese, matching the vault convention', () => {
    const out = formatCount(VI);
    expect(out).toMatch(/NFC/);
    expect(out).toMatch(/NFD/);
    expect(out).toContain(String(HARD_CAP_NFD));
  });

  it('shows one number when the two forms agree', () => {
    expect(formatCount('Plain ASCII line.')).toMatch(/^\[char count: \d+\/2100\]$/);
  });
});

describe('composePost', () => {
  it('puts the hashtag first, since the API has no hashtag field', () => {
    const { body } = composePost('Some analysis here.', '#USJoblessClaims');
    expect(body.startsWith('#USJoblessClaims')).toBe(true);
  });

  it('adds the # when the caller omits it', () => {
    expect(composePost('Body.', 'Trend').body.startsWith('#Trend')).toBe(true);
  });

  it('budgets the hashtag before trimming, so the result never breaches the cap', () => {
    // A body that alone sits just under the cap: appending a tag afterwards
    // would push it over and the server would cut the tag - the one part that
    // routes the post.
    const long = 'Số liệu tuần này cho thấy một khoảng lệch đáng chú ý. '.repeat(40);
    const { body, lengths, truncated } = composePost(long, '#AVeryLongTrendingHashtagIndeed');

    expect(truncated).toBe(true);
    expect(lengths.nfd).toBeLessThanOrEqual(HARD_CAP_NFD);
    expect(body).toContain('#AVeryLongTrendingHashtagIndeed');
  });

  it('cuts whole paragraphs before sentences', () => {
    const body = ['First paragraph.', 'Second paragraph.', 'X'.repeat(3000)].join('\n\n');
    const { body: out } = composePost(body, '#T');
    expect(out).toContain('First paragraph.');
    expect(out).not.toContain('X'.repeat(100));
  });

  it('never cuts mid-word', () => {
    const { body } = composePost('alpha bravo charlie delta echo foxtrot '.repeat(200), '#T', 120);
    const lastWord = body.trim().split(/\s+/).pop()!;
    expect(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']).toContain(lastWord);
  });

  it('leaves a short body untouched', () => {
    const { truncated, body } = composePost('Short body.', '#T');
    expect(truncated).toBe(false);
    expect(body).toBe('#T\n\nShort body.');
  });

  it('refuses when the hashtag alone would not fit', () => {
    expect(() => composePost('Body.', '#Tag', 3)).toThrow(TextValidationError);
  });
});

describe('withinCap', () => {
  it('judges by NFD, not by .length', () => {
    // 1200 accented characters: under the cap by .length, over it by NFD.
    const dense = 'ế'.repeat(1200);
    expect(dense.length).toBeLessThan(HARD_CAP_NFD);
    expect(withinCap(dense)).toBe(false);
  });
});
