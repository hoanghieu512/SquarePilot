/**
 * Palette from §3 of visual-guidelines-retro-vintage.md, verbatim.
 *
 * Not re-picked, not "improved". The hand-written pipeline has been shipping
 * these exact values since May, so a post rendered here has to sit beside one
 * rendered there without looking like a different account.
 */
export const PALETTE = {
  paper: '#efe0b3',
  paperShadow: '#d6bd82',
  ink: '#2b2118',
  risk: '#a33a2e',
  burntOrange: '#c76b2a',
  brandPurple: '#6b3fa0',
  green: '#4f7c57',
  grayBrown: '#6f6254',
} as const;

export type Mood = 'risk' | 'neutral';

/**
 * §6.5: the two moods differ in exactly three things. Everything else - palette,
 * typography, layout - stays identical, which is what keeps the two variants
 * recognisably one style rather than two.
 */
export interface MoodStyle {
  /** Colour of the focal number. */
  focal: string;
  /** Background of the bottom bar. */
  barBg: string;
  /** Text colour inside the bottom bar. */
  barText: string;
  /** Risk mode stamps a tilted warning; neutral does not. */
  stamp: boolean;
}

export const MOOD_STYLES: Record<Mood, MoodStyle> = {
  risk: {
    focal: PALETTE.risk,
    barBg: PALETTE.ink,
    barText: PALETTE.paper,
    stamp: true,
  },
  neutral: {
    focal: PALETTE.burntOrange,
    barBg: PALETTE.paperShadow,
    barText: PALETTE.ink,
    stamp: false,
  },
};

export const CANVAS = { width: 1080, height: 1350 } as const;

/** §6: minimum 40px each side, and the two footer lines must not overlap. */
export const PADDING = 64;
export const FOOTER_PADDING = 48;
