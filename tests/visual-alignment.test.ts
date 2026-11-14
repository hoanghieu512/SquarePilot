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
  it('keeps a focal number the draft states', () => {
    const r = alignVisualToDraft(base, 'Price sits near $68,000 and 2.5% up on the month.', opts);
    expect(r).toEqual({ ok: true, schema: base, changed: [] });
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
    expect(r.changed).toEqual(['dropped 1 cited tile(s) not stated in the draft']);
  });

  it('refuses when the draft has no figure that fits the panel', () => {
    const r = alignVisualToDraft(base, 'Nobody knows where this goes.', opts);
    expect(r.ok).toBe(false);
  });

  it('does not take the current year as the focal number', () => {
    const r = alignVisualToDraft(base, 'The 2026 outlook is unclear.', opts);
    expect(r.ok).toBe(false);
  });
});
