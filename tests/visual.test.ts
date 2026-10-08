import { describe, expect, it } from 'vitest';
import { LayoutError, VISUAL_TYPES, assertCaps, buildCard } from '../src/visual/layout.js';
import { MAX_BYTES, renderVisual } from '../src/visual/render.js';
import { CANVAS, MOOD_STYLES, PALETTE } from '../src/visual/palette.js';
import { loadFonts } from '../src/visual/fonts.js';
import { CAPS, type VisualSchema } from '../src/compose/data-gate.js';

function schema(over: Partial<VisualSchema> = {}): VisualSchema {
  return {
    visual_type: 'macro_card',
    mood_variant: 'neutral',
    top_label: 'MACRO CARD',
    headline_1: 'US JOBLESS CLAIMS',
    headline_2: 'FALL TO 206,000',
    focal_number: '206,000',
    focal_subline: 'LOWEST SINCE MARCH',
    stat_tiles: [
      { label: 'views', value: '137.3K' },
      { label: 'posts', value: '1.9K' },
    ],
    risk_bar: 'THE DATE IS FIXED.',
    footer_source: 'DATA: Binance Square · 2026-09-30',
    brand_mark: '@lavopavden · exploits / tokenomics',
    ...over,
  };
}

describe('fonts', () => {
  it('loads a serif and a mono that satori can actually parse', () => {
    // Measured 2026-09-30: every font in /System/Library/Fonts proper throws
    // during parsing, including the SFNSMono the notes recommend for PIL.
    const fonts = loadFonts();
    expect(fonts.map((f) => f.name)).toContain('Display');
    expect(fonts.map((f) => f.name)).toContain('Label');
    for (const f of fonts) expect(f.data.byteLength).toBeGreaterThan(10_000);
  });
});

describe('assertCaps', () => {
  it('accepts content within the §5 caps', () => {
    expect(() => assertCaps(schema())).not.toThrow();
  });

  it('refuses an over-long headline instead of shrinking the type', () => {
    const long = 'A'.repeat(CAPS.headline_line + 1);
    expect(() => assertCaps(schema({ headline_1: long }))).toThrow(LayoutError);
    expect(() => assertCaps(schema({ headline_1: long }))).toThrow(/do not shrink the type/i);
  });

  it('refuses an over-long focal number', () => {
    expect(() => assertCaps(schema({ focal_number: '1'.repeat(CAPS.focal_number + 1) }))).toThrow(
      /focal_number/,
    );
  });

  it('refuses an over-long subline', () => {
    expect(() => assertCaps(schema({ focal_subline: 'X'.repeat(CAPS.focal_subline + 1) }))).toThrow(
      /focal_subline/,
    );
  });

  it('refuses a stat value that will not fit its tile', () => {
    expect(() =>
      assertCaps(schema({ stat_tiles: [{ label: 'views', value: '9'.repeat(CAPS.stat_value + 1) }] })),
    ).toThrow(/stat_tiles\[0\]/);
  });

  it('refuses more tiles than the row holds', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `l${i}`, value: '1' }));
    expect(() => assertCaps(schema({ stat_tiles: five }))).toThrow(/layout holds 4/);
  });

  it('reports every violation at once, not just the first', () => {
    try {
      assertCaps(
        schema({
          headline_1: 'A'.repeat(40),
          focal_number: '1'.repeat(20),
        }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('headline_1');
      expect(msg).toContain('focal_number');
    }
  });
});

describe('buildCard', () => {
  it('uses the palette from the guidelines, not invented colours', () => {
    const json = JSON.stringify(buildCard(schema()));
    expect(json).toContain(PALETTE.paper);
    expect(json).toContain(PALETTE.ink);
  });

  it('stamps a warning in risk mode and not in neutral', () => {
    expect(JSON.stringify(buildCard(schema({ mood_variant: 'risk' })))).toContain('WARNING');
    expect(JSON.stringify(buildCard(schema({ mood_variant: 'neutral' })))).not.toContain('WARNING');
  });

  it('colours the focal number by mood', () => {
    expect(JSON.stringify(buildCard(schema({ mood_variant: 'risk' })))).toContain(MOOD_STYLES.risk.focal);
    expect(JSON.stringify(buildCard(schema({ mood_variant: 'neutral' })))).toContain(
      MOOD_STYLES.neutral.focal,
    );
  });

  it('keeps the two moods otherwise identical, so they read as one style', () => {
    // §6.5: only the label wording, the stamp and the bar mood may differ.
    const risk = JSON.stringify(buildCard(schema({ mood_variant: 'risk' })));
    const neutral = JSON.stringify(buildCard(schema({ mood_variant: 'neutral' })));
    expect(risk).toContain(PALETTE.paper);
    expect(neutral).toContain(PALETTE.paper);
    expect(Math.abs(risk.length - neutral.length)).toBeLessThan(900);
  });

  it('puts the source left and the brand right in the footer', () => {
    const json = JSON.stringify(buildCard(schema()));
    expect(json.indexOf('DATA: Binance Square')).toBeLessThan(json.indexOf('@lavopavden'));
  });

  it('omits the bottom bar when there is no line for it', () => {
    expect(JSON.stringify(buildCard(schema({ risk_bar: undefined })))).not.toContain('THE DATE IS FIXED');
  });
});

describe('renderVisual', () => {
  it('renders at exactly 1080x1350', async () => {
    const r = await renderVisual(schema());
    expect(r.width).toBe(CANVAS.width);
    expect(r.height).toBe(CANVAS.height);
  }, 30_000);

  it('stays under the 1MB upload limit', async () => {
    const r = await renderVisual(schema());
    expect(r.bytes).toBeLessThan(MAX_BYTES);
  }, 30_000);

  it('produces a real PNG', async () => {
    const { png } = await renderVisual(schema());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 30_000);

  it('renders every visual type without throwing', async () => {
    for (const type of VISUAL_TYPES) {
      const r = await renderVisual(schema({ visual_type: type }));
      expect(r.bytes).toBeGreaterThan(1000);
    }
  }, 120_000);

  it('renders Vietnamese diacritics, since the same renderer serves the VN pipeline', async () => {
    const r = await renderVisual(
      schema({
        headline_1: 'LỆNH MUA USDT',
        headline_2: 'HAI MỨC GIÁ',
        focal_subline: 'CHÊNH VÀI DÒNG',
        risk_bar: 'SO GIÁ TRƯỚC KHI BẤM.',
      }),
    );
    expect(r.bytes).toBeGreaterThan(1000);
  }, 30_000);
});
