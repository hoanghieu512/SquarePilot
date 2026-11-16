import { describe, expect, it } from 'vitest';
import { dropModelDisclaimer, groupLongNumbers } from '../src/compose/post-format.js';
import { groupDigits } from '../src/utils/numbers.js';

describe('groupDigits', () => {
  it('writes counts the way an English reader expects', () => {
    expect(groupDigits(283050)).toBe('283,050');
    expect(groupDigits(2344)).toBe('2,344');
    expect(groupDigits(950)).toBe('950');
  });
});

describe('groupLongNumbers', () => {
  it('adds thousands separators to bare counts and prices', () => {
    // 2026-11-16: the first draft to pass every gate read "283050 views
    // across 2344 posts".
    expect(groupLongNumbers('There are 283050 views across 2344 posts.')).toBe(
      'There are 283,050 views across 2,344 posts.',
    );
    expect(groupLongNumbers('BTC slid below $70000 again.')).toBe('BTC slid below $70,000 again.');
    expect(groupLongNumbers('Supply hit 1234567890.')).toBe('Supply hit 1,234,567,890.');
  });

  it('leaves years, grouped numbers, decimals, times and codes alone', () => {
    const untouched = [
      'Lowest since 2025, and again in 2026.',
      'Already 283,050 views.',
      'A 0.12345 ratio and 12345.67 units.',
      'Opens at 13:00 UTC.',
      '#About64000BitcoinMiningMachinesReportedlyHijacked',
      'See https://example.com/post/123456789 for it.',
      'Ticker $1INCH and 10000x leverage.',
      'Block 12345abc.',
    ];
    for (const text of untouched) expect(groupLongNumbers(text), text).toBe(text);
  });

  it('never touches the hashtag line at the top of a post', () => {
    expect(groupLongNumbers('#TONStrategyReports$23970000Loss\n\nUp 15000 users.')).toBe(
      '#TONStrategyReports$23970000Loss\n\nUp 15,000 users.',
    );
  });
});

describe('dropModelDisclaimer', () => {
  it('removes a disclaimer the model wrote itself, since one is appended', () => {
    // The same draft ended with "Not investment advice." and then the
    // appended "*Not financial advice.*".
    expect(dropModelDisclaimer('Body.\n\nLast point.\n\nNot investment advice.')).toBe('Body.\n\nLast point.');
    expect(dropModelDisclaimer('Body.\n\n*Not financial advice. DYOR.*')).toBe('Body.');
    expect(dropModelDisclaimer('Body.\n\nNFA, DYOR.')).toBe('Body.');
  });

  it('keeps a closing paragraph that only mentions advice in passing', () => {
    const text = 'Body.\n\nNot investment advice is what everyone gives, and then they trade on it anyway, every single week.';
    expect(dropModelDisclaimer(text)).toBe(text);
    expect(dropModelDisclaimer('Body.\n\nDo your own math.')).toBe('Body.\n\nDo your own math.');
  });
});
