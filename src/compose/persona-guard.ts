import type Database from 'better-sqlite3';

/**
 * Phrases that name the author's day job outright.
 *
 * The first ten mirror `PERSONA_PHRASES` in the X pipeline's shape-analyzer,
 * one for one. The rest are English forms that file has no reason to carry,
 * because Square posts are written in English and the same tell arrives in a
 * different shape there.
 *
 * Word boundaries matter: a plain substring match on `QA` also fires on
 * "quality", which is a word this account uses constantly and legitimately.
 */
export const PERSONA_PATTERNS: RegExp[] = [
  /\bQA\b/i,
  /\bQA engineer\b/i,
  /\btester\b/i,
  /\btesters\b/i,
  /\bkiểm thử\b/i,
  /\btest case\b/i,
  /\bdân test\b/i,
  /\blàm test\b/i,
  /\b8 năm\b/i,
  /\btám năm\b/i,
  /\bnghề của mình\b/i,
  /\beight years\b/i,
  /\bmy day job\b/i,
  /\bwhere I work\b/i,
  /\bfor a living\b/i,
];

/**
 * At most one post in ten may name the job. Counted per platform: X and Square
 * keep separate histories, so a mention there does not spend Square's budget.
 *
 * Huynh set 1/10 on 2026-09-30, widened from 1/5. The X pipeline holds the same
 * numbers in `Content-Creator/tools/shape-analyzer.mjs`; if the two ever drift,
 * a phrase banned on one platform is quietly allowed on the other.
 */
export const PERSONA_CAP_WINDOW = 10;
export const PERSONA_CAP_MAX = 1;

export interface PersonaCheck {
  mentionsPersona: boolean;
  matched: string[];
}

export function detectPersona(text: string): PersonaCheck {
  const matched: string[] = [];
  for (const pattern of PERSONA_PATTERNS) {
    const m = text.match(pattern);
    if (m) matched.push(m[0]);
  }
  return { mentionsPersona: matched.length > 0, matched };
}

export interface PersonaVerdict {
  ok: boolean;
  reason?: string;
  /** How many of the recent posts already name the job. */
  recentCount: number;
}

/**
 * Decide whether this draft may name the job.
 *
 * Measured on the X pipeline (2026-09-27): once the identity layer said "draw
 * from here first", four of five posts named the job and two gave the exact
 * number of years. The model takes the cheapest available anchor every time,
 * and the bank offers only one. A cap is the part that binds; asking the layer
 * nicely is what failed.
 *
 * The craft answer is that the job should show through the reasoning - putting
 * expectation beside outcome, suspecting the inputs first - rather than through
 * a byline.
 */
export function checkPersona(draft: string, recentPosts: string[]): PersonaVerdict {
  const recentCount = recentPosts
    .slice(0, PERSONA_CAP_WINDOW)
    .filter((p) => detectPersona(p).mentionsPersona).length;

  const here = detectPersona(draft);
  if (!here.mentionsPersona) return { ok: true, recentCount };

  if (recentCount >= PERSONA_CAP_MAX) {
    return {
      ok: false,
      recentCount,
      reason:
        `Names the job (${here.matched.join(', ')}) but ${recentCount} of the last ` +
        `${PERSONA_CAP_WINDOW} posts already did. Cap is ${PERSONA_CAP_MAX} in ${PERSONA_CAP_WINDOW}. ` +
        'Rewrite the anchor as a stated position rather than a credential - the job should ' +
        'show in how the argument is built, not in a byline. Do not swap in a synonym.',
    };
  }

  return { ok: true, recentCount };
}

/** Bodies of the most recently published posts, newest first. */
export function recentPostBodies(db: Database.Database, limit = PERSONA_CAP_WINDOW): string[] {
  const rows = db
    .prepare('SELECT content_snapshot FROM posts ORDER BY published_at DESC LIMIT ?')
    .all(limit) as { content_snapshot: string }[];
  return rows.map((r) => r.content_snapshot);
}
