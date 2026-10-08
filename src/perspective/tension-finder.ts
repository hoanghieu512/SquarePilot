import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';

export interface Tension {
  /** A statement that can be checked, never a rhetorical question. */
  claim: string;
  evidence: string[];
  kind: 'framing' | 'consensus' | 'scale';
}

export interface TensionResult {
  accepted: Tension[];
  rejected: { claim: string; reason: string }[];
}

/**
 * A tension must be a claim, not a question.
 *
 * "Is the market wrong about this?" costs nothing to write and commits to
 * nothing. It is the shape a model reaches for when it has no material, and
 * accepting it would let the last rung of the ladder pass anything.
 */
export function validateClaim(claim: string): { ok: boolean; reason?: string } {
  const trimmed = claim.trim();
  if (trimmed.length < 25) return { ok: false, reason: 'too short to be a claim' };
  if (trimmed.endsWith('?')) return { ok: false, reason: 'is a question, not a checkable claim' };
  if (/^(is|are|does|do|will|should|could|what|why|how|who)\b/i.test(trimmed)) {
    return { ok: false, reason: 'reads as a rhetorical question' };
  }
  if (!/\d/.test(trimmed) && !/\b(both|while|but|yet|whereas|despite|although)\b/i.test(trimmed)) {
    return {
      ok: false,
      reason: 'states no contrast and cites no number — nothing here can be checked',
    };
  }
  return { ok: true };
}

/** Words too generic to mean two trends are about the same thing. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'as', 'by',
  'is', 'are', 'was', 'be', 'from', 'with', 'new', 'us', 'this', 'that', 'its',
  'hits', 'falls', 'rises', 'could', 'will', 'may', 'than', 'more', 'less',
]);

export function significantWords(hashtag: string): string[] {
  return hashtag
    .replace(/^#/, '')
    // Split an acronym from the word after it: USJobless -> US Jobless. Without
    // this the whole prefix stays glued and no angle can ever match the trend.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9.%$]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Two trends telling one story through different time frames.
 *
 * Observed 2026-08-19: `#DollarHits3MonthLow` and `#DollarFallsTo10WeekLow`
 * ran simultaneously — the same move, framed twice. The choice of frame is
 * the story, and it is visible in the data without asking a model anything.
 */
export function findFramingTensions(trends: Trend[]): Tension[] {
  const tensions: Tension[] = [];
  const words = trends.map((t) => new Set(significantWords(t.hashtag)));

  for (let i = 0; i < trends.length; i++) {
    for (let j = i + 1; j < trends.length; j++) {
      const a = words[i]!;
      const b = words[j]!;
      const shared = [...a].filter((w) => b.has(w));
      if (shared.length === 0) continue;

      const overlap = shared.length / Math.min(a.size, b.size);
      if (overlap < 0.5) continue;

      tensions.push({
        kind: 'framing',
        claim:
          `${trends[i]!.hashtag} and ${trends[j]!.hashtag} are trending at the same time about ` +
          `the same subject (${shared.join(', ')}), told through two different frames.`,
        evidence: [
          `${trends[i]!.hashtag}: ${trends[i]!.viewCount} views, ${trends[i]!.contentCount} posts`,
          `${trends[j]!.hashtag}: ${trends[j]!.viewCount} views, ${trends[j]!.contentCount} posts`,
        ],
      });
    }
  }
  return tensions;
}

/**
 * Attention and discussion pulling in opposite directions.
 *
 * Many views with few posts means people read and had nothing to add; many
 * posts with few views means people are talking past an audience that is not
 * there. Both are facts about the topic, taken straight from the trend row.
 */
export function findScaleTensions(trends: Trend[]): Tension[] {
  const tensions: Tension[] = [];
  for (const t of trends) {
    if (t.contentCount < 5) continue;
    const viewsPerPost = t.viewCount / t.contentCount;

    if (viewsPerPost > 200) {
      tensions.push({
        kind: 'scale',
        claim:
          `${t.hashtag} drew ${t.viewCount} views across only ${t.contentCount} posts ` +
          `(${Math.round(viewsPerPost)} views per post), so far more people are reading it than writing about it.`,
        evidence: [`viewCount=${t.viewCount}`, `contentCount=${t.contentCount}`],
      });
    } else if (viewsPerPost < 20) {
      tensions.push({
        kind: 'scale',
        claim:
          `${t.hashtag} has ${t.contentCount} posts but only ${t.viewCount} views ` +
          `(${viewsPerPost.toFixed(1)} per post), so the writing is outrunning the readership.`,
        evidence: [`viewCount=${t.viewCount}`, `contentCount=${t.contentCount}`],
      });
    }
  }
  return tensions;
}

/**
 * A point the top posts all repeat is a point nobody has examined.
 *
 * The hashtag's own words are excluded: every post under a tag repeats the tag,
 * so counting them found a "consensus" on every trend — measured 2026-08-22,
 * this fired on all five candidates and meant nothing.
 */
export function findConsensusTension(hashtag: string, posts: HashtagPost[]): Tension | null {
  if (posts.length < 4) return null;

  // Posts under a tag repeat the tag itself, often as one unbroken lowercase
  // string, and frequently as a cashtag too. Comparing against the *split*
  // words missed both forms, so a "consensus" was reported on every trend.
  const ownWords = new Set(significantWords(hashtag));
  const ownHaystack = hashtag.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isOwnTerm = (w: string): boolean => {
    const bare = w.replace(/[^a-z0-9]/g, '');
    return bare.length > 0 && (ownWords.has(w) || ownHaystack.includes(bare));
  };

  const counts = new Map<string, number>();
  for (const post of posts) {
    const seen = new Set(
      post.text
        .toLowerCase()
        .split(/[^a-z0-9$%.]+/)
        .filter((w) => w.length > 4 && !STOPWORDS.has(w) && !isOwnTerm(w)),
    );
    for (const word of seen) counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const threshold = Math.ceil(posts.length * 0.8);
  const shared = [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([w]) => w)
    .slice(0, 5);

  // Two shared words is noise at this sample size; three is a pattern.
  if (shared.length < 3) return null;

  return {
    kind: 'consensus',
    claim:
      `Of the ${posts.length} top posts under ${hashtag}, at least ${threshold} lean on the same ` +
      `terms (${shared.join(', ')}), so the discussion has settled on one framing.`,
    evidence: shared.map((w) => `"${w}" appears in ${counts.get(w)} of ${posts.length} top posts`),
  };
}

export function findTensions(
  trends: Trend[],
  topPosts: { hashtag: string; posts: HashtagPost[] }[] = [],
): TensionResult {
  const candidates = [
    ...findFramingTensions(trends),
    ...findScaleTensions(trends),
    ...topPosts
      .map((t) => findConsensusTension(t.hashtag, t.posts))
      .filter((t): t is Tension => t !== null),
  ];

  const accepted: Tension[] = [];
  const rejected: { claim: string; reason: string }[] = [];

  for (const tension of candidates) {
    const check = validateClaim(tension.claim);
    if (check.ok && tension.evidence.length > 0) {
      accepted.push(tension);
    } else {
      rejected.push({ claim: tension.claim, reason: check.reason ?? 'no evidence attached' });
    }
  }

  return { accepted, rejected };
}
