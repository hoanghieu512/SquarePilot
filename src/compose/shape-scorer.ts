/**
 * Measure the shape of a post from its text.
 *
 * Ported from `Content-Creator/tools/shape-analyzer.mjs`. It exists because
 * `structure_rotation` - the model declaring how each post differed - did not
 * stop repetition: two consecutive Dusk posts declared four different axes and
 * still ran the same seven-paragraph rhythm, the same anchor opener and the
 * same `My take:` turn. A number computed from the published text can be
 * contradicted; a claim about it cannot.
 */

const TAKE_MARKERS: RegExp[] = [
  /\bmy take\b/i,
  /\bthe way i (read|see) it\b/i,
  /\bwhat i (think|keep landing on)\b/i,
  /^với mình\b/im,
  /\bquan điểm của mình\b/i,
  /\bmình nghĩ\b/i,
  /\btheo mình\b/i,
];

const FIRST_PERSON = /^(mình|tôi|my|i|i'm|i've)\b/i;

export type Opening = 'NUM' | 'SELF' | 'QUOTE' | 'WORD';

export interface ShapeMetrics {
  paragraphs: number;
  meanWords: number;
  /** Length variety across paragraphs. Low means a metronomic rhythm. */
  cv: number;
  shortSentenceRatio: number;
  /** Where the opinion lands, 0 = first paragraph, 1 = last. Null if absent. */
  takePosition: number | null;
  questionParagraphs: number;
  endsWithQuestion: boolean;
  opening: Opening;
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#\w+([\s#\w]*)$/.test(p)); // drop hashtag-only lines
}

export function measureShape(text: string): ShapeMetrics {
  const paras = paragraphsOf(text);
  const wpp = paras.map(words);
  const mean = wpp.reduce((a, b) => a + b, 0) / (wpp.length || 1);
  const variance = wpp.reduce((a, b) => a + (b - mean) ** 2, 0) / (wpp.length || 1);

  const sentences = paras.flatMap(sentencesOf);
  const shortRatio = sentences.length
    ? sentences.filter((s) => words(s) < 10).length / sentences.length
    : 0;

  const takeIdx = paras.findIndex((p) => TAKE_MARKERS.some((re) => re.test(p)));
  const first = paras[0] ?? '';

  return {
    paragraphs: paras.length,
    meanWords: Math.round(mean),
    cv: mean ? Number((Math.sqrt(variance) / mean).toFixed(2)) : 0,
    shortSentenceRatio: Number(shortRatio.toFixed(2)),
    takePosition: takeIdx === -1 ? null : Number((takeIdx / Math.max(paras.length - 1, 1)).toFixed(2)),
    questionParagraphs: paras.filter((p) => p.includes('?')).length,
    endsWithQuestion: (paras[paras.length - 1] ?? '').trim().endsWith('?'),
    opening: /^[“"«]/.test(first)
      ? 'QUOTE'
      : /^\d/.test(first)
        ? 'NUM'
        : FIRST_PERSON.test(first)
          ? 'SELF'
          : 'WORD',
  };
}

/**
 * Continuous dimensions only.
 *
 * `opening` is excluded: as a one-hot it produced discrete 1.0 jumps that
 * drowned out every real signal, so one changed opener could mask an otherwise
 * identical post. A dimension is skipped when either post lacks it, and the
 * result is renormalised so distances stay comparable.
 */
function dims(m: ShapeMetrics): (number | null)[] {
  return [
    Math.min(m.paragraphs / 16, 1),
    Math.min(m.cv / 0.8, 1),
    m.shortSentenceRatio,
    m.takePosition,
    Math.min(m.questionParagraphs / 4, 1),
    m.endsWithQuestion ? 1 : 0,
  ];
}

export function shapeDistance(a: ShapeMetrics, b: ShapeMetrics): number {
  const [va, vb] = [dims(a), dims(b)];
  let sum = 0;
  let used = 0;
  for (let i = 0; i < va.length; i++) {
    const x = va[i];
    const y = vb[i];
    if (x === null || y === null || x === undefined || y === undefined) continue;
    sum += (x - y) ** 2;
    used++;
  }
  return used ? Math.sqrt(sum / used) : NaN;
}

/**
 * Calibrated against the pair a human called repetitive, not derived.
 *
 * The Dusk run measured 0.486 -> 0.187 -> 0.134 on consecutive days, and the
 * last pair is the one Huynh read as "same format" while the declared rotation
 * claimed all four axes differed. An earlier value of 0.12, taken from a
 * different campaign, would have passed that pair - the gate would have missed
 * the only case it was built for. A false positive here costs one rewrite; a
 * false negative ships the repetition.
 */
export const SAME_SHAPE = 0.15;
export const CLOSE_SHAPE = 0.25;

export interface ShapeVerdict {
  ok: boolean;
  nearest: number;
  reason?: string;
  /** Instructions the drafter can act on literally. */
  constraints: string[];
}

/** One change the drafter can make, and the shape it would leave. */
interface Move {
  instruction: string;
  apply(m: ShapeMetrics): ShapeMetrics;
}

function nearestTo(m: ShapeMetrics, others: ShapeMetrics[]): number {
  const ds = others.map((o) => shapeDistance(m, o)).filter((d) => !Number.isNaN(d));
  return ds.length ? Math.min(...ds) : Infinity;
}

function movesFor(here: ShapeMetrics): Move[] {
  const moves: Move[] = [];
  for (const delta of [3, -3, 5, -5]) {
    const target = here.paragraphs + delta;
    if (target < 3) continue;
    moves.push({
      instruction: `Use ${target} paragraphs, not ${here.paragraphs}.`,
      // Same length spread over more or fewer paragraphs.
      apply: (m) => ({ ...m, paragraphs: target, meanWords: Math.round((m.meanWords * m.paragraphs) / target) }),
    });
  }
  if (here.takePosition !== null) {
    const late = here.takePosition > 0.5;
    moves.push({
      instruction: `Move your judgement ${late ? 'into the opening third' : 'to the final paragraph'}.`,
      apply: (m) => ({ ...m, takePosition: late ? 0.2 : 1 }),
    });
  }
  moves.push({
    instruction: here.endsWithQuestion
      ? 'End on a statement instead of a question.'
      : 'End on a question instead of a statement.',
    apply: (m) => ({
      ...m,
      endsWithQuestion: !m.endsWithQuestion,
      questionParagraphs: m.endsWithQuestion ? Math.max(0, m.questionParagraphs - 1) : m.questionParagraphs + 1,
    }),
  });
  return moves;
}

/**
 * Compare a draft against recent posts.
 *
 * On failure the caller gets concrete numbers to change, not the advice to
 * "be different" - the instruction that produced the repetition in the first
 * place.
 *
 * Each change is tried on the measured shape first and kept only if it moves
 * the draft away from every recent post, not just the nearest one. Steering
 * by the nearest post alone once sent a draft from a post that ended on a
 * statement straight into posts that ended on a question, and back, until
 * every attempt was spent (2026-11-16).
 */
export function checkShape(draft: string, recentPosts: string[]): ShapeVerdict {
  const here = measureShape(draft);
  if (recentPosts.length === 0) return { ok: true, nearest: Infinity, constraints: [] };

  const others = recentPosts.map(measureShape);
  const nearest = nearestTo(here, others);
  if (nearest === Infinity || nearest >= SAME_SHAPE) return { ok: true, nearest, constraints: [] };

  const constraints: string[] = [];
  if (here.cv < 0.4) {
    constraints.push(
      'Paragraph lengths are too even. Make at least one paragraph a single short line and ' +
        'one noticeably longer than the rest.',
    );
  }

  // Greedy: take the change that leaves the draft farthest from everything
  // recent, then the next on top of it, until it is clear or nothing helps.
  let shape = here;
  let distance = nearest;
  let remaining = movesFor(here);
  while (distance < SAME_SHAPE && remaining.length > 0) {
    const scored = remaining.map((move) => ({ move, d: nearestTo(move.apply(shape), others) }));
    const best = scored.reduce((a, b) => (b.d > a.d ? b : a));
    if (best.d <= distance) break;
    constraints.push(best.move.instruction);
    shape = best.move.apply(shape);
    distance = best.d;
    // One paragraph count, one ending, one take position.
    const kind = best.move.instruction.split(' ')[0];
    remaining = remaining.filter((m) => m.instruction.split(' ')[0] !== kind);
  }

  if (constraints.length === 0) {
    constraints.push(`Use ${here.paragraphs > 7 ? here.paragraphs - 3 : here.paragraphs + 3} paragraphs, not ${here.paragraphs}.`);
  }

  return {
    ok: false,
    nearest,
    constraints,
    reason: `Shape distance ${nearest.toFixed(3)} to a recent post, below ${SAME_SHAPE}. Same rhythm.`,
  };
}
