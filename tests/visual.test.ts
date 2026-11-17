import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayoutError, VISUAL_TYPES, assertCaps, buildCard } from '../src/visual/layout.js';
import { MAX_BYTES, loadIcon, renderVisual } from '../src/visual/render.js';
import { CANVAS, MOOD_STYLES, PALETTE } from '../src/visual/palette.js';
import { fontDir, loadFonts } from '../src/visual/fonts.js';
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

  it('falls back to the system faces when a named set is not downloaded', () => {
    // The Fontshare files live outside the repository (their licence forbids
    // redistribution), so a machine without them must still draw a card.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-fonts-'));
    const fallback = loadFonts({ set: 'zodiak-azeret', dir: empty });
    const system = loadFonts({ set: 'system' });
    expect(fallback.map((f) => f.data.byteLength)).toEqual(system.map((f) => f.data.byteLength));
  });

  it('loads a downloaded set with the system faces behind it for missing glyphs', () => {
    // Stand-in files under the set's paths; the real ones may not be copied
    // anywhere public, so no test depends on them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-fonts-'));
    const georgia = '/System/Library/Fonts/Supplemental/Georgia.ttf';
    if (!fs.existsSync(georgia)) return;
    for (const rel of [
      'zodiak/Zodiak_Complete/Fonts/OTF/Zodiak-Black.otf',
      'zodiak/Zodiak_Complete/Fonts/OTF/Zodiak-Bold.otf',
      'azeret-mono/AzeretMono_Complete/Fonts/OTF/AzeretMono-Bold.otf',
      'azeret-mono/AzeretMono_Complete/Fonts/OTF/AzeretMono-Regular.otf',
    ]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(georgia, path.join(dir, rel));
    }
    const names = loadFonts({ set: 'zodiak-azeret', dir }).map((f) => `${f.name}${f.weight}`);
    expect(names).toEqual([
      'Display900', 'Display700', 'Label700', 'Label400',
      'DisplayFallback900', 'DisplayFallback700', 'LabelFallback700', 'LabelFallback400',
    ]);
  });

  it('refuses a set name it does not know', () => {
    expect(() => loadFonts({ set: 'comic-sans' })).toThrow(/Unknown font set "comic-sans"/);
  });

  it('reads the set and folder from the environment', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-fonts-'));
    expect(fontDir({ SQUAREPILOT_FONT_DIR: empty })).toBe(empty);
    expect(() => loadFonts({}, { SQUAREPILOT_FONT_SET: 'nope', SQUAREPILOT_FONT_DIR: empty })).toThrow(/Unknown font set/);
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

describe('the focal panel', () => {
  type N = { type: string; props: { children?: unknown; src?: string } };
  function nodes(root: unknown): N[] {
    const out: N[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const node = n as N;
      out.push(node);
      walk(node.props?.children);
    };
    walk(root);
    return out;
  }
  const ICON = 'data:image/png;base64,AAAA';

  it('draws the lens icon beside a short number', () => {
    const imgs = nodes(buildCard(schema(), { icon: ICON })).filter((n) => n.type === 'img');
    expect(imgs.map((n) => n.props.src)).toEqual([ICON]);
  });

  it('leaves the icon out when the number needs the whole row, or when there is none', () => {
    expect(nodes(buildCard(schema({ focal_number: '1,234,567' }), { icon: ICON })).some((n) => n.type === 'img')).toBe(false);
    expect(nodes(buildCard(schema())).some((n) => n.type === 'img')).toBe(false);
  });

  it('lays the paper texture under everything, out of the flow, only when there is one', () => {
    const TEX = 'data:image/jpeg;base64,BBBB';
    const card = buildCard(schema(), { texture: TEX }) as unknown as { props: { children: N[] } };
    const first = card.props.children[0] as unknown as { type: string; props: { src: string; style: Record<string, unknown> } };
    expect(first.type).toBe('img');
    expect(first.props.src).toBe(TEX);
    expect(first.props.style.position).toBe('absolute');
    expect(nodes(buildCard(schema())).some((n) => n.type === 'img')).toBe(false);
  });

  it('puts the line that says what the number is under it', () => {
    const texts = nodes(buildCard(schema({ focal_subline: 'views across 2,344 posts' }))).map((n) => n.props.children);
    expect(texts).toContain('views across 2,344 posts');
  });

  it('accepts a 40-character line and refuses a longer one', () => {
    expect(() => buildCard(schema({ focal_subline: 'x'.repeat(40) }))).not.toThrow();
    expect(() => buildCard(schema({ focal_subline: 'x'.repeat(41) }))).toThrow(/focal_subline is 41 chars, cap is 40/);
  });

  it('renders a card with an icon and a two-line caption within the upload limit', async () => {
    // A real 1x1 PNG, so satori decodes an actual image.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const out = await renderVisual(
      schema({ focal_subline: 'wallets holding through the drawdown', icon: undefined }),
    );
    expect(out.bytes).toBeLessThan(MAX_BYTES);
    expect(loadIcon(undefined)).toBeUndefined();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-icon-')), 'icon.png');
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    expect(loadIcon(file)).toBe(`data:image/png;base64,${png}`);
    expect(loadIcon('/nope/missing.png')).toBeUndefined();
    const jpg = file.replace(/\.png$/, '.jpg');
    fs.copyFileSync(file, jpg);
    expect(loadIcon(jpg)!.startsWith('data:image/jpeg;base64,')).toBe(true);
    const withIcon = await renderVisual(schema({ focal_subline: 'views across 2,344 posts', icon: file }));
    expect(withIcon.bytes).toBeLessThan(MAX_BYTES);
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
