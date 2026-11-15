import type Database from 'better-sqlite3';
import type { SquareClient } from '../client/square-client.js';
import type { DraftContext, DrawnDraft } from '../pipeline.js';
import { renderNewVisual, type RenderFn } from '../visual/draft-visual.js';
import type { SessionHandlers } from './approval-session.js';
import { publishDraft } from './publisher.js';

/** Rewrites one run may spend on the owner's "v": each costs up to three model calls. */
export const MAX_REWRITES = 2;

export interface HandlerDeps {
  db: Database.Database;
  square: Pick<SquareClient, 'publishPost'> | null;
  publishEnabled: boolean;
  visualDir: string;
  now(): Date;
  /** The context each draft of this run was written from, by draft id. */
  contexts: Map<number, DraftContext>;
  /** Write, record and draw a draft from a context (`draftAndDraw`, bound). */
  draw(context: DraftContext): Promise<DrawnDraft>;
  maxRewrites?: number;
  render?: RenderFn;
}

export function createSessionHandlers(deps: HandlerDeps): SessionHandlers {
  const maxRewrites = deps.maxRewrites ?? MAX_REWRITES;
  let rewrites = 0;

  return {
    async publish(draftId) {
      const out = await publishDraft(
        { db: deps.db, square: deps.square, now: deps.now, enabled: deps.publishEnabled },
        draftId,
      );
      return out.note;
    },

    async rewrite(draftId) {
      const context = deps.contexts.get(draftId);
      if (!context) {
        throw new Error('only the run that wrote this draft can rewrite it. Send d to post it or b to drop it');
      }
      if (rewrites >= maxRewrites) {
        throw new Error(`no rewrites left in this run (limit ${maxRewrites}). Send d to post it or b to drop it`);
      }
      rewrites += 1;

      const drawn = await deps.draw(context);
      if (!drawn.draft.ok) {
        throw new Error(`the new draft failed the gates after ${drawn.draft.attempts.length} attempts`);
      }
      if (!drawn.visual) {
        throw new Error(`the new draft has no card: ${drawn.visualSkipped ?? 'unknown reason'}`);
      }
      deps.contexts.set(drawn.draftId, context);
      return drawn.draftId;
    },

    async newVisual(draftId) {
      const drawn = await renderNewVisual(deps.db, draftId, {
        visualDir: deps.visualDir,
        now: deps.now(),
        render: deps.render,
      });
      if (!drawn.ok) throw new Error(drawn.reason);
    },
  };
}
