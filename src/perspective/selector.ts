import type Database from 'better-sqlite3';
import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';
import { usableAngles, type Angle } from './angle-store.js';
import { eligibleLenses, verifyEvidence, type Lens } from './lens-store.js';
import { findTensions, significantWords, type Tension } from './tension-finder.js';
import { classifyTopics } from './topics.js';
import type { Perspective, Rejection, SelectionResult } from './types.js';

export interface SelectorInput {
  trend: Trend;
  /** All trends from this run — framing tensions need the neighbours. */
  allTrends: Trend[];
  angles: Angle[];
  lenses: Lens[];
  topPosts?: HashtagPost[];
  /** Evidence gathered for a lens, keyed by lens id. Empty means none found. */
  lensEvidence?: Record<string, string[]>;
  now?: Date;
}

/**
 * One shared word is not a match.
 *
 * Measured 2026-08-22: an angle about Babylon's Trustless Bitcoin Vaults was
 * paired with #BitcoinBestWeekSinceMarch2023 on the strength of the word
 * "bitcoin" alone. That is the "bot stitched two unrelated things together"
 * failure the ladder exists to prevent, so a match needs real overlap.
 */
const MIN_ANGLE_OVERLAP = 2;

/** Overlap between an angle's tags/title and the trend's own words. */
function angleMatches(angle: Angle, trendWords: Set<string>): string[] {
  const angleWords = new Set([
    ...angle.tags.map((t) => t.toLowerCase()),
    ...(angle.title ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  ]);
  return [...angleWords].filter((w) => trendWords.has(w));
}

/**
 * Walk `angle → lens → tension → stop`.
 *
 * Every rung records why each candidate lost, including the run that ends in
 * `stop`. Without those rows a quiet day and a broken selector look identical
 * from the outside, and the first one to be misread would be a real bug.
 *
 * Nothing here calls a model. The ladder decides *whether* there is something
 * to say; the drafter later decides how to say it.
 */
export function selectPerspective(input: SelectorInput): SelectionResult {
  const now = input.now ?? new Date();
  const rejected: Rejection[] = [];
  const trendWords = new Set(significantWords(input.trend.hashtag));

  // Rung 1 — an angle already written for this story.
  const angleFilter = usableAngles(input.angles, now);
  for (const r of angleFilter.rejected) {
    rejected.push({ rung: 'angle', candidate: r.candidate, reason: r.reason });
  }

  const scored = angleFilter.usable
    .map((angle) => ({ angle, matched: angleMatches(angle, trendWords) }))
    .sort((a, b) => b.matched.length - a.matched.length);

  for (const { angle, matched } of scored) {
    const label = angle.title ?? angle.path;
    if (matched.length < MIN_ANGLE_OVERLAP) {
      rejected.push({
        rung: 'angle',
        candidate: label,
        reason:
          matched.length === 0
            ? `nothing in common with ${input.trend.hashtag}`
            : `only "${matched.join(', ')}" in common with ${input.trend.hashtag} — too thin to pair`,
      });
      continue;
    }
    return {
      outcome: 'angle',
      perspective: {
        kind: 'angle',
        ref: angle.path,
        summary: label,
        evidence: [`shares ${matched.join(', ')} with ${input.trend.hashtag}`],
        guardrails: angle.guardrails,
      },
      rejected,
    };
  }

  // Rung 2 — a reusable lens, but only with the evidence it demands.
  // Lenses are written against abstract topics, not the literal words in a
  // hashtag, so the hashtag is classified before it is compared.
  const topics = [
    ...classifyTopics(input.trend.hashtag),
    ...input.trend.tradingPairs.map((p) => p.code.toLowerCase()),
  ];
  const lensFilter = eligibleLenses(input.lenses, topics, now);
  for (const r of lensFilter.rejected) {
    rejected.push({ rung: 'lens', candidate: r.candidate, reason: r.reason });
  }

  for (const candidate of lensFilter.candidates) {
    const evidence = input.lensEvidence?.[candidate.lens.id] ?? [];
    const check = verifyEvidence(candidate.lens, evidence);
    if (!check.ok) {
      rejected.push({ rung: 'lens', candidate: candidate.lens.id, reason: check.reason! });
      continue;
    }
    return {
      outcome: 'lens',
      perspective: {
        kind: 'lens',
        ref: candidate.lens.id,
        summary: candidate.lens.name,
        evidence: check.evidence,
        guardrails: [],
      },
      rejected,
    };
  }

  // Rung 3 — a tension visible in the data itself.
  const tensions = findTensions(input.allTrends, [
    { hashtag: input.trend.hashtag, posts: input.topPosts ?? [] },
  ]);
  for (const r of tensions.rejected) {
    rejected.push({ rung: 'tension', candidate: r.claim.slice(0, 60), reason: r.reason });
  }

  const relevant = tensions.accepted.filter(
    (t) => t.claim.includes(input.trend.hashtag) || t.kind === 'consensus',
  );
  const chosen: Tension | undefined = relevant[0];
  if (chosen) {
    return {
      outcome: 'tension',
      perspective: {
        kind: 'tension',
        ref: chosen.kind,
        summary: chosen.claim,
        evidence: chosen.evidence,
        guardrails: [],
      },
      rejected,
    };
  }

  if (tensions.accepted.length > 0) {
    rejected.push({
      rung: 'tension',
      candidate: 'other trends',
      reason: `${tensions.accepted.length} tension(s) found, none about ${input.trend.hashtag}`,
    });
  }

  return { outcome: 'stop', rejected };
}

export function recordSelection(
  db: Database.Database,
  trendId: number,
  result: SelectionResult,
  mode: string | null,
  dataGate: string | null = null,
): number {
  const ref = result.outcome === 'stop' ? null : result.perspective.ref;
  const info = db
    .prepare(
      `INSERT INTO selections (trend_id, outcome, source_ref, mode, rejected_notes, data_gate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trendId,
      result.outcome,
      ref,
      mode,
      JSON.stringify(result.rejected.map((r) => `[${r.rung}] ${r.candidate}: ${r.reason}`)),
      dataGate,
      new Date().toISOString(),
    );
  return Number(info.lastInsertRowid);
}

export type { Perspective, SelectionResult };
