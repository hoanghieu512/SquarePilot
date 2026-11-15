import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DraftContext, DrawnDraft } from '../src/pipeline.js';
import { PublishingDisabledError } from '../src/deliver/publisher.js';
import { createSessionHandlers, type HandlerDeps } from '../src/deliver/session-handlers.js';
import { visualSlug, type RenderFn } from '../src/visual/draft-visual.js';
import { memoryDb, seedDraft, seedVisual } from './helpers/approval-db.js';

const NOW = new Date('2026-11-15T02:00:00.000Z');
const context = { selectionId: 1 } as unknown as DraftContext;

function drawn(over: { ok?: boolean; draftId?: number; visual?: boolean; skipped?: string } = {}): DrawnDraft {
  return {
    draft: { ok: over.ok ?? true, attempts: [{}, {}, {}] } as unknown as DrawnDraft['draft'],
    draftId: over.draftId ?? 99,
    visual: over.visual === false ? undefined : ({ path: '/v/x.png' } as DrawnDraft['visual']),
    visualSkipped: over.skipped,
  };
}

describe('createSessionHandlers', () => {
  let db: Database.Database;
  let draw: ReturnType<typeof vi.fn>;
  const render: RenderFn = async () => ({ png: Buffer.alloc(0), bytes: 10, width: 1080, height: 1350 });

  function handlers(over: Partial<HandlerDeps> = {}) {
    return createSessionHandlers({
      db,
      square: null,
      publishEnabled: false,
      visualDir: '/v',
      now: () => NOW,
      contexts: new Map([[1, context]]),
      draw: draw as unknown as HandlerDeps['draw'],
      render,
      ...over,
    });
  }

  beforeEach(() => {
    db = memoryDb();
    draw = vi.fn(async () => drawn());
  });
  afterEach(() => db.close());

  describe('rewrite', () => {
    it('drafts again from the same context and remembers it for the replacement', async () => {
      const contexts = new Map([[1, context]]);
      const h = handlers({ contexts });

      await expect(h.rewrite(1)).resolves.toBe(99);
      expect(draw).toHaveBeenCalledWith(context);
      expect(contexts.get(99)).toBe(context);
    });

    it('refuses a draft this run did not write', async () => {
      await expect(handlers().rewrite(7)).rejects.toThrow(/only the run that wrote this draft/);
      expect(draw).not.toHaveBeenCalled();
    });

    it('stops after the rewrite budget, counting failed rewrites too', async () => {
      draw.mockResolvedValueOnce(drawn({ ok: false })).mockResolvedValueOnce(drawn({ draftId: 100 }));
      const h = handlers({ maxRewrites: 2 });

      await expect(h.rewrite(1)).rejects.toThrow(/failed the gates after 3 attempts/);
      await expect(h.rewrite(1)).resolves.toBe(100);
      await expect(h.rewrite(100)).rejects.toThrow(/no rewrites left in this run \(limit 2\)/);
      expect(draw).toHaveBeenCalledTimes(2);
    });

    it('refuses a replacement with no card, giving the reason', async () => {
      draw.mockResolvedValueOnce(drawn({ visual: false, skipped: 'the draft has no figure that fits the panel' }));
      await expect(handlers().rewrite(1)).rejects.toThrow(/no card: the draft has no figure that fits the panel/);
    });
  });

  describe('newVisual', () => {
    it('puts each figure of the draft on the card in turn, then says there are no more', async () => {
      const id = seedDraft(db, { body: '#BTCHolds\n\nVolume rose 12% while price held $68k.' });
      seedVisual(db, id);
      const h = handlers();

      await h.newVisual(id);
      const rows = db.prepare('SELECT schema_json, png_path FROM visuals WHERE draft_id = ? ORDER BY id').all(id) as {
        schema_json: string;
        png_path: string;
      }[];
      expect(rows.map((r) => JSON.parse(r.schema_json).focal_number)).toEqual(['12%', '$68k']);
      expect(rows[1]!.png_path).toBe(`/v/2026-11-15-btcholds-d${id}-v2.png`);

      await expect(h.newVisual(id)).rejects.toThrow(/no other figure.*12%, \$68k/);
    });
  });

  describe('publish', () => {
    it('goes through the publisher, so the off switch holds', async () => {
      const id = seedDraft(db, { status: 'approved' });
      seedVisual(db, id);
      await expect(handlers().publish(id)).rejects.toBeInstanceOf(PublishingDisabledError);
    });
  });
});

describe('visualSlug', () => {
  it('keeps only letters, digits and single hyphens', () => {
    expect(visualSlug('#WhatWillDriveCryptoandStocks’NextRebound?')).toBe('whatwilldrivecryptoandstocks-nextrebound');
    expect(visualSlug('#TRUMPBreaksAbove$3.4')).toBe('trumpbreaksabove-3-4');
    expect(visualSlug('#???')).toBe('card');
  });
});
