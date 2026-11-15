import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { DraftContext, DrawnDraft } from '../src/pipeline.js';
import { PublishingDisabledError } from '../src/deliver/publisher.js';
import { createSessionHandlers, type HandlerDeps } from '../src/deliver/session-handlers.js';
import { renderDraftVisual, visualSlug, type RenderFn } from '../src/visual/draft-visual.js';
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

      // The session uploads and offers the new card before the next request.
      db.prepare(`UPDATE visuals SET image_url = 'https://x/v2.png', offered_at = ? WHERE draft_id = ?`).run(
        NOW.toISOString(),
        id,
      );
      await expect(h.newVisual(id)).rejects.toThrow(/no other figure.*12%, \$68k/);
    });
  });

  it('counts only cards that reached the chat as shown, so a failed upload can be drawn again', async () => {
    const id = seedDraft(db, { body: '#BTCHolds\n\nVolume rose 12% on the week.' });
    // The first card's upload failed, so the chat got the draft as "(no image)".
    seedVisual(db, id, { imageUrl: null, pngPath: '/v/first.png' });

    await handlers().newVisual(id);

    const focals = db.prepare('SELECT schema_json FROM visuals WHERE draft_id = ? ORDER BY id').all(id) as {
      schema_json: string;
    }[];
    expect(focals.map((r) => JSON.parse(r.schema_json).focal_number)).toEqual(['12%', '12%']);
  });

  describe('publish', () => {
    const square = {
      publishPost: vi.fn(async () => ({ status: 'published' as const, id: '991', shareLink: 'https://sq/p/991' })),
    };

    it('copies the live post into the vault and says where', async () => {
      const vaultDir = mkdtempSync(join(tmpdir(), 'sp-hvault-'));
      mkdirSync(join(vaultDir, 'outputs', 'square'), { recursive: true });
      const png = join(vaultDir, 'card.png');
      writeFileSync(png, 'png');
      const id = seedDraft(db, { status: 'approved' });
      seedVisual(db, id, { pngPath: png });

      const note = await handlers({ square, publishEnabled: true, vaultDir }).publish(id);

      expect(note).toBe('https://sq/p/991\nvault: 2026-11-15-btc-holds-square-post.md');
      expect(existsSync(join(vaultDir, 'outputs', 'square', '2026-11-15-btc-holds-square-post.md'))).toBe(true);
    });

    it('reports a failed vault copy without throwing, because the post is already live', async () => {
      const vaultDir = join(mkdtempSync(join(tmpdir(), 'sp-hvault-')), 'file-not-dir');
      writeFileSync(vaultDir, 'x');
      const id = seedDraft(db, { status: 'approved' });
      seedVisual(db, id);

      const note = await handlers({ square, publishEnabled: true, vaultDir }).publish(id);

      expect(note).toMatch(/^https:\/\/sq\/p\/991\nvault copy failed: /);
      expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get()).toEqual({ n: 1 });
    });

    it('goes through the publisher, so the off switch holds', async () => {
      const id = seedDraft(db, { status: 'approved' });
      seedVisual(db, id);
      await expect(handlers().publish(id)).rejects.toBeInstanceOf(PublishingDisabledError);
    });
  });
});

describe('renderDraftVisual', () => {
  it('turns a rendering fault into a refusal and records no card', async () => {
    const db = memoryDb();
    const id = seedDraft(db);
    const r = await renderDraftVisual(db, {
      draftId: id,
      body: '#BTCHolds\n\nVolume rose 12% on the week.',
      hashtag: '#BTCHolds',
      baseSchema: { headline_1: 'BTC', focal_number: '12%', stat_tiles: [] },
      visualDir: '/v',
      now: NOW,
      render: async () => {
        throw new Error('Rendered PNG is 1200 KB, over the 976 KB upload limit');
      },
    });
    expect(r).toEqual({ ok: false, reason: 'the card could not be drawn: Rendered PNG is 1200 KB, over the 976 KB upload limit' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM visuals').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('visualSlug', () => {
  it('keeps only letters, digits and single hyphens', () => {
    expect(visualSlug('#WhatWillDriveCryptoandStocks’NextRebound?')).toBe('whatwilldrivecryptoandstocks-nextrebound');
    expect(visualSlug('#TRUMPBreaksAbove$3.4')).toBe('trumpbreaksabove-3-4');
    expect(visualSlug('#???')).toBe('card');
  });
});
