import { CAPS, type VisualSchema } from './data-gate.js';
import { extractFigures, figureAppearsIn } from './fact-figures.js';

/**
 * Make the card agree with the post it travels with.
 *
 * The data gate picks the focal number from other people's posts before the
 * draft exists, to prove a card can be built at all. On the 2026-11-14 dry run
 * the card's big number appeared nowhere in the post, so a reader saw a figure
 * the author never stated or sourced. After the fact gate, every figure in the
 * draft is backed by the evidence, so the draft is the safe place to take the
 * card's numbers from.
 */

export type AlignResult =
  | { ok: true; schema: Partial<VisualSchema>; changed: string[] }
  | { ok: false; reason: string };

/** Units that make a figure worth the panel, best first. */
const FOCAL_PREFERENCE = ['percent', 'currency', 'multiple', 'bps', 'plain'] as const;

export function alignVisualToDraft(
  schema: Partial<VisualSchema>,
  body: string,
  opts: { currentYear: number },
): AlignResult {
  const changed: string[] = [];
  const out: Partial<VisualSchema> = { ...schema };

  if (!out.focal_number || !figureAppearsIn(out.focal_number, body)) {
    const candidates = extractFigures(body, { currentYear: opts.currentYear })
      .filter((f) => f.raw.length <= CAPS.focal_number)
      .sort((a, b) => FOCAL_PREFERENCE.indexOf(a.unit) - FOCAL_PREFERENCE.indexOf(b.unit) || a.index - b.index);
    const pick = candidates[0];
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
  // from someone else's post and survives only if the draft states it too.
  if (out.stat_tiles) {
    const kept = out.stat_tiles.filter((t) => t.label !== 'cited' || figureAppearsIn(t.value, body));
    if (kept.length !== out.stat_tiles.length) {
      changed.push(`dropped ${out.stat_tiles.length - kept.length} cited tile(s) not stated in the draft`);
      out.stat_tiles = kept;
    }
  }

  return { ok: true, schema: out, changed };
}
