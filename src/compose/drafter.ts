import type { Trend } from '../collect/parse-trends.js';
import type { HashtagPost } from '../collect/hashtag-reader.js';
import type { Perspective } from '../perspective/types.js';
import type { ModeSpec } from './modes.js';
import { constraintsAsInstructions } from './modes.js';
import type { VoiceAssets } from './prompt-assets.js';
import { anchorInstructions, type AnchorAssignment } from './anchor.js';
import { DISCLAIMER, TARGET_NFC } from './text-validation.js';
import { cashtagInstructions } from './cashtags.js';
import { groupDigits } from '../utils/numbers.js';

export interface DraftRequest {
  trend: Trend;
  perspective: Perspective;
  mode: ModeSpec;
  topPosts: HashtagPost[];
  assets: VoiceAssets;
  /** Decided by the pipeline before drafting; see `resolveAnchor`. */
  anchor: AnchorAssignment;
  /** Feedback from a failed gate, fed back on a rewrite. */
  corrections?: string[];
}

const SYSTEM = `You write short posts for Binance Square as one specific person.

Three files define that person and they are authoritative. Where this prompt and
those files disagree, the files win.

You are not deciding what to think about the topic. The point of view is given to
you below and your job is to express it. Do not substitute your own take, and do
not hedge the given one into neutrality.

Write English. Output the post body only: no title, no preamble, no sign-off, no
markdown headings, no commentary about what you wrote.`;

/**
 * Build the prompt.
 *
 * Ordering follows the layer stack in Content-Creator/CLAUDE.md: identity, then
 * voice, then the task, with the pass/fail rules last. That file notes the
 * choice is deliberate - the hardest constraints sit closest to the point where
 * text is generated, where they carry the most weight.
 */
export function buildPrompt(req: DraftRequest): string {
  const { trend, perspective, mode, topPosts, assets } = req;

  const parts: string[] = [];

  parts.push('## Layer 0 - Who is writing\n\n' + assets.aboutMe);
  parts.push('## Layer 1 - Voice\n\n' + assets.toneGuidelines);

  parts.push(
    '## Layer 2 - Today\n\n' +
      `Trending hashtag: ${trend.hashtag}\n` +
      `Attention: ${groupDigits(trend.viewCount)} views across ${groupDigits(trend.contentCount)} posts.\n\n` +
      `### The point of view you are writing from (${perspective.kind})\n\n` +
      `${perspective.summary}\n\n` +
      '### Evidence. Use it. Do not add facts beyond it.\n\n' +
      perspective.evidence.map((e) => `- ${e}`).join('\n'),
  );

  if (perspective.guardrails.length > 0) {
    parts.push(
      '### Hard limits carried from the source. Breaking one fails the post.\n\n' +
        perspective.guardrails.map((g) => `- ${g}`).join('\n'),
    );
  }

  if (topPosts.length > 0) {
    parts.push(
      '### What is already written under this hashtag\n\n' +
        'Do not repeat these angles. This is context for what to avoid, not material to reuse.\n\n' +
        topPosts
          .slice(0, 5)
          .map((p) => `- ${p.text.replace(/\s+/g, ' ').slice(0, 180)}`)
          .join('\n'),
    );
  }

  parts.push(anchorInstructions(req.anchor));

  parts.push('### Form\n\n' + constraintsAsInstructions(mode).map((c) => `- ${c}`).join('\n'));

  parts.push(cashtagInstructions(trend.hashtag));

  // 2026-11-15 trial runs: drafts that passed tone, shape and persona failed
  // the fact gate on background the model knew but the evidence did not hold
  // (rate odds, the dollar, a news outlet), on counts of its own "reading",
  // and on a gap it worked out between two figures.
  parts.push(
    '### Facts: what you may state\n\n' +
      'A separate check compares every figure and every claim in the post with the evidence and the anchor above, and rejects the post if one is not there.\n\n' +
      '- State as fact only what the evidence says. Background you know about the topic (rate expectations, the dollar, fund flows, what a news outlet reported) is not in the evidence, so leave it out, even when it is true.\n' +
      '- An evidence line that starts "A top post states" is someone else\'s claim. Keep it theirs: one top post says ..., with its numbers.\n' +
      '- No counts of your own reading or checking ("I went through 11 posts") unless the evidence or the anchor gives that count.\n' +
      '- Copy figures as the evidence writes them. A difference between two figures in the same evidence line is fine (6.6% expected, 6.5% printed: a 0.1 point miss). No other arithmetic, no estimates, no figures from memory.\n' +
      '- Write numbers of four or more digits with thousands separators, as the evidence does: 283,050 views, 2,344 posts.',
  );

  parts.push(
    '### Length\n\n' +
      `- Around ${TARGET_NFC} characters. Shorter is better than padded.\n` +
      `- Do not include the hashtag; it is prepended afterwards and its length is already reserved.\n` +
      `- Do not write a disclaimer; "${DISCLAIMER}" is appended afterwards, also within the reserved length.`,
  );

  if (req.corrections?.length) {
    parts.push(
      '### Your previous attempt was rejected. Fix exactly this.\n\n' +
        req.corrections.map((c) => `- ${c}`).join('\n') +
        '\n\nDo not work around the objection by rephrasing. Change what it names.',
    );
  }

  parts.push('## Layer 3 - Pass/fail rules, read last\n\n' + assets.antiAiRules);

  return parts.join('\n\n---\n\n');
}

export { SYSTEM as DRAFTER_SYSTEM };
