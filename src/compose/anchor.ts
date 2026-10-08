import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';
import type { AnchorBank, BankAnchor } from '../perspective/anchor-bank.js';
import type { Perspective } from '../perspective/types.js';
import { detectPersona } from './persona-guard.js';

/**
 * Which first-person anchor a post uses, decided before the draft is written.
 *
 * Rule E5 asks every post for a real first-person detail and lists where it
 * may come from. Left to the drafter, that choice collided with the persona
 * cap: the only experience in the prompt was the job, the cap refused the job,
 * and E5 refused a plain opinion. A model squeezed between two rules takes the
 * cheapest exit, and here the cheapest exit is an invented "I checked this
 * morning" that no gate can verify. Same lesson as `structure_rotation` and the
 * cap itself: a choice the model makes about its own output does not bind.
 *
 * So the pipeline walks the ladder, the drafter is told the result, and the
 * tone judge checks the post against it.
 */
export type AnchorTier = 'raw' | 'bank' | 'derived' | 'stance';

export interface AnchorAssignment {
  tier: AnchorTier;
  /** Bank anchor id for `bank`; null otherwise. */
  ref: string | null;
  /** The only first-person material the post may use. Empty for `stance`. */
  material: string[];
  /** False while the persona cap is in use. */
  mayNameJob: boolean;
}

export interface AnchorInput {
  perspective: Perspective;
  /** Notes the author sent today. */
  rawNotes: string[];
  bank: AnchorBank;
  /** Things the pipeline actually did while preparing this post, phrased as facts. */
  pipelineFacts: string[];
  /** Anchor tiers of this bot's recent published posts, newest first. */
  recentTiers: (AnchorTier | null)[];
  personaCapInUse: boolean;
  now: Date;
}

/**
 * E5 allows two or three derived anchors per campaign. This bot has no
 * campaigns, so the limit is a rolling one over the same ten-post window the
 * persona cap uses: enough to be useful, too few for "I went through the posts
 * under this tag" to become the account's signature line.
 */
export const DERIVED_MAX = 3;
export const DERIVED_WINDOW = 10;

const DAY_MS = 86_400_000;

function offCooldown(a: BankAnchor, cooldownDays: number, now: Date): boolean {
  if (!a.lastUsed) return true;
  return now.getTime() - new Date(`${a.lastUsed}T00:00:00Z`).getTime() >= cooldownDays * DAY_MS;
}

function pickFromBank(input: AnchorInput): BankAnchor | null {
  const { perspective, bank, personaCapInUse, now } = input;
  // Only a lens says which experiences fit. An anchor borrowed from another
  // lens is how a post about rate cuts ends up opening on a test plan.
  if (perspective.kind !== 'lens') return null;

  const candidates = bank.anchors
    .filter((a) => a.lenses.includes(perspective.ref))
    .filter((a) => offCooldown(a, bank.cooldownDays, now))
    .filter((a) => !(personaCapInUse && detectPersona(a.textEn).mentionsPersona));

  // Never used first, then the one rested longest.
  candidates.sort((a, b) => (a.lastUsed ?? '').localeCompare(b.lastUsed ?? ''));
  return candidates[0] ?? null;
}

export function resolveAnchor(input: AnchorInput): AnchorAssignment {
  const mayNameJob = !input.personaCapInUse;

  if (input.rawNotes.length > 0) {
    return { tier: 'raw', ref: null, material: input.rawNotes, mayNameJob };
  }

  const fromBank = pickFromBank(input);
  if (fromBank) {
    return { tier: 'bank', ref: fromBank.id, material: [fromBank.textEn], mayNameJob };
  }

  const derivedLately = input.recentTiers
    .slice(0, DERIVED_WINDOW)
    .filter((t) => t === 'derived').length;
  if (input.pipelineFacts.length > 0 && derivedLately < DERIVED_MAX) {
    return { tier: 'derived', ref: null, material: input.pipelineFacts, mayNameJob };
  }

  return { tier: 'stance', ref: null, material: [], mayNameJob };
}

/**
 * What the pipeline did for this post, as material for a derived anchor.
 *
 * Built from what actually happened in this run and nothing else: E5 allows a
 * derived anchor only about work the pipeline really did that day. The reader
 * call can fail without stopping the run, so reading is claimed only when posts
 * came back.
 */
export function pipelineFactsFor(trend: Trend, topPosts: HashtagPost[]): string[] {
  const facts: string[] = [];
  if (topPosts.length > 0) {
    facts.push(`Read the ${topPosts.length} most-read posts under ${trend.hashtag} on Binance Square.`);
  }
  facts.push(
    `Looked up ${trend.hashtag} on Square's trending page: ${trend.viewCount} views across ` +
      `${trend.contentCount} posts.`,
  );
  return facts;
}

const TIER_LEAD: Record<Exclude<AnchorTier, 'stance'>, string> = {
  raw: 'The author sent this today. Use it as the first-person detail, in your own words, adding nothing to it:',
  bank:
    "A real experience of the author's, already stripped of anything identifying. Use it as the " +
    'first-person detail, in your own words. Keep its mechanism; add no names, numbers or outcomes ' +
    'it does not contain:',
  derived:
    'Things actually done today while preparing this post. You may describe one of them in first ' +
    'person. Vary the wording; do not open on "I checked" or "I looked at":',
};

/** The block the drafter reads. */
export function anchorInstructions(a: AnchorAssignment): string {
  const lines = [`### Personal anchor (Rule E5, tier: ${a.tier}). Already chosen; do not pick another.`, ''];

  if (a.tier === 'stance') {
    lines.push(
      'No first-person experience is available for this post. Anchor it on a stated position ' +
        'instead: take a side, in first person, and own it. Do not claim to have done, seen, held, ' +
        'traded or tested anything.',
    );
  } else {
    lines.push(TIER_LEAD[a.tier], '', ...a.material.map((m) => `- ${m}`), '');
    lines.push(
      'This is the only first-person material available. Any other claim of something you did, ' +
        'saw, held or tested is invented, and an invented anchor fails the post.',
    );
  }

  lines.push(
    '',
    a.mayNameJob
      ? "The author's job may be named only if the topic is itself about testing or process."
      : "Do not name the author's job or years of experience, in any wording. That allowance is used up for now.",
  );
  return lines.join('\n');
}

/** The block the tone judge reads, so E5 is checked against the same decision. */
export function anchorBrief(a: AnchorAssignment): string {
  const lines = [
    '## Anchor assigned to this post',
    '',
    `The pipeline chose this post's personal anchor before it was written. Rule E5 tier: ${a.tier}.`,
  ];

  if (a.tier === 'stance') {
    lines.push(
      'No first-person material was available, so a stated position satisfies E5 for this post. ' +
        'Do not ask for an experience.',
      'Report as "E5 - fabricated - <exact text>" any first-person claim of something done, seen, ' +
        'held, traded or tested.',
    );
  } else {
    lines.push(
      'Material:',
      ...a.material.map((m) => `- ${m}`),
      'E5 is satisfied when the post uses this anchor.',
      'Report as "E5 - fabricated - <exact text>" any first-person claim of something done, seen, ' +
        'held, traded or tested that this material does not support.',
    );
  }

  lines.push(
    a.mayNameJob
      ? "Naming the author's profession is not fabrication."
      : "The post must not name the author's job or years of experience. Report it as " +
          '"E5 - names the job - <exact text>".',
  );
  return lines.join('\n');
}
