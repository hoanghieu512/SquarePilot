import { CAPS, type VisualSchema } from './data-gate.js';
import { extractFigures, figureAppearsIn, isSupported, type Figure } from './fact-figures.js';

/**
 * Make the card agree with the post it travels with.
 *
 * The data gate picks the focal number from other people's posts before the
 * draft exists, to prove a card can be built at all. On the 2026-11-14 dry run
 * the card's big number appeared nowhere in the post, so a reader saw a figure
 * the author never stated or sourced. After the fact gate, every figure in the
 * draft is backed by the evidence, so the draft is the safe place to take the
 * card's numbers from, written exactly as the draft writes them.
 */

export type AlignResult =
  | { ok: true; schema: Partial<VisualSchema>; changed: string[] }
  | { ok: false; reason: string };

/** Units that make a figure worth the panel, best first. */
const FOCAL_PREFERENCE = ['percent', 'currency', 'multiple', 'bps', 'plain'] as const;

/**
 * The draft's own figure for a card value: the same number, either exactly or
 * rounded in one direction ("2.47%" on the card, "2.5%" in the draft).
 */
function draftFigureFor(cardValue: string, draft: Figure[]): Figure | undefined {
  const [card] = extractFigures(cardValue);
  if (!card) return undefined;
  return draft.find((f) => isSupported(f, [card]) || isSupported(card, [f]));
}

/** Words that cannot start a caption: what follows them is not the figure's subject. */
const NOT_A_SUBJECT = new Set(
  (
    'a an the and or but nor so yet while whereas as than to of in on at for from by with into onto over under ' +
    'since after before because against versus vs which that who is was are were be been it its this these those'
  ).split(' '),
);
/** Words after a figure that set it against another: the caption takes them. */
const COMPARISON = new Set(['against', 'versus', 'vs', 'than', 'from', 'compared']);
/**
 * Words a caption must not end on. "in" and "on" are left out: they close
 * phrasal verbs ("came in", "held on") as often as they open a phrase.
 */
const DANGLING = new Set('a an the and or but of to at for from by with across into as than'.split(' '));

function trimCaption(words: string[], cap: number, fromEnd: boolean): string | undefined {
  const kept: string[] = [];
  for (const w of fromEnd ? [...words].reverse() : words) {
    const next = fromEnd ? [w, ...kept] : [...kept, w];
    if (next.join(' ').length > cap) break;
    if (fromEnd) kept.unshift(w);
    else kept.push(w);
  }
  while (kept.length > 0 && DANGLING.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();
  while (kept.length > 0 && DANGLING.has(kept[0]!.toLowerCase()) && fromEnd) kept.shift();
  const text = kept.join(' ').replace(/[,;:.!?]+$/, '');
  return text.length >= 3 ? text : undefined;
}

/**
 * What a figure is, quoted from the sentence it sits in: "283,050 views
 * across 2,344 posts" gives "views across 2,344 posts"; "Volume rose 12% while
 * price went nowhere" gives "Volume rose". The words after the figure are used
 * when they name it, the words before it otherwise, each only up to the
 * nearest clause break. Verbatim, so the card never says anything the post
 * does not.
 */
export function focalCaption(body: string, figure: Figure, cap = CAPS.focal_subline): string | undefined {
  const lineStart = body.lastIndexOf('\n', figure.index - 1) + 1;
  const nl = body.indexOf('\n', figure.index);
  const line = body.slice(lineStart, nl === -1 ? body.length : nl);
  // The hashtag line routes the post; nothing in it describes a figure.
  if (line.trimStart().startsWith('#')) return undefined;

  const at = figure.index - lineStart;
  const head = line.slice(0, at);
  const tail = line.slice(at + figure.raw.length);

  // Clause breaks: sentence ends, ", " "; " ": " and brackets. A comma inside
  // a number ("2,344") is not followed by a space, so it does not break.
  const afterClause = tail.split(/[.!?](?:\s|$)|[,;:]\s|[()—–]/)[0]!.trim();
  const beforeParts = head.split(/[.!?]\s|[,;:]\s|[()—–]/);
  const beforeClause = beforeParts[beforeParts.length - 1]!.trim();

  const afterWords = afterClause.split(/\s+/).filter(Boolean);
  const first = afterWords[0]?.toLowerCase().replace(/[^a-z']/g, '') ?? '';
  // "6.5% against the expected 6.6%": a comparison reads whole under the
  // number, and says more than the words before it ("annual came in").
  const comparison = COMPARISON.has(first) && afterWords.length > 1;
  if (afterWords.length > 0 && /^[a-z]/i.test(afterWords[0]!) && (comparison || !NOT_A_SUBJECT.has(first))) {
    return trimCaption(afterWords, cap, false);
  }
  return trimCaption(beforeClause.split(/\s+/).filter(Boolean), cap, true);
}

export function alignVisualToDraft(
  schema: Partial<VisualSchema>,
  body: string,
  opts: {
    currentYear: number;
    /**
     * Focal numbers already shown for this draft, as the draft writes them.
     * A "new visual" request asks for a different figure, never the same one.
     */
    excludeFocal?: string[];
  },
): AlignResult {
  const changed: string[] = [];
  const out: Partial<VisualSchema> = { ...schema };
  const draft = extractFigures(body, { currentYear: opts.currentYear });
  const excluded = new Set(opts.excludeFocal ?? []);

  let focalFigure: Figure;
  const focalMatch = out.focal_number ? draftFigureFor(out.focal_number, draft) : undefined;
  if (focalMatch && focalMatch.raw.length <= CAPS.focal_number && !excluded.has(focalMatch.raw)) {
    focalFigure = focalMatch;
    if (focalMatch.raw !== out.focal_number) {
      changed.push(`focal_number ${out.focal_number} -> ${focalMatch.raw}`);
      out.focal_number = focalMatch.raw;
    }
  } else {
    const pick = draft
      .filter((f) => f.raw.length <= CAPS.focal_number && !excluded.has(f.raw))
      .sort((a, b) => FOCAL_PREFERENCE.indexOf(a.unit) - FOCAL_PREFERENCE.indexOf(b.unit) || a.index - b.index)[0];
    if (!pick) {
      return {
        ok: false,
        reason:
          excluded.size > 0
            ? `the draft has no other figure that fits the panel (already shown: ${[...excluded].join(', ')})`
            : `focal number ${out.focal_number ?? '(none)'} is not in the draft and the draft has no figure that fits the panel`,
      };
    }
    changed.push(`focal_number ${out.focal_number ?? '(none)'} -> ${pick.raw}`);
    out.focal_number = pick.raw;
    focalFigure = pick;
  }

  // A big number alone tells the reader nothing; the line under it says what
  // it is, in the post's own words, so it can never say something else.
  const caption = focalCaption(body, focalFigure);
  if (caption) out.focal_subline = caption;
  else delete out.focal_subline;

  // Trend tiles (views, posts) come off the wire and stay. A "cited" tile came
  // from someone else's post: it survives only as the draft writes it.
  if (out.stat_tiles) {
    const tiles = [];
    for (const tile of out.stat_tiles) {
      if (tile.label !== 'cited') {
        tiles.push(tile);
        continue;
      }
      const match = draftFigureFor(tile.value, draft);
      if (!match || match.raw.length > CAPS.stat_value) {
        changed.push(`dropped cited tile ${tile.value}: not stated in the draft`);
        continue;
      }
      if (match.raw === out.focal_number) {
        changed.push(`dropped cited tile ${tile.value}: it is now the focal number`);
        continue;
      }
      if (out.focal_subline && figureAppearsIn(match.raw, out.focal_subline)) {
        changed.push(`dropped cited tile ${tile.value}: the line under the focal number already says it`);
        continue;
      }
      if (match.raw !== tile.value) changed.push(`cited tile ${tile.value} -> ${match.raw}`);
      tiles.push({ ...tile, value: match.raw });
    }
    out.stat_tiles = tiles;
  }

  return { ok: true, schema: out, changed };
}
