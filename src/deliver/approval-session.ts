import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { SquareClient } from '../client/square-client.js';
import { withdrawDraft } from '../compose/compose-draft.js';
import { latestOfferedVisual, latestVisual, markVisualOffered, setVisualImageUrl } from '../visual/draft-visual.js';
import { createLogger } from '../utils/logger.js';
import { APPROVAL_TTL_HOURS, expireStale, statusOf } from './approval-store.js';
import { loadDraftCard } from './draft-card.js';
import { draftCode } from './draft-code.js';
import type { ZaloApi } from './zalo-api.js';
import { pollLoop, sendForApproval, type ApproverDeps } from './zalo-approver.js';

const logger = createLogger('approval-session');

/** Slack after the approval window before the session gives up regardless. */
const DEADLINE_SLACK_MS = 30 * 60_000;

/**
 * One run's wait for the owner's answer.
 *
 * The run that wrote a draft stays alive until that draft is published,
 * rejected or expired, reading commands from the approval chat. Keeping the
 * run alive is what makes "rewrite" cheap: the trend, the top posts, the
 * perspective and the anchor are still in memory, so nothing has to be
 * serialised or collected again. Zalo only delivers messages that arrive while
 * a poll is open, so when no session is running, commands are lost; that is
 * acceptable because with no session running there is no draft to command.
 */

export interface SessionHandlers {
  /** Publish an approved draft. Resolves with a note for the confirmation. */
  publish(draftId: number): Promise<string | void>;
  /**
   * Write, gate and draw a replacement. Resolves with the new draft id, which
   * must be pending and have a card. Throws with the reason otherwise.
   */
  rewrite(draftId: number): Promise<number>;
  /** Draw a different card for the same draft. Throws when there is none. */
  newVisual(draftId: number): Promise<void>;
}

export interface SessionDeps {
  db: Database.Database;
  api: ZaloApi;
  chatId: string;
  now(): Date;
  /** Uploads the card so Zalo can show it and Square can post it. Null: send text only. */
  square: Pick<SquareClient, 'uploadImage'> | null;
  modelFor(tier: string): string;
  publishEnabled: boolean;
  handlers: SessionHandlers;
  /** Abort to stop waiting (SIGINT, SIGTERM). */
  signal: AbortSignal;
  timeoutSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionSummary {
  reason: 'resolved' | 'deadline' | 'aborted';
  drafts: { id: number; code: string; status: string | null }[];
}

async function say(deps: SessionDeps, text: string): Promise<void> {
  try {
    await deps.api.sendMessage(deps.chatId, text);
  } catch (err) {
    logger.warn('Could not send Zalo message', { reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Upload the newest card if it is not on Square yet, then send the draft to
 * the approval chat, and record the card as offered once its image is there:
 * only an offered card can be posted (see `latestOfferedVisual`).
 *
 * A draft's first offer goes out even when the upload fails, marked "no
 * image", so the owner can read it and ask for a card with "a". A new card
 * (`requireImage`) is the whole point of its offer, so a failed upload is
 * reported instead, and the card already in the chat stays the one to post.
 */
export async function offerDraft(
  deps: SessionDeps,
  approver: ApproverDeps,
  draftId: number,
  opts: { requireImage?: boolean } = {},
): Promise<void> {
  const visual = latestVisual(deps.db, draftId);
  if (visual && !visual.imageUrl && visual.pngPath) {
    try {
      if (!deps.square) throw new Error('no Square OpenAPI key is configured');
      const url = await deps.square.uploadImage(fs.readFileSync(visual.pngPath), path.basename(visual.pngPath));
      setVisualImageUrl(deps.db, visual.id, url);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (opts.requireImage) throw new Error(`could not upload the new card: ${reason}`);
      logger.warn('Card upload failed, sending the draft without its image', { draftId, reason });
    }
  }
  const card = loadDraftCard(deps.db, draftId, { modelFor: deps.modelFor });
  await sendForApproval(approver, card, {
    photoSent: () => {
      if (visual) markVisualOffered(deps.db, visual.id, deps.now());
    },
  });
}

export async function runApprovalSession(deps: SessionDeps, draftIds: number[]): Promise<SessionSummary> {
  const active = new Set(draftIds);
  const ttlMs = APPROVAL_TTL_HOURS * 3600_000;
  // A replacement draft gets its own approval window, so a rewrite late in
  // the window pushes the deadline out with it.
  let deadline = deps.now().getTime() + ttlMs + DEADLINE_SLACK_MS;

  const approver: ApproverDeps = {
    api: deps.api,
    db: deps.db,
    chatId: deps.chatId,
    now: deps.now,
    seen: new Set(),
    scope: () => active,
    cardChangedSince: (id, at) => {
      const offeredAt = latestOfferedVisual(deps.db, id)?.offeredAt;
      return offeredAt !== undefined && offeredAt !== null && offeredAt > at.toISOString();
    },
    onPublish: (id) => deps.handlers.publish(id),
    publishBlocked: () =>
      deps.publishEnabled ? null : 'publishing is off for this run (start with --publish to post). The draft stays pending',
    onRewrite: async (id) => {
      const replacement = await deps.handlers.rewrite(id);
      active.add(replacement);
      deadline = Math.max(deadline, deps.now().getTime() + ttlMs + DEADLINE_SLACK_MS);
      try {
        await offerDraft(deps, approver, replacement);
      } catch (err) {
        // Never leave a draft pending that the owner has not seen.
        withdrawDraft(deps.db, replacement, 'not-sent');
        active.delete(replacement);
        throw err;
      }
    },
    onNewVisual: async (id) => {
      await deps.handlers.newVisual(id);
      await offerDraft(deps, approver, id, { requireImage: true });
    },
  };

  if (!deps.publishEnabled) {
    await deps.api.sendMessage(deps.chatId, 'Trial run: publishing is off. "d" will not post; the draft stays pending.');
  }
  for (const id of draftIds) await offerDraft(deps, approver, id);

  let reason: SessionSummary['reason'] = 'resolved';
  const internal = new AbortController();
  const abort = (): void => internal.abort();
  if (deps.signal.aborted) abort();
  else deps.signal.addEventListener('abort', abort, { once: true });

  const onCycle = async (): Promise<boolean> => {
    const now = deps.now();
    for (const id of expireStale(deps.db, now)) {
      if (active.has(id)) await say(deps, `${draftCode(id)} expired after ${APPROVAL_TTL_HOURS} hours, not posted`);
    }
    const waiting = [...active].filter((id) => statusOf(deps.db, id) === 'pending');
    if (waiting.length === 0) return true;
    if (now.getTime() > deadline) {
      reason = 'deadline';
      return true;
    }
    return false;
  };

  try {
    await pollLoop(approver, {
      signal: internal.signal,
      onCycle,
      timeoutSec: deps.timeoutSec,
      sleep: deps.sleep,
    });
  } finally {
    deps.signal.removeEventListener('abort', abort);
  }
  if (deps.signal.aborted) reason = 'aborted';

  // Nothing reads the chat after this, and no later run will act on a draft
  // it did not offer, so a draft still pending here could never be answered.
  const left = [...active].filter((id) => statusOf(deps.db, id) === 'pending');
  for (const id of left) withdrawDraft(deps.db, id, 'session-ended');
  if (left.length > 0) {
    await say(
      deps,
      `Approval session stopped (${reason}). ${left.map((id) => draftCode(id)).join(', ')} withdrawn, not posted.`,
    );
  }
  const drafts = [...active].map((id) => ({ id, code: draftCode(id), status: statusOf(deps.db, id) }));
  logger.info('Approval session ended', { reason, drafts });
  return { reason, drafts };
}
