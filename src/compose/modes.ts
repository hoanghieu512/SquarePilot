import type Database from 'better-sqlite3';

export const MODES = [
  'explain',
  'breakdown',
  'observation',
  'contrarian',
  'implication',
  'compare',
] as const;

export type Mode = (typeof MODES)[number];

export interface ShapeConstraints {
  /** Inclusive paragraph range the draft must land in. */
  paragraphs: [number, number];
  /** Where the author's own judgement belongs, as a fraction of the post. */
  takePosition: [number, number];
  /** How many paragraphs may contain a question. */
  maxQuestionParagraphs: number;
  /** How the first sentence must open. */
  opening: string;
}

export interface ModeSpec {
  mode: Mode;
  question: string;
  constraints: ShapeConstraints;
}

/**
 * Six ways to present the same perspective.
 *
 * The constraints are the point. `structure_rotation` in Content-Creator asked
 * the model to self-report how each post differed, and measurement showed it
 * reported enough difference to pass while converging on one shape anyway —
 * two consecutive Dusk posts declared four different axes and still ran the
 * same seven-paragraph rhythm. These numbers are checkable after the fact,
 * so a claim of variety can be contradicted.
 */
export const MODE_SPECS: Record<Mode, ModeSpec> = {
  explain: {
    mode: 'explain',
    question: 'What does this actually mean?',
    constraints: {
      paragraphs: [5, 7],
      takePosition: [0.6, 0.85],
      maxQuestionParagraphs: 1,
      opening: 'the plain-language restatement of the thing being explained',
    },
  },
  breakdown: {
    mode: 'breakdown',
    question: 'How does this mechanism work?',
    constraints: {
      paragraphs: [7, 10],
      takePosition: [0.75, 1.0],
      maxQuestionParagraphs: 1,
      opening: 'the first step of the mechanism, stated as fact',
    },
  },
  observation: {
    mode: 'observation',
    question: 'What is the most notable thing here?',
    constraints: {
      paragraphs: [4, 6],
      takePosition: [0.0, 0.3],
      maxQuestionParagraphs: 2,
      opening: 'the observation itself, no setup',
    },
  },
  contrarian: {
    mode: 'contrarian',
    question: 'What is everyone missing?',
    constraints: {
      paragraphs: [5, 8],
      takePosition: [0.3, 0.55],
      maxQuestionParagraphs: 2,
      opening: 'the consensus view, stated fairly before it is challenged',
    },
  },
  implication: {
    mode: 'implication',
    question: 'What could this lead to?',
    constraints: {
      paragraphs: [6, 9],
      takePosition: [0.85, 1.0],
      maxQuestionParagraphs: 3,
      opening: 'the present fact the implications hang from',
    },
  },
  compare: {
    mode: 'compare',
    question: 'How is this different from the old way?',
    constraints: {
      paragraphs: [6, 9],
      takePosition: [0.5, 0.75],
      maxQuestionParagraphs: 1,
      opening: 'the older approach, described without judgement',
    },
  },
};

/** How many recent posts block a mode from being picked again. */
export const MODE_COOLDOWN_POSTS = 3;

export interface ModeChoice {
  spec: ModeSpec;
  excluded: { mode: Mode; reason: string }[];
  /** True when every mode was blocked and the oldest was reused. */
  forced: boolean;
}

export function recentModes(db: Database.Database, limit = MODE_COOLDOWN_POSTS): Mode[] {
  const rows = db
    .prepare(
      `SELECT s.mode AS mode
         FROM posts p
         JOIN drafts d     ON d.id = p.draft_id
         JOIN selections s ON s.id = d.selection_id
        WHERE s.mode IS NOT NULL
        ORDER BY p.published_at DESC
        LIMIT ?`,
    )
    .all(limit) as { mode: string }[];
  return rows.map((r) => r.mode).filter((m): m is Mode => (MODES as readonly string[]).includes(m));
}

/**
 * Pick a mode that has not been used in the recent window.
 *
 * `recent` is ordered newest first. When every mode is blocked the least
 * recently used one is reused rather than throwing: a stalled pipeline is a
 * worse outcome than a repeated shape, and `forced` records that it happened.
 */
export function selectMode(recent: Mode[], available: readonly Mode[] = MODES): ModeChoice {
  const blocked = new Set(recent.slice(0, MODE_COOLDOWN_POSTS));

  const excluded = [...blocked]
    .filter((m) => available.includes(m))
    .map((mode) => ({ mode, reason: `used in the last ${MODE_COOLDOWN_POSTS} posts` }));

  const free = available.filter((m) => !blocked.has(m));

  if (free.length > 0) {
    return { spec: MODE_SPECS[free[0]!], excluded, forced: false };
  }

  const oldest = recent[recent.length - 1] ?? available[0]!;
  return { spec: MODE_SPECS[oldest], excluded, forced: true };
}

/** Turn constraints into instructions the drafter can follow literally. */
export function constraintsAsInstructions(spec: ModeSpec): string[] {
  const c = spec.constraints;
  const [lo, hi] = c.takePosition;
  const where =
    hi <= 0.35 ? 'in the opening third' : lo >= 0.75 ? 'at the very end' : 'in the middle stretch';
  return [
    `Answer this question and only this one: ${spec.question}`,
    `Write between ${c.paragraphs[0]} and ${c.paragraphs[1]} paragraphs.`,
    `Put your own judgement ${where} of the post.`,
    `At most ${c.maxQuestionParagraphs} paragraph${c.maxQuestionParagraphs === 1 ? '' : 's'} may contain a question.`,
    `Open with ${c.opening}.`,
  ];
}
