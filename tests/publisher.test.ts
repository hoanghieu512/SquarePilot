import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { SquareError, type PublishResult } from '../src/client/square-client.js';
import {
  PublishUncertainError,
  PublishingDisabledError,
  publishDraft,
  type PublisherDeps,
} from '../src/deliver/publisher.js';
import { memoryDb, seedDraft, seedVisual } from './helpers/approval-db.js';

const NOW = new Date('2026-11-15T03:00:00.000Z');
const BODY = '#BTCHolds\n\nVolume rose 12%  while price held $68k.\n\nTrailing space stays. ';

function fakeSquare(answer: PublishResult | Error = { status: 'published', id: '991', shareLink: 'https://sq/p/991' }) {
  return {
    publishPost: vi.fn(async (_post: { body: string; imageUrls: string[] }) => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

describe('publishDraft', () => {
  let db: Database.Database;
  let square: ReturnType<typeof fakeSquare>;
  const deps = (over: Partial<PublisherDeps> = {}): PublisherDeps => ({
    db,
    square,
    now: () => NOW,
    enabled: true,
    ...over,
  });

  beforeEach(() => {
    db = memoryDb();
    square = fakeSquare();
    db.prepare(
      `INSERT INTO lenses (id, path, name, evidence_required, synced_at) VALUES ('funding-mood', 'l.md', 'Funding', 'x', '2026-11-01')`,
    ).run();
  });
  afterEach(() => db.close());

  it('refuses a pending draft: nothing reaches Square without the owner approving it', async () => {
    const id = seedDraft(db, { status: 'pending' });
    seedVisual(db, id);

    await expect(publishDraft(deps(), id)).rejects.toThrow(/only an approved draft/);
    expect(square.publishPost).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'expired'] as const)('refuses a %s draft', async (status) => {
    const id = seedDraft(db, { status });
    seedVisual(db, id);
    await expect(publishDraft(deps(), id)).rejects.toThrow(/only an approved draft/);
    expect(square.publishPost).not.toHaveBeenCalled();
  });

  it('refuses everything while publishing is off, before reading the draft', async () => {
    // No such draft: only a check made before the lookup can answer "off".
    await expect(publishDraft(deps({ enabled: false }), 999)).rejects.toBeInstanceOf(PublishingDisabledError);
    expect(square.publishPost).not.toHaveBeenCalled();
  });

  it('posts the newest card the owner was shown, not a newer one that never reached the chat', async () => {
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id, { imageUrl: 'https://public.bnbstatic.com/shown.png' });
    seedVisual(db, id, { imageUrl: 'https://public.bnbstatic.com/never-sent.png', offered: false });

    await publishDraft(deps(), id);

    expect(square.publishPost.mock.calls[0]![0].imageUrls).toEqual(['https://public.bnbstatic.com/shown.png']);
  });

  it('refuses a draft whose card was never uploaded: no image, no post', async () => {
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id, { imageUrl: null });
    await expect(publishDraft(deps(), id)).rejects.toThrow(/no card of this draft reached the chat/);
    expect(square.publishPost).not.toHaveBeenCalled();
  });

  it('refuses a draft that already has a post', async () => {
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id);
    await publishDraft(deps(), id);
    await expect(publishDraft(deps(), id)).rejects.toThrow(/already published/);
    expect(square.publishPost).toHaveBeenCalledTimes(1);
  });

  it('posts the body verbatim with the newest card, and records the exact snapshot', async () => {
    const id = seedDraft(db, { status: 'approved', body: BODY });
    seedVisual(db, id, { imageUrl: 'https://public.bnbstatic.com/old.png' });
    seedVisual(db, id, { imageUrl: 'https://public.bnbstatic.com/new.png', pngPath: '/v/new.png' });

    const out = await publishDraft(deps(), id);

    expect(square.publishPost).toHaveBeenCalledWith({
      body: BODY,
      imageUrls: ['https://public.bnbstatic.com/new.png'],
    });
    expect(out).toEqual({
      squarePostId: '991',
      shareLink: 'https://sq/p/991',
      note: 'https://sq/p/991',
      recorded: true,
      publishedAt: NOW.toISOString(),
      body: BODY,
    });
    const post = db.prepare('SELECT * FROM posts').get() as Record<string, unknown>;
    expect(post).toMatchObject({
      draft_id: id,
      square_post_id: '991',
      content_snapshot: BODY,
      hashtag: '#BTCHolds',
      png_path: '/v/new.png',
      published_at: NOW.toISOString(),
    });
  });

  it('uses a lens up only once the post is live', async () => {
    const lensUse = () =>
      db.prepare(`SELECT use_count, last_used FROM lenses WHERE id = 'funding-mood'`).get() as {
        use_count: number;
        last_used: string | null;
      };
    const id = seedDraft(db, { status: 'approved', outcome: 'lens', sourceRef: 'funding-mood' });
    seedVisual(db, id);
    expect(lensUse()).toEqual({ use_count: 0, last_used: null });

    await publishDraft(deps(), id);

    expect(lensUse()).toEqual({ use_count: 1, last_used: NOW.toISOString() });
  });

  it('records a 504 as a live post without an id', async () => {
    square = fakeSquare({ status: 'published_without_id', id: null, shareLink: null });
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id);

    const out = await publishDraft(deps(), id);

    expect(out.note).toMatch(/504/);
    const post = db.prepare('SELECT square_post_id FROM posts').get() as { square_post_id: string | null };
    expect(post.square_post_id).toBeNull();
  });

  it('turns an unclear Square answer into PublishUncertainError', async () => {
    square = fakeSquare(new SquareError('/content/add returned non-JSON (HTTP 502)', undefined, true));
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id);

    const err = await publishDraft(deps(), id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishUncertainError);
    expect((err as PublishUncertainError).uncertain).toBe(true);
  });

  it('passes a clear rejection through, so the draft can go back on the queue', async () => {
    square = fakeSquare(new SquareError('/content/add failed [220003]: rejected', '220003'));
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id);

    const err = await publishDraft(deps(), id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquareError);
    expect(err).not.toBeInstanceOf(PublishUncertainError);
  });

  it('never throws once the post is live, even when recording it fails', async () => {
    const id = seedDraft(db, { status: 'approved' });
    seedVisual(db, id);
    db.exec(`CREATE TRIGGER block_posts BEFORE INSERT ON posts BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);

    const out = await publishDraft(deps(), id);

    expect(out.squarePostId).toBe('991');
    expect(out.note).toMatch(/Not recorded in the database: disk full/);
  });
});
