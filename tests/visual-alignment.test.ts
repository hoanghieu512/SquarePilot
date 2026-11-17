import { describe, expect, it } from 'vitest';
import { alignVisualToDraft, focalCaption } from '../src/compose/visual-alignment.js';
import { extractFigures } from '../src/compose/fact-figures.js';
import type { VisualSchema } from '../src/compose/data-gate.js';

const base: Partial<VisualSchema> = {
  headline_1: 'BITCOIN HOLDS',
  focal_number: '$68k',
  stat_tiles: [
    { label: 'views', value: '137K' },
    { label: 'posts', value: '1.9K' },
    { label: 'cited', value: '2.5%' },
  ],
};
const opts = { currentYear: 2026 };

describe('alignVisualToDraft', () => {
  it('keeps a card exactly as is when the draft writes the same figures', () => {
    const r = alignVisualToDraft(base, 'Price sits near $68k and 2.5% up on the month.', opts);
    // Unchanged but for the line that says what the number is.
    expect(r).toEqual({ ok: true, schema: { ...base, focal_subline: 'Price sits' }, changed: [] });
  });

  it("writes the card's figures the way the draft writes them", () => {
    // Card from a top post says 2.47%, the draft rounds to 2.5%: same figure, the
    // card must show the draft's version. And the other direction for $68k.
    const r = alignVisualToDraft(
      { focal_number: '2.47%', stat_tiles: [{ label: 'cited', value: '$68k' }] },
      'Up 2.5% on the month, with price at $68,214.',
      opts,
    );
    expect(r.ok && r.schema.focal_number).toBe('2.5%');
    expect(r.ok && r.schema.stat_tiles).toEqual([{ label: 'cited', value: '$68,214' }]);
  });

  it('replaces a focal number the draft never states with a figure from the draft', () => {
    const r = alignVisualToDraft(base, 'Volume rose 12% while price went nowhere. 2.5% on the month.', opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema.focal_number).toBe('12%');
    expect(r.changed[0]).toBe('focal_number $68k -> 12%');
  });

  it('prefers a percent or currency figure over a plain count', () => {
    const r = alignVisualToDraft(base, 'Out of 4,200 wallets, 31% sold.', opts);
    expect(r.ok && r.schema.focal_number).toBe('31%');
  });

  it('drops a cited tile the draft does not state, and keeps the trend tiles', () => {
    const r = alignVisualToDraft(base, 'Price sits near $68k.', opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema.stat_tiles?.map((t) => t.label)).toEqual(['views', 'posts']);
    expect(r.changed).toEqual(['dropped cited tile 2.5%: not stated in the draft']);
  });

  it('refuses when the draft has no figure at all', () => {
    expect(alignVisualToDraft(base, 'Nobody knows where this goes.', opts).ok).toBe(false);
  });

  it('refuses when the only figure in the draft is too long for the panel', () => {
    // 13 characters, over the 12-character focal cap.
    expect(alignVisualToDraft(base, 'Supply hit 1,234,567,890.', opts).ok).toBe(false);
  });

  it('does not take the current year as the focal number', () => {
    expect(alignVisualToDraft(base, 'The 2026 outlook is unclear.', opts).ok).toBe(false);
  });

  describe('the line under the focal number', () => {
    // 2026-11-16: "283,050" sat alone in the panel, the first thing a reader
    // sees and the one thing on the card that did not say what it was.
    const fig = (body: string, raw: string) => {
      const f = extractFigures(body, opts).find((x) => x.raw === raw);
      if (!f) throw new Error(`no figure ${raw}`);
      return f;
    };

    it('quotes the words after a count that name it', () => {
      const body = '#T\n\nThere are 283,050 views across 2,344 posts. Nobody asked why.';
      expect(focalCaption(body, fig(body, '283,050'))).toBe('views across 2,344 posts');
    });

    it('quotes the words before a figure when the words after do not name it', () => {
      const body = 'Volume rose 12% while price went nowhere.';
      expect(focalCaption(body, fig(body, '12%'))).toBe('Volume rose');
      const ppi = 'Here is the print: annual came in at 6.5%, and nobody moved.';
      expect(focalCaption(ppi, fig(ppi, '6.5%'))).toBe('annual came in');
      const btc = 'It landed after $BTC had already slid below $70,000, its lowest since August.';
      // "below" led into the figure and goes; "It" with nothing before it goes too.
      expect(focalCaption(btc, fig(btc, '$70,000'))).toBe('landed after $BTC had already slid');
    });

    it('takes a comparison after the figure, which reads whole under the number', () => {
      // "6.5% / ANNUAL CAME IN" said less than "6.5% / AGAINST THE EXPECTED 6.6%".
      const ppi = 'Here is the print: annual came in at 6.5% against the expected 6.6%.';
      expect(focalCaption(ppi, fig(ppi, '6.5%'))).toBe('against the expected 6.6%');
      const fell = 'Open interest is 4.2B down from 5.1B a week ago.';
      const f = extractFigures(fell, opts)[0]!;
      expect(focalCaption(fell, f)).not.toMatch(/^Open interest/);
    });

    it('takes "in <what>" after an amount, which names it', () => {
      // 2026-11-17: "$1.065B / TAG SAYS SPOT BITCOIN ETFS POSTED".
      const etf = 'The tag says spot Bitcoin ETFs posted $1.065B in outflows for a third straight week.';
      expect(focalCaption(etf, fig(etf, '$1.065B'))).toBe('in outflows for a third straight week');
      // A percent "in" a period is not what the figure is.
      const pct = 'Volume rose 12% in a week.';
      expect(focalCaption(pct, fig(pct, '12%'))).toBe('Volume rose');
    });

    it('never ends the words before a figure on the word that led into it, nor starts on a bare pronoun', () => {
      // 2026-11-17, card v2: "$68K / IT TRADING BELOW THE WEEKLY 200 MA NEAR".
      const ma = 'Another has it trading below the Weekly 200 MA near $68K.';
      expect(focalCaption(ma, fig(ma, '$68K'))).toBe('trading below the Weekly 200 MA');
      const close = 'One top post puts the latest weekly close at $65,351, under the 200-week average.';
      expect(focalCaption(close, fig(close, '$65,351'))).toBe('top post puts the latest weekly close');
      const around = 'Price is hovering around $64,000 again.';
      expect(focalCaption(around, fig(around, '$64,000'))).toBe('Price is hovering');
      const on = 'One top post pins a single day on $1.31B of longs.';
      expect(focalCaption(on, fig(on, '$1.31B'))).toBe('One top post pins a single day');
      const then = 'BTC dropped to $62,100, then recovered toward $64,000.';
      expect(focalCaption(then, fig(then, '$64,000'))).toBe('recovered');
      const quote = 'Another just states BTC is "heading to $180,000".';
      expect(focalCaption(quote, fig(quote, '$180,000'))).toBe('Another just states BTC is heading');
    });

    it('drops a cited tile that is a span of time, not a quantity', () => {
      // 2026-11-17: "CITED 200-WEEK" on the card.
      const body = 'One top post puts the close at $65,351, under the 200-week average, near $68K.';
      const r = alignVisualToDraft(
        {
          ...base,
          focal_number: '$65,351',
          stat_tiles: [
            { label: 'views', value: '96.3K' },
            { label: 'cited', value: '200-week' },
            { label: 'cited', value: '$68K' },
          ],
        },
        body,
        opts,
      );
      expect(r.ok && r.schema.stat_tiles).toEqual([
        { label: 'views', value: '96.3K' },
        { label: 'cited', value: '$68K' },
      ]);
    });

    it('drops a cited tile whose figure the caption already gives', () => {
      const body = 'There are 283,050 views across 2,344 posts.';
      const r = alignVisualToDraft(
        { ...base, focal_number: '283,050', stat_tiles: [{ label: 'views', value: '283.1K' }, { label: 'cited', value: '2,344' }] },
        body,
        opts,
      );
      expect(r.ok && r.schema.stat_tiles).toEqual([{ label: 'views', value: '283.1K' }]);
    });

    it('stops at the cap on a whole word, never on a dangling one', () => {
      const body = 'Out of 4,200 wallets holding through the drawdown and the funding flip, 31% sold.';
      const caption = focalCaption(body, fig(body, '4,200'))!;
      expect(caption.length).toBeLessThanOrEqual(40);
      expect(caption).toBe('wallets holding through the drawdown');
    });

    it('says nothing rather than quote the hashtag line', () => {
      const body = '#BitcoinActiveSupplyInProfitDropsBelow45%\n\nBody.';
      const f = extractFigures(body, opts)[0];
      if (f) expect(focalCaption(body, f)).toBeUndefined();
    });

    it('is set by the alignment and follows the focal number when it changes', () => {
      const body = 'There are 283,050 views across 2,344 posts. Volume rose 12% while price went nowhere.';
      const first = alignVisualToDraft({ ...base, focal_number: '283,050', focal_subline: 'stale' }, body, opts);
      expect(first.ok && first.schema.focal_subline).toBe('views across 2,344 posts');

      const next = alignVisualToDraft(first.ok ? first.schema : base, body, { ...opts, excludeFocal: ['283,050'] });
      expect(next.ok && next.schema.focal_number).toBe('12%');
      expect(next.ok && next.schema.focal_subline).toBe('Volume rose');
    });

    it('keeps the lens icon through the alignment', () => {
      const r = alignVisualToDraft({ ...base, icon: '/v/lenses/icons/calendar.png' }, 'Up 2.5% on the month.', opts);
      expect(r.ok && r.schema.icon).toBe('/v/lenses/icons/calendar.png');
    });
  });

  describe('a new visual for the same draft', () => {
    const body = 'Volume rose 12% while price held $68k. Out of 4,200 wallets, 31% sold.';

    it('puts a different figure on the panel than the ones already shown', () => {
      const r = alignVisualToDraft({ ...base, focal_number: '12%' }, body, { ...opts, excludeFocal: ['12%'] });
      expect(r.ok && r.schema.focal_number).toBe('31%');
    });

    it('walks down the preference list as figures are used up', () => {
      const r = alignVisualToDraft({ ...base, focal_number: '31%' }, body, {
        ...opts,
        excludeFocal: ['12%', '31%'],
      });
      expect(r.ok && r.schema.focal_number).toBe('$68k');
    });

    it('drops a cited tile that now repeats the focal number', () => {
      // The data gate put $68k on a tile; once it becomes the focal number,
      // the card would show it twice.
      const r = alignVisualToDraft(
        { ...base, focal_number: '31%', stat_tiles: [{ label: 'views', value: '137K' }, { label: 'cited', value: '$68k' }] },
        body,
        { ...opts, excludeFocal: ['12%', '31%'] },
      );
      expect(r.ok && r.schema.focal_number).toBe('$68k');
      expect(r.ok && r.schema.stat_tiles).toEqual([{ label: 'views', value: '137K' }]);
    });

    it('refuses once every figure that fits has been shown, naming them', () => {
      const r = alignVisualToDraft(base, body, { ...opts, excludeFocal: ['12%', '31%', '$68k', '4,200'] });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/no other figure.*12%, 31%, \$68k, 4,200/);
    });
  });
});
