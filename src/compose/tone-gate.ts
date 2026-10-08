import type { LlmClient, Tier } from '../llm/client.js';
import type { VoiceAssets } from './prompt-assets.js';
import { anchorBrief, type AnchorAssignment } from './anchor.js';

/**
 * Phrases banned outright by Rule E4. Checked in code before spending a call.
 *
 * Deliberately only the unambiguous ones: a substring match cannot judge
 * "robust enough to survive the 2024 depeg", which the rule explicitly allows.
 * The judgement cases go to the model.
 */
export const FORBIDDEN_PHRASES = [
  'in conclusion',
  'furthermore',
  'moreover',
  "it's worth noting",
  'it is important to note',
  'dive into',
  'deep dive',
  "let's explore",
  "let's take a look",
  'game-changer',
  'game changer',
  'revolutionize',
  'paradigm shift',
  'unlock the potential',
  'in the world of crypto',
  "in today's fast-paced",
  'at the end of the day',
  'thanks for reading',
  'hope this helps',
  'the takeaway is',
];

/** Rule E7. A cheap check that catches the tell the VN rules already ban. */
export const BANNED_CHARS: { char: string; name: string }[] = [
  { char: '—', name: 'em-dash' },
  { char: '–', name: 'en-dash' },
];

const CONTRACTION = /\b(?:\w+'(?:s|t|re|ve|ll|d|m))\b/i;

export interface MechanicalFindings {
  forbidden: string[];
  bannedChars: string[];
  hasContraction: boolean;
  shortSentences: number;
  emojiCount: number;
}

const EMOJI = /\p{Extended_Pictographic}/gu;

/**
 * Rules that are literally checkable, run before any model call.
 *
 * A forbidden phrase is a fact about the string. Paying a model to notice it
 * would be slower, cost a free-tier slot, and give a less reliable answer.
 */
export function checkMechanical(draft: string): MechanicalFindings {
  const lower = draft.toLowerCase();
  const sentences = draft
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    forbidden: FORBIDDEN_PHRASES.filter((p) => lower.includes(p)),
    bannedChars: BANNED_CHARS.filter((b) => draft.includes(b.char)).map((b) => b.name),
    hasContraction: CONTRACTION.test(draft),
    shortSentences: sentences.filter((s) => {
      const n = s.split(/\s+/).filter(Boolean).length;
      return n >= 2 && n <= 5;
    }).length,
    emojiCount: (draft.match(EMOJI) ?? []).length,
  };
}

export interface ToneVerdict {
  ok: boolean;
  /** What the drafter must change, phrased as instructions. */
  corrections: string[];
  /** True when a model was asked; false when mechanics alone decided it. */
  usedModel: boolean;
}

function mechanicalCorrections(f: MechanicalFindings): string[] {
  const out: string[] = [];
  if (f.forbidden.length > 0) {
    out.push(`Remove these banned phrases (Rule E4): ${f.forbidden.join(', ')}.`);
  }
  if (f.bannedChars.length > 0) {
    out.push(
      `Remove every ${f.bannedChars.join(' and ')} (Rule E7). Use a comma, a spaced hyphen, or split the sentence.`,
    );
  }
  if (!f.hasContraction) {
    out.push("No contractions found (Rule E1). Use natural forms: it's, that's, doesn't.");
  }
  if (f.shortSentences < 3) {
    out.push(
      `Only ${f.shortSentences} short sentences of 2-5 words (Rule E2 requires 3). Break a long sentence or add a short verdict.`,
    );
  }
  if (f.emojiCount > 2) {
    out.push(`${f.emojiCount} emoji (Rule E8 allows at most 2).`);
  }
  return out;
}

const JUDGE_SYSTEM = `You are checking one English post against a rules file.

Report only violations you can point at in the text. Do not suggest improvements,
do not comment on the argument, do not rewrite anything.

Reply with a JSON object and nothing else:
{"pass": boolean, "violations": ["rule id - what is wrong - the exact offending text"]}

An empty violations array means it passes. Be strict about the rules and silent
about everything else.`;

interface JudgeReply {
  pass?: unknown;
  violations?: unknown;
}

function parseJudge(text: string): { pass: boolean; violations: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as JudgeReply;
    const violations = Array.isArray(raw.violations)
      ? raw.violations.filter((v): v is string => typeof v === 'string')
      : [];
    return { pass: raw.pass === true && violations.length === 0, violations };
  } catch {
    return null;
  }
}

export interface ToneGateOptions {
  llm: LlmClient;
  assets: VoiceAssets;
  tier?: Tier;
  draftId?: number;
  /** The anchor the drafter was given. Without it E5 is judged from the rules alone. */
  anchor?: AnchorAssignment;
}

/**
 * Mechanical checks first, model second.
 *
 * When the mechanical pass already found something, the model is not called at
 * all: the draft is going back for a rewrite either way, and a second opinion
 * on a draft that is already failing costs a free-tier slot for nothing.
 */
export async function runToneGate(draft: string, opts: ToneGateOptions): Promise<ToneVerdict> {
  const mechanical = mechanicalCorrections(checkMechanical(draft));
  if (mechanical.length > 0) {
    return { ok: false, corrections: mechanical, usedModel: false };
  }

  const result = await opts.llm.complete({
    purpose: 'tone-gate',
    tier: opts.tier ?? 'free',
    draftId: opts.draftId,
    temperature: 0,
    system: JUDGE_SYSTEM,
    user:
      `## Rules\n\n${opts.assets.antiAiRules}\n\n` +
      (opts.anchor ? `${anchorBrief(opts.anchor)}\n\n` : '') +
      `## Post to check\n\n${draft}`,
  });

  const parsed = parseJudge(result.text);
  if (!parsed) {
    // An unparseable verdict is not a pass. Treating it as one would make the
    // gate silently optional whenever the judge model has a bad day.
    return {
      ok: false,
      usedModel: true,
      corrections: ['The tone check returned an unreadable verdict. Rewrite and resubmit.'],
    };
  }

  return { ok: parsed.pass, corrections: parsed.violations, usedModel: true };
}
