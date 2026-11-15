import { describe, expect, it } from 'vitest';
import { alignVisualToDraft } from '../src/compose/visual-alignment.js';
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
    expect(r).toEqual({ ok: true, schema: base, changed: [] });
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
