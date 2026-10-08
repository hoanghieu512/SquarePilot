import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';

export interface StatTile {
  label: string;
  value: string;
}

/** Mirrors §7 of visual-guidelines-retro-vintage.md. Field names match the file. */
export interface VisualSchema {
  visual_type: string;
  mood_variant: 'risk' | 'neutral';
  top_label: string;
  headline_1: string;
  headline_2?: string;
  focal_number: string;
  focal_subline?: string;
  stat_tiles: StatTile[];
  risk_bar?: string;
  footer_source: string;
  brand_mark: string;
}

/** §7: missing two or more of these means stop, do not invent numbers. */
export const CORE_FIELDS = ['focal_number', 'headline_1', 'stat_tiles'] as const;

export const BRAND_MARK = '@lavopavden · exploits / tokenomics';

export type DataGateResult =
  | { ok: true; available: Partial<VisualSchema>; found: string[] }
  | { ok: false; missing: string[]; reason: string; found: string[] };

/** §5 caps. Enforced here so the drafter never proposes text that cannot render. */
export const CAPS = {
  headline_line: 28,
  focal_number: 12,
  focal_subline: 20,
  stat_value: 8,
  bar: 45,
} as const;

const NUMBER_RE = /(?<![\w.])(\$?\d[\d,.]*\s?(?:%|[KMBT]\b|billion|million|trillion)?)/gi;

/**
 * A bare four-digit year is not a statistic.
 *
 * Seen on the first rendered card: "FY2026 Q4" put **2026** on the panel as the
 * headline figure. It is the most eye-catching thing on the image and it means
 * nothing.
 */
const YEAR_RE = /^(19|20)\d{2}$/;

/**
 * Pull candidate figures out of the posts already written under a hashtag.
 *
 * Trend metadata alone cannot fill a visual: measured 2026-08-21, `viewCount`
 * and `contentCount` are always present but `priceChange` is almost always
 * null, so the headline figure has to come from what people are writing.
 */
export function extractNumbers(posts: HashtagPost[], limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const post of posts) {
    for (const match of post.text.matchAll(NUMBER_RE)) {
      // The pattern is greedy over [\d,.], so a sentence-ending period joins the
      // number: "GPT-7. The" yielded "7." and put it on the card as the headline
      // figure. Strip trailing punctuation before judging the value.
      const value = match[1]!.trim().replace(/[.,]+$/, '');
      // Bare small integers are counts of nothing in particular.
      if (/^\$?\d{1,2}$/.test(value)) continue;
      if (YEAR_RE.test(value)) continue;
      // A figure has to carry a unit, a separator or real magnitude to be worth
      // the panel. "4" and "7" are not statistics.
      if (!/[%$KMBT,]/.test(value) && value.replace(/\D/g, '').length < 3) continue;
      if (value.length > CAPS.focal_number) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export interface GateInput {
  trend: Trend;
  topPosts: HashtagPost[];
  /** Headline supplied by the caller; otherwise derived from the hashtag. */
  headline?: string;
  mood?: 'risk' | 'neutral';
  visualType?: string;
}

/** `#USJoblessClaimsFallTo206000` → `US JOBLESS CLAIMS FALL TO 206000`. */
export function hashtagToHeadline(hashtag: string): string {
  return hashtag
    .replace(/^#/, '')
    // Split an acronym from the word that follows it: USJobless -> US Jobless.
    // Without this the leading initials glue onto the first word.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    // Currency marks and the digits after them run into the previous word:
    // Above$3.4Highest -> ABOVE $3.4 HIGHEST.
    .replace(/([A-Za-z])(\$)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    // A percent sign ends a figure; the next word must not stick to it.
    .replace(/(%)([A-Za-z])/g, '$1 $2')
    .toUpperCase()
    .trim();
}

function splitHeadline(text: string): { headline_1: string; headline_2?: string } {
  if (text.length <= CAPS.headline_line) return { headline_1: text };

  const words = text.split(' ');
  let first = '';
  let i = 0;
  while (i < words.length && (first + ' ' + words[i]!).trim().length <= CAPS.headline_line) {
    first = (first + ' ' + words[i]!).trim();
    i++;
  }
  const second = words.slice(i).join(' ').slice(0, CAPS.headline_line);
  return second ? { headline_1: first, headline_2: second } : { headline_1: first };
}

/**
 * Decide whether a visual can be built before a single word is drafted.
 *
 * "No image, no post" is a hard rule, so this runs early: discovering the gap
 * after drafting would waste a draft, two gate passes, and the trend itself.
 */
export function runDataGate(input: GateInput): DataGateResult {
  const { trend, topPosts } = input;
  const found: string[] = [];
  const missing: string[] = [];

  const headlineText = input.headline ?? hashtagToHeadline(trend.hashtag);
  const headline = splitHeadline(headlineText);
  if (headline.headline_1.length > 0) found.push('headline_1');
  else missing.push('headline_1');

  const numbers = extractNumbers(topPosts);
  const focal = numbers[0];
  if (focal) found.push('focal_number');
  else missing.push('focal_number');

  const tiles: StatTile[] = [
    { label: 'views', value: compact(trend.viewCount) },
    { label: 'posts', value: compact(trend.contentCount) },
  ];
  // Truncating a figure invents a different one: slicing "29,000" to the tile
  // cap produced "29," on the first rendered card. Drop what will not fit.
  for (const n of numbers.slice(1, 3)) {
    if (n.length <= CAPS.stat_value) tiles.push({ label: 'cited', value: n });
  }
  if (tiles.length >= 2) found.push('stat_tiles');
  else missing.push('stat_tiles');

  if (missing.length >= 2) {
    return {
      ok: false,
      missing,
      found,
      reason: `missing ${missing.join(' and ')} — cannot build a visual, so this trend is skipped rather than posted bare`,
    };
  }

  if (missing.includes('focal_number')) {
    return {
      ok: false,
      missing,
      found,
      reason: 'no headline figure in the top posts — a stat card with no number is not a visual',
    };
  }

  const mood = input.mood ?? 'neutral';
  return {
    ok: true,
    found,
    available: {
      visual_type: input.visualType ?? 'macro_card',
      mood_variant: mood,
      top_label: mood === 'risk' ? 'RISK CARD' : 'MACRO CARD',
      ...headline,
      focal_number: focal!.slice(0, CAPS.focal_number),
      stat_tiles: tiles.slice(0, 4),
      footer_source: `DATA: Binance Square · ${new Date().toISOString().slice(0, 10)}`,
      brand_mark: BRAND_MARK,
    },
  };
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
