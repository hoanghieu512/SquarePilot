import { CANVAS, FOOTER_PADDING, MOOD_STYLES, PADDING, PALETTE, type Mood } from './palette.js';
import { CAPS, type StatTile, type VisualSchema } from '../compose/data-gate.js';

/** The eight types defined in §8 of the visual guidelines. */
export const VISUAL_TYPES = [
  'warning_card',
  'risk_stack',
  'timeline',
  'tokenomics_card',
  'airdrop_card',
  'exploit_card',
  'comparison_table',
  'macro_card',
] as const;

export type VisualType = (typeof VISUAL_TYPES)[number];

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

/**
 * §5 caps are hard rules: over the limit, the renderer refuses.
 *
 * The guidelines say it directly - when a field exceeds its cap, shorten it,
 * never shrink the font to fit. Auto-shrinking is how a card ends up with a
 * headline nobody can read on a phone, which is the only place it gets read.
 */
export function assertCaps(schema: VisualSchema): void {
  const problems: string[] = [];

  for (const [field, value, cap] of [
    ['headline_1', schema.headline_1, CAPS.headline_line],
    ['headline_2', schema.headline_2 ?? '', CAPS.headline_line],
    ['focal_number', schema.focal_number, CAPS.focal_number],
    ['focal_subline', schema.focal_subline ?? '', CAPS.focal_subline],
    ['risk_bar', schema.risk_bar ?? '', CAPS.bar],
  ] as const) {
    if (value.length > cap) {
      problems.push(`${field} is ${value.length} chars, cap is ${cap}: "${value}"`);
    }
  }

  schema.stat_tiles.forEach((tile, i) => {
    if (tile.value.length > CAPS.stat_value) {
      problems.push(`stat_tiles[${i}].value is ${tile.value.length} chars, cap is ${CAPS.stat_value}`);
    }
  });

  if (schema.stat_tiles.length > 4) {
    problems.push(`${schema.stat_tiles.length} stat tiles, layout holds 4`);
  }

  if (problems.length > 0) {
    throw new LayoutError(
      `Content exceeds the caps in §5. Shorten the text; do not shrink the type.\n- ${problems.join('\n- ')}`,
    );
  }
}

type Node = { type: string; props: Record<string, unknown> };

const el = (type: string, props: Record<string, unknown>): Node => ({ type, props });

function statTile(tile: StatTile, mood: Mood): Node {
  return el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      padding: '18px 20px',
      backgroundColor: PALETTE.paperShadow,
      border: `3px solid ${PALETTE.ink}`,
      gap: 6,
    },
    children: [
      el('div', {
        style: {
          fontFamily: 'Label',
          fontSize: 20,
          fontWeight: 700,
          color: PALETTE.grayBrown,
          textTransform: 'uppercase',
          letterSpacing: 1,
        },
        children: tile.label,
      }),
      el('div', {
        style: {
          fontFamily: 'Display',
          fontSize: 44,
          fontWeight: 900,
          color: mood === 'risk' ? PALETTE.ink : PALETTE.ink,
        },
        children: tile.value,
      }),
    ],
  });
}

/**
 * Build the card described by §6.
 *
 * One layout, not eight. The visual types differ in what they put in each slot
 * and which mood they default to, not in where the slots sit - that sameness is
 * what makes a run of posts read as one account.
 *
 * The children are grouped in two, with a single `space-between` gap. Spreading
 * four blocks across the height instead left a canyon of empty paper between
 * each one, which is not how the hand-made cards in `outputs/visuals/square`
 * are built - those are dense.
 */
export function buildCard(schema: VisualSchema): Node {
  assertCaps(schema);
  const mood = MOOD_STYLES[schema.mood_variant as Mood] ?? MOOD_STYLES.neutral;

  const headlines = [schema.headline_1, schema.headline_2].filter(
    (h): h is string => typeof h === 'string' && h.length > 0,
  );

  const capsule = el('div', {
    style: {
      display: 'flex',
      alignSelf: 'flex-start',
      padding: '10px 24px',
      backgroundColor: PALETTE.ink,
      color: PALETTE.paper,
      fontFamily: 'Label',
      fontSize: 22,
      fontWeight: 700,
      letterSpacing: 3,
      textTransform: 'uppercase',
    },
    children: schema.top_label,
  });

  const headline = el('div', {
    style: { display: 'flex', flexDirection: 'column' },
    children: headlines.map((line) =>
      el('div', {
        style: {
          fontFamily: 'Display',
          fontSize: 76,
          fontWeight: 900,
          color: PALETTE.ink,
          lineHeight: 1.05,
          textTransform: 'uppercase',
        },
        children: line,
      }),
    ),
  });

  const stamp = el('div', {
    style: {
      display: 'flex',
      alignSelf: 'flex-start',
      padding: '6px 18px',
      border: `4px solid ${PALETTE.risk}`,
      color: PALETTE.risk,
      fontFamily: 'Label',
      fontSize: 24,
      fontWeight: 700,
      letterSpacing: 2,
      transform: 'rotate(-4deg)',
    },
    children: 'WARNING',
  });

  const focal = el('div', {
    style: {
      fontFamily: 'Display',
      fontSize: 140,
      fontWeight: 900,
      color: mood.focal,
      lineHeight: 1.05,
    },
    children: schema.focal_number,
  });

  const subline = el('div', {
    style: {
      fontFamily: 'Label',
      fontSize: 26,
      fontWeight: 700,
      color: PALETTE.grayBrown,
      letterSpacing: 2,
      textTransform: 'uppercase',
    },
    children: schema.focal_subline ?? '',
  });

  const panel = el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      justifyContent: 'center',
      flexGrow: 1,
      padding: '52px 56px',
      border: `5px solid ${PALETTE.ink}`,
      backgroundColor: PALETTE.paperShadow,
      gap: 12,
    },
    children: [...(mood.stamp ? [stamp] : []), focal, ...(schema.focal_subline ? [subline] : [])],
  });

  const tiles = el('div', {
    style: { display: 'flex', flexDirection: 'row', gap: 16 },
    children: schema.stat_tiles.map((t) => statTile(t, schema.mood_variant as Mood)),
  });

  const bar = el('div', {
    style: {
      display: 'flex',
      padding: '20px 24px',
      backgroundColor: mood.barBg,
      color: mood.barText,
      fontFamily: 'Label',
      fontSize: 26,
      fontWeight: 700,
      letterSpacing: 1,
    },
    children: schema.risk_bar ?? '',
  });

  // §6: DATA left, brand right, and the two must never overlap.
  const footer = el('div', {
    style: {
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      paddingLeft: FOOTER_PADDING - PADDING,
      paddingRight: FOOTER_PADDING - PADDING,
    },
    children: [
      el('div', {
        style: { fontFamily: 'Label', fontSize: 20, fontWeight: 400, color: PALETTE.grayBrown },
        children: schema.footer_source,
      }),
      el('div', {
        style: { fontFamily: 'Label', fontSize: 20, fontWeight: 700, color: PALETTE.brandPurple },
        children: schema.brand_mark,
      }),
    ],
  });

  return el('div', {
    style: {
      width: CANVAS.width,
      height: CANVAS.height,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: PALETTE.paper,
      padding: PADDING,
      gap: 32,
    },
    children: [
      capsule,
      headline,
      // The panel absorbs whatever height is left. A fixed-height panel left a
      // band of bare paper in the middle of the card; letting the framed block
      // grow reads as deliberate space rather than as a gap.
      panel,
      tiles,
      ...(schema.risk_bar ? [bar] : []),
      footer,
    ],
  });
}
