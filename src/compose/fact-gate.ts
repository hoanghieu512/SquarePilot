import type { LlmClient, Tier } from '../llm/client.js';
import type { DraftRequest } from './drafter.js';
import { checkFigures } from './fact-figures.js';
import { hashtagToHeadline } from './data-gate.js';

/**
 * Does the draft state anything its sources do not?
 *
 * Found on the 2026-11-14 dry run: the tone, shape and persona gates all passed
 * a draft that said a level "has held every cycle since 2015" (false) and
 * quoted a 70% figure nobody supplied. None of those gates looks at facts, so
 * nothing stopped it.
 *
 * Two layers, cheapest first, like the tone gate:
 * 1. Every figure in the draft must be found in the sources (code, see
 *    `fact-figures.ts`). A number is either there or it is not.
 * 2. Only when the figures pass, a judge looks for claims without numbers
 *    ("since March", "every cycle", "the SEC approved") and for other people's
 *    figures stated as fact.
 */

export interface FactSources {
  hashtag: string;
  /** The attention line the drafter was shown. */
  trendLine: string;
  /** The given point of view. */
  summary: string;
  evidence: string[];
  guardrails: string[];
  /** First-person material the anchor allows. */
  anchorMaterial: string[];
}

/** Exactly what the drafter was shown as material, and nothing it was told to avoid. */
export function factSourcesFrom(req: DraftRequest): FactSources {
  return {
    hashtag: req.trend.hashtag,
    trendLine: `${req.trend.viewCount} views across ${req.trend.contentCount} posts.`,
    summary: req.perspective.summary,
    evidence: req.perspective.evidence,
    guardrails: req.perspective.guardrails,
    anchorMaterial: req.anchor.material,
  };
}

function sourceTexts(s: FactSources): string[] {
  return [
    hashtagToHeadline(s.hashtag),
    s.trendLine,
    s.summary,
    ...s.evidence,
    ...s.guardrails,
    ...s.anchorMaterial,
  ];
}

const JUDGE_SYSTEM = `You check one English post for factual claims that its sources do not support.

You get the sources the writer was given and the post. A claim is a statement
presented as fact about the world: an event, a date or month, a record or a
streak ("has held every cycle"), what a person, company, regulator or market
did, or a cause stated as certain. Report a claim when the sources do not
state it.

Never report:
- opinion, interpretation, judgement, questions, hypotheticals, or predictions
  phrased as predictions;
- the point of view the writer was told to take;
- mechanics any market reader knows without a source (crypto trades through
  the weekend, stock exchanges close at night, settlement takes time);
- whether a number matches its source: numbers are checked separately.

Source lines that begin with "A top post states" are other people's claims,
not facts. The post may repeat one only as a claim ("a widely shared post puts
it at ..."). Report the post when it states such a claim as established fact.

Reply with a JSON object and nothing else:
{"pass": boolean, "violations": ["the exact claim from the post - what the sources do or do not say"]}

An empty violations array means it passes.`;

function buildJudgePrompt(draft: string, s: FactSources): string {
  const lines = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- (none)');
  return [
    '## Sources',
    `Trending hashtag: ${s.hashtag}`,
    `Attention: ${s.trendLine}`,
    `Point of view (not a claim to check): ${s.summary}`,
    '',
    '### Evidence',
    lines(s.evidence),
    '',
    '### Limits carried from the source',
    lines(s.guardrails),
    '',
    "### The writer's own material",
    lines(s.anchorMaterial),
    '',
    '## Post to check',
    '',
    draft,
  ].join('\n');
}

function parseVerdict(text: string): { pass: boolean; violations: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as { pass?: unknown; violations?: unknown };
    const violations = Array.isArray(raw.violations)
      ? raw.violations.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    return { pass: raw.pass === true && violations.length === 0, violations };
  } catch {
    return null;
  }
}

export interface FactVerdict {
  ok: boolean;
  corrections: string[];
  /** Raw figures that no source supports, in text order. */
  unsupportedFigures: string[];
  usedModel: boolean;
}

export interface FactGateOptions {
  llm: LlmClient;
  tier?: Tier;
  draftId?: number;
  /** A bare mention of this year needs no source. */
  currentYear: number;
  /** False skips the judge call; the figure check always runs. */
  judge?: boolean;
}

export async function runFactGate(
  draft: string,
  sources: FactSources,
  opts: FactGateOptions,
): Promise<FactVerdict> {
  const figures = checkFigures(draft, sourceTexts(sources), { currentYear: opts.currentYear });
  const unsupportedFigures = figures.unsupported.map((f) => f.raw);
  if (!figures.ok) {
    return { ok: false, corrections: figures.corrections, unsupportedFigures, usedModel: false };
  }
  if (opts.judge === false) {
    return { ok: true, corrections: [], unsupportedFigures, usedModel: false };
  }

  const result = await opts.llm.complete({
    purpose: 'fact-gate',
    tier: opts.tier ?? 'free',
    draftId: opts.draftId,
    temperature: 0,
    system: JUDGE_SYSTEM,
    user: buildJudgePrompt(draft, sources),
  });

  const parsed = parseVerdict(result.text);
  if (!parsed) {
    // Same stance as the tone gate: an unreadable verdict is not a pass.
    return {
      ok: false,
      corrections: ['The fact check returned an unreadable verdict. Rewrite and resubmit.'],
      unsupportedFigures,
      usedModel: true,
    };
  }

  return {
    ok: parsed.pass,
    corrections: parsed.violations.map(
      (v) => `Unsupported claim: ${v}. Remove it, or say only what the evidence states.`,
    ),
    unsupportedFigures,
    usedModel: true,
  };
}
