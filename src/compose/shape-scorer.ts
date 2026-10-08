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

/**
 * Compare a draft against recent posts.
 *
 * On failure the caller gets concrete numbers to change, not the advice to
 * "be different" - the instruction that produced the repetition in the first
 * place.
 */
export function checkShape(draft: string, recentPosts: string[]): ShapeVerdict {
  const here = measureShape(draft);
  if (recentPosts.length === 0) return { ok: true, nearest: Infinity, constraints: [] };

  const others = recentPosts.map(measureShape);
  const distances = others.map((o) => shapeDistance(here, o)).filter((d) => !Number.isNaN(d));
  if (distances.length === 0) return { ok: true, nearest: Infinity, constraints: [] };

  const nearest = Math.min(...distances);
  if (nearest >= SAME_SHAPE) return { ok: true, nearest, constraints: [] };

  const twin = others[distances.indexOf(nearest)]!;
  const constraints: string[] = [];

  if (Math.abs(here.paragraphs - twin.paragraphs) <= 1) {
    const target = here.paragraphs > 7 ? here.paragraphs - 3 : here.paragraphs + 3;
    constraints.push(`Use ${target} paragraphs, not ${here.paragraphs}.`);
  }
  if (here.cv < 0.4) {
    constraints.push(
      'Paragraph lengths are too even. Make at least one paragraph a single short line and ' +
        'one noticeably longer than the rest.',
    );
  }
  if (here.takePosition !== null && twin.takePosition !== null) {
    const move = here.takePosition > 0.5 ? 'into the opening third' : 'to the final paragraph';
    constraints.push(`Move your judgement ${move}.`);
  }
  if (here.endsWithQuestion === twin.endsWithQuestion) {
    constraints.push(
      here.endsWithQuestion
        ? 'End on a statement instead of a question.'
        : 'End on a question instead of a statement.',
    );
  }

  return {
    ok: false,
    nearest,
    constraints,
    reason: `Shape distance ${nearest.toFixed(3)} to a recent post, below ${SAME_SHAPE}. Same rhythm.`,
  };
}
