import type Database from 'better-sqlite3';
import { SquareError, type SquareClient } from '../client/square-client.js';
import { markLensUsed } from '../perspective/lens-store.js';
import { latestOfferedVisual } from '../visual/draft-visual.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('publisher');

/**
 * Publish one approved draft to Binance Square and record what went out.
 *
 * The approver calls this only after the owner's "d" has moved the draft to
 * 'approved', and reverts it to 'pending' when this throws. Every rule below
 * follows from that contract:
 *
 * - Nothing is sent unless the draft is 'approved' and has no post yet. There
 *   is no other path to `publishPost` in the codebase.
 * - Once Square has accepted the post, this never throws. A failure in the
 *   bookkeeping after that point is logged and reported, because a throw would
 *   put a live post back on the queue and the next "d" would post it twice.
 * - When Square's answer leaves it unclear whether the post went out, this
 *   throws `PublishUncertainError`, which the approver must not revert.
 */

export class PublishingDisabledError extends Error {
  constructor() {
    super('publishing is off for this run (start with --publish to post). The draft stays pending');
    this.name = 'PublishingDisabledError';
  }
}

export class PublishUncertainError extends Error {
  readonly uncertain = true;
  constructor(message: string) {
    super(message);
    this.name = 'PublishUncertainError';
  }
}

export interface PublisherDeps {
  db: Database.Database;
  square: Pick<SquareClient, 'publishPost'> | null;
  now(): Date;
  enabled: boolean;
}

export interface PublishOutcome {
  squarePostId: string | null;
  shareLink: string | null;
  /** One line for the approval chat. */
  note: string;
  /** False when the post is live but its posts row could not be written. */
  recorded: boolean;
  publishedAt: string;
  /** Exactly what was posted. */
  body: string;
}

interface DraftForPublish {
  id: number;
  body: string;
  status: string;
  hashtag: string;
  outcome: string;
  sourceRef: string | null;
}

export async function publishDraft(deps: PublisherDeps, draftId: number): Promise<PublishOutcome> {
  if (!deps.enabled) throw new PublishingDisabledError();

  const draft = deps.db
    .prepare(
      `SELECT d.id, d.body, d.status, t.hashtag, s.outcome, s.source_ref AS sourceRef
       FROM drafts d
       JOIN selections s ON s.id = d.selection_id
       JOIN trends t ON t.id = s.trend_id
       WHERE d.id = ?`,
    )
    .get(draftId) as DraftForPublish | undefined;
  if (!draft) throw new Error(`no draft ${draftId}`);
  if (draft.status !== 'approved') {
    throw new Error(`draft ${draftId} is ${draft.status}; only an approved draft is published`);
  }
  const already = deps.db.prepare('SELECT id FROM posts WHERE draft_id = ?').get(draftId);
  if (already) throw new Error(`draft ${draftId} is already published`);

  // The card the owner approved is the newest one that reached the chat.
  const visual = latestOfferedVisual(deps.db, draftId);
  if (!visual?.imageUrl) {
    throw new Error('no card of this draft reached the chat with its image, and there is no post without one. Send a for a new card');
  }
  if (!deps.square) throw new Error('no Square OpenAPI key is configured');

  let result;
  try {
    // The body goes out exactly as approved: no trimming, no normalisation,
    // no hashtag added or removed.
    result = await deps.square.publishPost({ body: draft.body, imageUrls: [visual.imageUrl] });
  } catch (err) {
    if (err instanceof SquareError && err.ambiguous) {
      throw new PublishUncertainError(
        `Square did not answer clearly (${err.message}). The post may be live: check the account before doing anything else`,
      );
    }
    throw err;
  }

  const squarePostId = result.id;
  const shareLink = result.status === 'published' ? result.shareLink : null;
  const note =
    result.status === 'published_without_id'
      ? 'Square answered 504: the post is live but came back without an id'
      : (shareLink ?? `post id ${squarePostId ?? 'unknown'}`);

  const at = deps.now();
  const live = { squarePostId, shareLink, publishedAt: at.toISOString(), body: draft.body };
  try {
    deps.db.transaction(() => {
      deps.db
        .prepare(
          `INSERT INTO posts (draft_id, square_post_id, content_snapshot, hashtag, png_path, share_link, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(draftId, squarePostId, draft.body, draft.hashtag, visual.pngPath, shareLink, at.toISOString());
      // Lens cooldowns count posts, not drafts: a rejected draft must not use
      // the lens up. Angles and bank anchors are marked in the vault by the
      // vault writer, from this same posts row.
      if (draft.outcome === 'lens' && draft.sourceRef) markLensUsed(deps.db, draft.sourceRef, at);
    })();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Published, but the post was not recorded', { draftId, squarePostId, reason });
    return { ...live, recorded: false, note: `${note}. Not recorded in the database: ${reason}` };
  }

  logger.info('Published', { draftId, squarePostId });
  return { ...live, recorded: true, note };
}
