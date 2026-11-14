import type Database from 'better-sqlite3';
import { LlmError, type LlmClient, type Tier } from '../llm/client.js';
import { DRAFTER_SYSTEM, buildPrompt, type DraftRequest } from './drafter.js';
import { runToneGate } from './tone-gate.js';
import { checkShape } from './shape-scorer.js';
import { checkPersona } from './persona-guard.js';
import type { RecentPost } from './recent-posts.js';
import type { AnchorAssignment, AnchorTier } from './anchor.js';
import { composePost, type Lengths } from './text-validation.js';
import { normalizeCashtags } from './cashtags.js';
import { factSourcesFrom, runFactGate } from './fact-gate.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('compose');

export interface ComposeOptions {
  llm: LlmClient;
  /**
   * The account's recent posts, newest first, from the vault and the database
   * (see `readRecentPosts`). Used by the shape and persona gates.
   */
  recent?: RecentPost[];
  /** Attempts before giving up. Attempt 2 onward escalates to the paid model. */
  maxAttempts?: number;
  /** Clock for the fact gate's current-year allowance. */
  now?: () => Date;
}

export interface GateOutcome {
  attempt: number;
  tier: Tier;
  toneOk: boolean;
  shapeOk: boolean;
  personaOk: boolean;
  /** Figures and claims are backed by the sources (see `fact-gate.ts`). */
  factsOk: boolean;
  /** Set when the drafter call hit the token limit; no gate ran for this attempt. */
  truncated?: true;
  corrections: string[];
}

export const TRUNCATED_CORRECTION =
  'Your previous output ran past the length budget and was cut off. Output the post body only, with no analysis, no self-check, no alternatives and no commentary.';

export interface ComposeOutcome {
  ok: boolean;
  body: string;
  lengths: Lengths;
  tier: Tier;
  attempts: GateOutcome[];
  escalated: boolean;
  anchor: AnchorAssignment;
}

/**
 * Draft, then hold it against four gates, then rewrite with what failed.
 *
 * The gates answer different questions and none subsumes another. Tone asks
 * whether it sounds like the author; shape asks whether it is built like the
 * last few posts; persona asks whether it leans on the job title again; facts
 * asks whether every figure and claim comes from the sources. A draft can pass
 * any three and still be wrong.
 *
 * Corrections are fed back verbatim. Telling a model to "try again" reproduces
 * the same draft; telling it "seven paragraphs, move the judgement to the end,
 * drop the phrase X" changes something.
 */
export async function composeDraft(
  req: DraftRequest,
  opts: ComposeOptions,
): Promise<ComposeOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const recent = opts.recent ?? [];
  const recentShapes = recent.map((p) => p.shapeText).filter((t) => t.trim().length > 0);
  const recentPersona = recent.map((p) => p.personaText);

  const attempts: GateOutcome[] = [];
  let corrections: string[] = [];
  let lastBody = '';
  let lastLengths: Lengths = { nfc: 0, nfd: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Free first. The point of the project is to find out whether it suffices,
    // so paying on attempt one would destroy the measurement.
    const tier: Tier = attempt === 1 ? 'free' : 'paid';

    let result;
    try {
      result = await opts.llm.complete({
        purpose: 'draft',
        tier,
        temperature: 0.85,
        system: DRAFTER_SYSTEM,
        user: buildPrompt({ ...req, corrections }),
      });
    } catch (err) {
      if (!(err instanceof LlmError) || !err.truncated) throw err;
      attempts.push({
        attempt,
        tier,
        toneOk: false,
        shapeOk: false,
        personaOk: false,
        factsOk: false,
        truncated: true,
        corrections: [TRUNCATED_CORRECTION],
      });
      logger.warn(`Attempt ${attempt} (${tier}) was truncated by the token limit`);
      corrections = [TRUNCATED_CORRECTION];
      continue;
    }

    const tagged = normalizeCashtags(result.text.trim(), {
      hashtag: req.trend.hashtag,
      grounding: [req.perspective.summary, ...req.perspective.evidence, ...req.perspective.guardrails],
    });
    if (tagged.removed.length > 0 || tagged.added.length > 0) {
      logger.info('Cashtags adjusted', { removed: tagged.removed, added: tagged.added });
    }

    const composed = composePost(tagged.text, req.trend.hashtag);
    lastBody = composed.body;
    lastLengths = composed.lengths;

    const tone = await runToneGate(composed.body, {
      llm: opts.llm,
      assets: req.assets,
      tier: 'free',
      anchor: req.anchor,
    });
    const shape = checkShape(composed.body, recentShapes);
    const persona = checkPersona(composed.body, recentPersona);
    // The figure check is code and always runs. The claim judge costs a call,
    // so like the tone judge it is skipped when the draft is going back anyway.
    const facts = await runFactGate(composed.body, factSourcesFrom(req), {
      llm: opts.llm,
      tier: 'free',
      currentYear: (opts.now?.() ?? new Date()).getUTCFullYear(),
      judge: tone.ok && shape.ok && persona.ok,
    });

    const next = [
      ...tone.corrections,
      ...(shape.ok ? [] : [shape.reason!, ...shape.constraints]),
      ...(persona.ok ? [] : [persona.reason!]),
      ...facts.corrections,
    ];

    attempts.push({
      attempt,
      tier,
      toneOk: tone.ok,
      shapeOk: shape.ok,
      personaOk: persona.ok,
      factsOk: facts.ok,
      corrections: next,
    });

    if (tone.ok && shape.ok && persona.ok && facts.ok) {
      logger.info(`Draft passed on attempt ${attempt} (${tier})`);
      return {
        ok: true,
        body: composed.body,
        lengths: composed.lengths,
        tier,
        attempts,
        escalated: attempt > 1,
        anchor: req.anchor,
      };
    }

    logger.warn(`Attempt ${attempt} (${tier}) failed ${next.length} check(s)`, {
      tone: tone.ok,
      shape: shape.ok,
      persona: persona.ok,
      facts: facts.ok,
    });
    corrections = next;
  }

  return {
    ok: false,
    body: lastBody,
    lengths: lastLengths,
    tier: 'paid',
    attempts,
    escalated: maxAttempts > 1,
    anchor: req.anchor,
  };
}

export function recordDraft(
  db: Database.Database,
  selectionId: number,
  outcome: ComposeOutcome,
  shapeVector: string | null = null,
): number {
  const last = outcome.attempts[outcome.attempts.length - 1];
  const info = db
    .prepare(
      `INSERT INTO drafts
         (selection_id, body, nfc_len, nfd_len, shape_vector, tone_gate, shape_gate, persona_gate,
          fact_gate, anchor_tier, anchor_ref, attempts_json, model_used, escalated, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      selectionId,
      outcome.body,
      outcome.lengths.nfc,
      outcome.lengths.nfd,
      shapeVector,
      last?.toneOk ? 'pass' : `fail: ${last?.corrections.join(' | ') ?? 'unknown'}`,
      last?.shapeOk ? 'pass' : 'fail',
      last?.personaOk ? 'pass' : 'fail',
      last?.factsOk ? 'pass' : 'fail',
      outcome.anchor.tier,
      outcome.anchor.ref,
      JSON.stringify(outcome.attempts),
      outcome.tier,
      outcome.escalated ? 1 : 0,
      new Date().toISOString(),
    );
  return Number(info.lastInsertRowid);
}

/** Anchor tiers of the most recently published posts, newest first. */
export function recentAnchorTiers(db: Database.Database, limit = 10): (AnchorTier | null)[] {
  const rows = db
    .prepare(
      `SELECT d.anchor_tier AS tier FROM posts p JOIN drafts d ON d.id = p.draft_id
       ORDER BY p.published_at DESC LIMIT ?`,
    )
    .all(limit) as { tier: AnchorTier | null }[];
  return rows.map((r) => r.tier);
}
