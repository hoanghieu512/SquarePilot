import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';
import { groupLongNumbers } from './post-format.js';

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
  /** What the focal number is, in the post's own words (see `alignVisualToDraft`). */
  focal_subline?: string;
  stat_tiles: StatTile[];
  risk_bar?: string;
  footer_source: string;
  brand_mark: string;
  /**
   * Absolute path of the lens icon drawn beside the focal number, when the
   * post comes from a lens that declares one. Not part of §7: the guidelines
   * describe text fields only.
   */
  icon?: string;
  /** Absolute path of the paper texture drawn under the card, when the vault has one. */
  texture?: string;
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
  // Raised from 20 on 2026-11-16: the line now says what the focal number
  // is, quoted from the post ("views across 2,344 posts"), and a bare number
  // with no such line read as stranded. It wraps to two lines on the card.
  focal_subline: 40,
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
  const raw = hashtag
    .replace(/^#/, '')
    // A glued lower-case function word: Cryptoand|Stocks -> Crypto and Stocks.
    // Only split after a, i, o, u, n or g (Crypto|and, Bitcoin|and, Huang|at, Solana|at).
    // English words ending in -and or -at (Holland, Threat, Democrat, Habitat, Wombat)
    // have a consonant or e before the function word, so they are left whole.
    .replace(/([A-Z][a-z]{2,}?[aiougn])(and|at)(?=[A-Z])/g, '$1 $2 ')
    // "as" only after an n (Return|as, Explain|as): after other letters it ends
    // too many words (Vegas, Atlas, Kansas).
    .replace(/([A-Z][a-z]{2,}?n)(as)(?=[A-Z])/g, '$1 $2 ')
    // An amount glued to a ticker: 2.09M|MSTR. A capital after K, M, B or T
    // that starts another run of capitals is a new word, not more units.
    .replace(/(\d[KMBT])(?=[A-Z]{2})/g, '$1 ')
    // A curly or straight apostrophe followed by a capital: Stocks’Next.
    .replace(/(['’])(?=[A-Z])/g, '$1 ');

  // Brands keep their own letters, so only the text between them is split.
  const parts = raw.split(BRAND_RE).map((part, i) => (i % 2 === 1 ? part : splitWords(part)));
  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .trim();
}

/** Mixed-case or lower-case brands and plurals that no case rule can split correctly. Sorted. */
export const KNOWN_BRANDS = ['BlackRock', 'DeFi', 'ETFs', 'OpenAI', 'TradFi', 'dYdX'] as const;

/** Acronyms used to split glued upper-case runs such as USPPI or NEARETF. Sorted. */
export const KNOWN_ACRONYMS = [
  'AI', 'BNB', 'BTC', 'CPI', 'ETF', 'ETH', 'NEAR', 'PPI', 'SEC', 'SWIFT', 'TVL', 'US', 'USDC', 'XRP',
] as const;

const BRAND_RE = new RegExp(`(${KNOWN_BRANDS.join('|')})`);

/** Split an upper-case run into known acronyms with the fewest parts, or leave it alone. */
function splitAcronymRun(run: string): string {
  const best: (string[] | null)[] = new Array(run.length + 1).fill(null);
  best[0] = [];
  for (let end = 1; end <= run.length; end++) {
    for (const a of KNOWN_ACRONYMS) {
      const prev = end - a.length >= 0 ? best[end - a.length] : null;
      if (prev && run.slice(end - a.length, end) === a && (!best[end] || prev.length + 1 < best[end]!.length)) {
        best[end] = [...prev, a];
      }
    }
  }
  return best[run.length] ? best[run.length]!.join(' ') : run;
}

function splitWords(text: string): string {
  return text
    // Split an acronym from the word that follows it: USJobless -> US Jobless.
    // Without this the leading initials glue onto the first word.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // V9.9 and Q3 are single tokens, so V and Q stay attached to their digits.
    .replace(/([A-PR-UW-Za-z])(\d)/g, '$1 $2')
    // Currency marks and the digits after them run into the previous word:
    // Above$3.4Highest -> ABOVE $3.4 HIGHEST.
    .replace(/([A-Za-z])(\$)/g, '$1 $2')
    // A K/M/B/T unit stays on its figure unless a lower-case letter follows (8Months).
    .replace(/(\d)(?![KMBT](?![a-z]))([A-Z])/g, '$1 $2')
    // A unit can run into a quarter or version token: $23.97MQ3 -> $23.97M Q3.
    .replace(/(\d[KMBT])(?=[VQ]\d)/g, '$1 ')
    // A percent sign ends a figure; the next word must not stick to it.
    .replace(/(%)([A-Za-z])/g, '$1 $2')
    .replace(/\b[A-Z]{4,}\b/g, splitAcronymRun);
}

/** Words a cut headline should end before: each opens a phrase of its own. */
const PHRASE_OPENERS = new Set(
  'FOR IN ON AT TO OF AFTER SINCE AS WITH FROM BY AMID OVER UNDER DURING BEFORE AND OR BUT'.split(' '),
);

/** Greedy: as many whole words as fit in `cap`. */
function fitWords(words: string[], cap: number): number {
  let n = 0;
  let len = 0;
  while (n < words.length && len + (n > 0 ? 1 : 0) + words[n]!.length <= cap) {
    len += (n > 0 ? 1 : 0) + words[n]!.length;
    n++;
  }
  return n;
}

/**
 * Two lines of at most `CAPS.headline_line`, in whole words.
 *
 * A hashtag longer than both lines loses its tail, cut before the last
 * phrase that does not fit whole: "$1.065B OUTFLOWS FOR THIRD STRAIGHT WEEK"
 * becomes "$1.065B OUTFLOWS", not "$1.065B OUTFLOWS FOR THIRD S", which is
 * what slicing at the cap printed on 2026-11-17.
 */
function splitHeadline(text: string): { headline_1: string; headline_2?: string } {
  const cap = CAPS.headline_line;
  if (text.length <= cap) return { headline_1: text };

  const words = text.split(' ');
  const n1 = Math.max(1, fitWords(words, cap));
  const first = words.slice(0, n1).join(' ').slice(0, cap);
  const rest = words.slice(n1);
  if (rest.length === 0) return { headline_1: first };

  let n2 = fitWords(rest, cap);
  if (n2 === 0) return { headline_1: first, headline_2: rest[0]!.slice(0, cap) };
  if (n2 < rest.length) {
    // Words were dropped: end before the last phrase opener, if that leaves
    // at least two words, so the line stops where a phrase stops.
    const opener = rest.slice(0, n2).map((w) => PHRASE_OPENERS.has(w)).lastIndexOf(true);
    if (opener >= 2) n2 = opener;
  }
  while (n2 > 1 && PHRASE_OPENERS.has(rest[n2 - 1]!)) n2--;
  return { headline_1: first, headline_2: rest.slice(0, n2).join(' ') };
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

  // Counts grouped as in the post: "64000" reads as "64,000" on the card.
  const headlineText = groupLongNumbers(input.headline ?? hashtagToHeadline(trend.hashtag));
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
