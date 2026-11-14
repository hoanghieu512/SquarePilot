import { CAPS, type VisualSchema } from './data-gate.js';
import { extractFigures, isSupported, type Figure } from './fact-figures.js';

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

export function alignVisualToDraft(
  schema: Partial<VisualSchema>,
  body: string,
  opts: { currentYear: number },
): AlignResult {
  const changed: string[] = [];
  const out: Partial<VisualSchema> = { ...schema };
  const draft = extractFigures(body, { currentYear: opts.currentYear });

  const focalMatch = out.focal_number ? draftFigureFor(out.focal_number, draft) : undefined;
  if (focalMatch && focalMatch.raw.length <= CAPS.focal_number) {
    if (focalMatch.raw !== out.focal_number) {
      changed.push(`focal_number ${out.focal_number} -> ${focalMatch.raw}`);
      out.focal_number = focalMatch.raw;
    }
  } else {
    const pick = draft
      .filter((f) => f.raw.length <= CAPS.focal_number)
      .sort((a, b) => FOCAL_PREFERENCE.indexOf(a.unit) - FOCAL_PREFERENCE.indexOf(b.unit) || a.index - b.index)[0];
    if (!pick) {
      return {
        ok: false,
        reason: `focal number ${out.focal_number ?? '(none)'} is not in the draft and the draft has no figure that fits the panel`,
      };
    }
    changed.push(`focal_number ${out.focal_number ?? '(none)'} -> ${pick.raw}`);
    out.focal_number = pick.raw;
  }

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
      if (match.raw !== tile.value) changed.push(`cited tile ${tile.value} -> ${match.raw}`);
      tiles.push({ ...tile, value: match.raw });
    }
    out.stat_tiles = tiles;
  }

  return { ok: true, schema: out, changed };
}
