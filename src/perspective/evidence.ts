import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';
import type { Lens } from './lens-store.js';

/**
 * Where a lens can get its evidence from.
 *
 * `data`   — derivable from the trend row and the posts under it. Automatable.
 * `docs`   — needs a real document fetched and quoted. Automatable once a URL exists.
 * `author` — needs something only the author knows: a step in their job, a
 *            thing they actually did. No amount of scraping produces this, and
 *            a model filling the gap is exactly the fabrication the bar exists
 *            to stop. These lenses stay unavailable until a person supplies it.
 */
export type EvidenceSource = 'data' | 'docs' | 'author';

export interface EvidenceContext {
  trend: Trend;
  topPosts: HashtagPost[];
  /** Documents already fetched, keyed by URL. */
  documents?: Record<string, string>;
  /** Evidence a person supplied for `author` lenses. */
  authorNotes?: Record<string, string[]>;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Confirm a quote really appears in one of its claimed sources.
 *
 * The whole point of the evidence bar is that nothing downstream has to take
 * the drafter's word for it. A quote that cannot be located is dropped, no
 * matter how plausible it reads.
 */
export function verifyQuote(quote: string, sources: string[]): boolean {
  const needle = normalise(quote);
  if (needle.length < 20) return false;
  return sources.some((s) => normalise(s).includes(needle));
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/**
 * Observations taken straight from the numbers, each one recomputable.
 *
 * Nothing here is phrased by a model: every string is assembled from values
 * that came off the wire, so "is this true?" is answered by rerunning the
 * function rather than by trusting the sentence.
 */
export function gatherDataEvidence(trend: Trend, posts: HashtagPost[]): string[] {
  const evidence: string[] = [];

  evidence.push(
    `${trend.hashtag} carries ${trend.viewCount} views across ${trend.contentCount} posts ` +
      `(${(trend.viewCount / Math.max(trend.contentCount, 1)).toFixed(1)} views per post).`,
  );

  // Sentences that carry a figure are the ones worth quoting back.
  for (const post of posts.slice(0, 10)) {
    for (const sentence of post.text.split(SENTENCE_SPLIT)) {
      const clean = sentence.replace(/\s+/g, ' ').trim();
      if (clean.length < 30 || clean.length > 220) continue;
      if (!/\d/.test(clean)) continue;
      evidence.push(`A top post states: "${clean}"`);
      break;
    }
    if (evidence.length >= 5) break;
  }

  return evidence;
}

/** Quote a fetched document, keeping only lines that can be located in it. */
export function gatherDocsEvidence(documents: Record<string, string>): string[] {
  const evidence: string[] = [];
  for (const [url, body] of Object.entries(documents)) {
    for (const sentence of body.split(SENTENCE_SPLIT)) {
      const clean = sentence.replace(/\s+/g, ' ').trim();
      if (clean.length < 40 || clean.length > 240) continue;
      if (!verifyQuote(clean, [body])) continue;
      evidence.push(`${url} states: "${clean}"`);
      break;
    }
  }
  return evidence;
}

export interface GatherResult {
  evidence: string[];
  /** Why nothing could be gathered, when that is the outcome. */
  reason?: string;
}

/**
 * Collect whatever evidence a lens's source type allows.
 *
 * An `author` lens with no supplied note returns nothing, deliberately: the
 * pipeline then drops it at the ladder rather than writing around the gap.
 */
export function gatherForLens(lens: Lens, ctx: EvidenceContext): GatherResult {
  switch (lens.evidenceSource) {
    case 'data': {
      const evidence = gatherDataEvidence(ctx.trend, ctx.topPosts);
      return evidence.length > 0
        ? { evidence }
        : { evidence: [], reason: 'no figures in the trend or its posts' };
    }
    case 'docs': {
      const docs = ctx.documents ?? {};
      if (Object.keys(docs).length === 0) {
        return { evidence: [], reason: 'no document was fetched to quote from' };
      }
      const evidence = gatherDocsEvidence(docs);
      return evidence.length > 0
        ? { evidence }
        : { evidence: [], reason: 'fetched documents contained no quotable line' };
    }
    case 'author': {
      const notes = ctx.authorNotes?.[lens.id] ?? [];
      return notes.length > 0
        ? { evidence: notes }
        : {
            evidence: [],
            reason: `"${lens.id}" needs something only the author can supply (${lens.evidenceRequired})`,
          };
    }
  }
}

export function gatherAll(lenses: Lens[], ctx: EvidenceContext): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const lens of lenses) {
    const result = gatherForLens(lens, ctx);
    if (result.evidence.length > 0) out[lens.id] = result.evidence;
  }
  return out;
}
