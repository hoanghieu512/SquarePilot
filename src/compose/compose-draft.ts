import type Database from 'better-sqlite3';
import type { LlmClient, Tier } from '../llm/client.js';
import { DRAFTER_SYSTEM, buildPrompt, type DraftRequest } from './drafter.js';
import { runToneGate } from './tone-gate.js';
import { checkShape } from './shape-scorer.js';
import { checkPersona, recentPostBodies } from './persona-guard.js';
import { composePost, type Lengths } from './text-validation.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('compose');

export interface ComposeOptions {
  llm: LlmClient;
  db?: Database.Database;
  /** Published bodies, newest first. Used by the shape and persona gates. */
  recentPosts?: string[];
  /** Attempts before giving up. Attempt 2 onward escalates to the paid model. */
  maxAttempts?: number;
}

export interface GateOutcome {
  attempt: number;
  tier: Tier;
  toneOk: boolean;
  shapeOk: boolean;
  personaOk: boolean;
  corrections: string[];
}

export interface ComposeOutcome {
  ok: boolean;
  body: string;
  lengths: Lengths;
  tier: Tier;
  attempts: GateOutcome[];
  escalated: boolean;
}

/**
 * Draft, then hold it against three gates, then rewrite with what failed.
 *
 * The gates answer different questions and none subsumes another. Tone asks
 * whether it sounds like the author; shape asks whether it is built like the
 * last few posts; persona asks whether it leans on the job title again. A draft
 * can pass any two and still be wrong.
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
  const recent = opts.recentPosts ?? (opts.db ? recentPostBodies(opts.db) : []);

  const attempts: GateOutcome[] = [];
  let corrections: string[] = [];
  let lastBody = '';
  let lastLengths: Lengths = { nfc: 0, nfd: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Free first. The point of the project is to find out whether it suffices,
    // so paying on attempt one would destroy the measurement.
    const tier: Tier = attempt === 1 ? 'free' : 'paid';

    const result = await opts.llm.complete({
      purpose: 'draft',
      tier,
      temperature: 0.85,
      system: DRAFTER_SYSTEM,
      user: buildPrompt({ ...req, corrections }),
    });

    const composed = composePost(result.text.trim(), req.trend.hashtag);
    lastBody = composed.body;
    lastLengths = composed.lengths;

    const tone = await runToneGate(composed.body, {
      llm: opts.llm,
      assets: req.assets,
      tier: 'free',
    });
    const shape = checkShape(composed.body, recent);
    const persona = checkPersona(composed.body, recent);

    const next = [
      ...tone.corrections,
      ...(shape.ok ? [] : [shape.reason!, ...shape.constraints]),
      ...(persona.ok ? [] : [persona.reason!]),
    ];

    attempts.push({
      attempt,
      tier,
      toneOk: tone.ok,
      shapeOk: shape.ok,
      personaOk: persona.ok,
      corrections: next,
    });

    if (tone.ok && shape.ok && persona.ok) {
      logger.info(`Draft passed on attempt ${attempt} (${tier})`);
      return {
        ok: true,
        body: composed.body,
        lengths: composed.lengths,
        tier,
        attempts,
        escalated: attempt > 1,
      };
    }

    logger.warn(`Attempt ${attempt} (${tier}) failed ${next.length} check(s)`, {
      tone: tone.ok,
      shape: shape.ok,
      persona: persona.ok,
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
         (selection_id, body, nfc_len, nfd_len, shape_vector, tone_gate, shape_gate,
          model_used, escalated, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      selectionId,
      outcome.body,
      outcome.lengths.nfc,
      outcome.lengths.nfd,
      shapeVector,
      last?.toneOk ? 'pass' : `fail: ${last?.corrections.join(' | ') ?? 'unknown'}`,
      last?.shapeOk ? 'pass' : 'fail',
      outcome.tier,
      outcome.escalated ? 1 : 0,
      new Date().toISOString(),
    );
  return Number(info.lastInsertRowid);
}
