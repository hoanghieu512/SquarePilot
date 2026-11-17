import type { PipelineResult } from '../pipeline.js';
import type { Rejection } from '../perspective/types.js';

/**
 * The message a scheduled run sends when it ends without a post.
 *
 * A run that ends silently looks exactly like a run that never happened, so
 * every quiet run says why, rung by rung: which trends were skipped before
 * the ladder, where each candidate stopped, and how a draft failed if one
 * was written. Plain text, well under Zalo's 2,000 characters.
 */

const MAX_TAG = 48;
const MAX_MESSAGE = 1800;

function tag(hashtag: string): string {
  return hashtag.length > MAX_TAG ? `${hashtag.slice(0, MAX_TAG - 1)}…` : hashtag;
}

/** Where the perspective ladder stopped, in a few words per rung. */
export function explainStop(rejected: Rejection[]): string {
  const parts: string[] = [];

  const angles = rejected.filter((r) => r.rung === 'angle');
  if (angles.length > 0) {
    parts.push(angles.every((r) => /^status is/.test(r.reason)) ? 'all angles used' : 'no angle fits');
  }

  const lenses = rejected.filter((r) => r.rung === 'lens');
  if (lenses.length > 0) {
    const noEvidence = lenses.filter((r) => /^no evidence/.test(r.reason)).map((r) => r.candidate);
    const cooling = lenses.filter((r) => /cooldown/.test(r.reason)).map((r) => r.candidate);
    if (noEvidence.length > 0) parts.push(`lens without evidence: ${noEvidence.join(', ')}`);
    if (cooling.length > 0) parts.push(`lens cooling down: ${cooling.join(', ')}`);
    if (noEvidence.length === 0 && cooling.length === 0) parts.push('no lens covers it');
    else if (lenses.some((r) => /does not cover/.test(r.reason))) parts.push('other lenses do not cover it');
  }

  if (rejected.some((r) => r.rung === 'tension')) parts.push('no tension about it');
  return parts.join(', ') || 'nothing to write from';
}

function lastFailedGates(result: PipelineResult): string {
  const last = result.draft?.attempts[result.draft.attempts.length - 1];
  if (!last) return 'no attempt recorded';
  if (last.truncated) return 'the model ran out of tokens';
  const failed = [
    !last.toneOk && 'tone',
    !last.shapeOk && 'shape',
    !last.personaOk && 'persona',
    !last.factsOk && 'facts',
  ].filter(Boolean);
  return failed.length > 0 ? `last failed: ${failed.join(', ')}` : 'gates passed';
}

export function noPostReport(result: PipelineResult, at: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
  const lines = [`SquarePilot ${time}: no post this run.`];

  if (result.trends) {
    const { all, eligible, rejected } = result.trends;
    const reasons = new Map<string, number>();
    for (const r of rejected) {
      const key = /views/.test(r.reason)
        ? 'too few views'
        : /already posted/.test(r.reason)
          ? 'posted recently'
          : /spaces/.test(r.reason)
            ? 'hashtag with spaces'
            : r.reason;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    const skipped = [...reasons].map(([reason, n]) => `${n} ${reason}`).join('; ');
    lines.push(`${all} trends, ${eligible} eligible${skipped ? ` (skipped: ${skipped})` : ''}.`);
  }

  for (const c of result.candidates) {
    if (c.selection.outcome === 'stop') {
      lines.push(`- ${tag(c.trend.hashtag)}: no perspective (${explainStop(c.selection.rejected)})`);
    } else if (c.dataGate && !c.dataGate.ok) {
      lines.push(`- ${tag(c.trend.hashtag)}: ${c.selection.outcome}, but no card (${c.dataGate.reason})`);
    } else if (c === result.chosen && result.draft && !result.draft.ok) {
      lines.push(
        `- ${tag(c.trend.hashtag)}: draft failed its gates after ${result.draft.attempts.length} attempts (${lastFailedGates(result)})`,
      );
    } else if (c === result.chosen && result.visualSkipped) {
      lines.push(`- ${tag(c.trend.hashtag)}: draft passed but has no card (${result.visualSkipped})`);
    } else if (c === result.chosen) {
      lines.push(`- ${tag(c.trend.hashtag)}: chosen (${c.selection.outcome}), no draft written`);
    } else {
      lines.push(`- ${tag(c.trend.hashtag)}: ${c.selection.outcome}, not reached`);
    }
  }
  if (result.candidates.length === 0) lines.push('No eligible trend to try.');

  const text = lines.join('\n');
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}
