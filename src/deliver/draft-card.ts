import type Database from 'better-sqlite3';
import { latestVisual } from '../visual/draft-visual.js';
import type { DraftCard } from './zalo-approver.js';

/**
 * The approval card for a draft, built from the database alone, so a new
 * visual or a draft left by an earlier run shows exactly what was recorded.
 */

interface CardRow {
  id: number;
  body: string;
  nfc_len: number;
  nfd_len: number;
  tone_gate: string | null;
  shape_gate: string | null;
  persona_gate: string | null;
  fact_gate: string | null;
  model_used: string;
  escalated: number;
  anchor_tier: string | null;
  anchor_ref: string | null;
  outcome: string;
  source_ref: string | null;
  perspective_summary: string | null;
  mode: string | null;
  hashtag: string;
}

/** 'pass', 'fail' or 'fail: <corrections>' down to its verdict. */
function verdict(column: string | null): string {
  if (!column) return 'n/a';
  return column.split(':')[0]!.trim();
}

export function loadDraftCard(
  db: Database.Database,
  draftId: number,
  opts: { modelFor(tier: string): string },
): DraftCard {
  const r = db
    .prepare(
      `SELECT d.id, d.body, d.nfc_len, d.nfd_len, d.tone_gate, d.shape_gate, d.persona_gate,
              d.fact_gate, d.model_used, d.escalated, d.anchor_tier, d.anchor_ref,
              s.outcome, s.source_ref, s.perspective_summary, s.mode, t.hashtag
       FROM drafts d
       JOIN selections s ON s.id = d.selection_id
       JOIN trends t ON t.id = s.trend_id
       WHERE d.id = ?`,
    )
    .get(draftId) as CardRow | undefined;
  if (!r) throw new Error(`no draft ${draftId}`);

  return {
    draftId: r.id,
    hashtag: r.hashtag,
    body: r.body,
    nfc: r.nfc_len,
    nfd: r.nfd_len,
    perspective: { kind: r.outcome, summary: r.perspective_summary ?? r.source_ref ?? '' },
    mode: r.mode ?? 'n/a',
    model: opts.modelFor(r.model_used),
    escalated: r.escalated === 1,
    gates: {
      tone: verdict(r.tone_gate),
      shape: verdict(r.shape_gate),
      persona: verdict(r.persona_gate),
      facts: verdict(r.fact_gate),
    },
    anchor: { tier: r.anchor_tier, ref: r.anchor_ref },
    photoUrl: latestVisual(db, draftId)?.imageUrl ?? null,
  };
}
