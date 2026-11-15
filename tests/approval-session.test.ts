import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ZaloApi, ZaloUpdate } from '../src/deliver/zalo-api.js';
import { draftCode } from '../src/deliver/draft-code.js';
import { publishDraft } from '../src/deliver/publisher.js';
import { runApprovalSession, type SessionDeps, type SessionHandlers } from '../src/deliver/approval-session.js';
import { memoryDb, seedDraft, seedVisual } from './helpers/approval-db.js';

const CHAT = 'chat-1';
const START = new Date('2026-11-15T01:00:00.000Z');

let msg = 0;
function text(t: string): ZaloUpdate {
  msg += 1;
  return {
    event_name: 'message.text.received',
    message: {
      from: { id: 'owner', display_name: 'Owner', is_bot: false },
      chat: { id: CHAT, chat_type: 'PRIVATE' },
      text: t,
      message_id: `m-${msg}`,
      date: 0,
    },
  } as ZaloUpdate;
}

type Sent = { type: 'photo' | 'message'; text: string; photoUrl?: string };

/**
 * Answers each poll from `script`. A session that never stops is aborted after
 * 200 polls, so a regression fails its assertions instead of hanging the run.
 */
function scriptedApi(script: (poll: number) => ZaloUpdate[], runaway: AbortController) {
  const sent: Sent[] = [];
  let poll = 0;
  const api = {
    sendPhoto: vi.fn(async (_chat: string, photoUrl: string, caption?: string) => {
      sent.push({ type: 'photo', photoUrl, text: caption ?? '' });
      return {};
    }),
    sendMessage: vi.fn(async (_chat: string, t: string) => {
      sent.push({ type: 'message', text: t });
      return {};
    }),
    getUpdates: vi.fn(async () => {
      poll += 1;
      await new Promise((r) => setTimeout(r, 0));
      if (poll > 200) {
        runaway.abort();
        return [];
      }
      return script(poll);
    }),
  };
  return { api: api as unknown as ZaloApi & typeof api, sent };
}

describe('runApprovalSession', () => {
  let db: Database.Database;
  let clock: Date;
  let dir: string;
  let handlers: { [K in keyof SessionHandlers]: ReturnType<typeof vi.fn> };
  let square: { uploadImage: ReturnType<typeof vi.fn> };
  let controller: AbortController;

  function deps(api: ZaloApi, over: Partial<SessionDeps> = {}): SessionDeps {
    return {
      db,
      api,
      chatId: CHAT,
      now: () => clock,
      square: square as unknown as SessionDeps['square'],
      modelFor: (tier) => `model-${tier}`,
      publishEnabled: true,
      handlers: handlers as unknown as SessionHandlers,
      signal: controller.signal,
      timeoutSec: 1,
      sleep: async () => {},
      ...over,
    };
  }

  function png(name: string): string {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return p;
  }

  const status = (id: number) =>
    db.prepare('SELECT status, reject_reason FROM drafts WHERE id = ?').get(id) as {
      status: string;
      reject_reason: string | null;
    };

  beforeEach(() => {
    db = memoryDb();
    clock = START;
    dir = mkdtempSync(join(tmpdir(), 'sp-session-'));
    controller = new AbortController();
    square = { uploadImage: vi.fn(async () => 'https://public.bnbstatic.com/up.png') };
    handlers = {
      publish: vi.fn(async () => 'https://square.example/p/1'),
      rewrite: vi.fn(async () => {
        throw new Error('not expected');
      }),
      newVisual: vi.fn(async () => {
        throw new Error('not expected');
      }),
    };
  });
  afterEach(() => db.close());

  it('uploads the card once, offers the draft with it, and ends when the draft is rejected', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id, { imageUrl: null, pngPath: png('card.png') });
    const { api, sent } = scriptedApi((poll) => (poll === 1 ? [text(`b ${draftCode(id)} 2`)] : []), controller);

    const summary = await runApprovalSession(deps(api), [id]);

    expect(square.uploadImage).toHaveBeenCalledTimes(1);
    expect(square.uploadImage.mock.calls[0]![1]).toBe('card.png');
    const photo = sent.find((s) => s.type === 'photo')!;
    expect(photo.photoUrl).toBe('https://public.bnbstatic.com/up.png');
    expect(photo.text).toContain(`[${draftCode(id)}] #BTCHolds`);
    expect(photo.text).toContain('model-free');
    expect(photo.text).toContain('gates: tone pass · shape pass · persona pass · facts pass');
    const stored = db.prepare('SELECT image_url FROM visuals WHERE draft_id = ?').get(id) as { image_url: string };
    expect(stored.image_url).toBe('https://public.bnbstatic.com/up.png');
    expect(status(id)).toEqual({ status: 'rejected', reject_reason: 'take' });
    expect(summary.reason).toBe('resolved');
    expect(handlers.publish).not.toHaveBeenCalled();
  });

  it('still offers the draft, marked "no image", when the upload fails', async () => {
    square.uploadImage.mockRejectedValueOnce(new Error('Square down'));
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id, { imageUrl: null, pngPath: png('card.png') });
    const { api, sent } = scriptedApi((poll) => (poll === 1 ? [text(`b ${draftCode(id)} 6`)] : []), controller);

    await runApprovalSession(deps(api), [id]);

    expect(sent.some((s) => s.type === 'photo')).toBe(false);
    expect(sent[0]!.text).toMatch(/\(no image\)$/);
  });

  it('never publishes without a command: an unanswered draft expires and the session ends', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 3) clock = new Date(START.getTime() + 6 * 3600_000 + 60_000);
      return [];
    }, controller);

    const summary = await runApprovalSession(deps(api), [id]);

    expect(handlers.publish).not.toHaveBeenCalled();
    expect(status(id).status).toBe('expired');
    expect(sent.at(-1)!.text).toBe(`${draftCode(id)} expired after 6 hours, not posted`);
    expect(summary).toEqual({ reason: 'resolved', drafts: [{ id, code: draftCode(id), status: 'expired' }] });
  });

  it('in a trial run, "d" leaves the draft pending and the session keeps waiting', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    const code = draftCode(id);
    handlers.publish.mockImplementation((draftId: number) =>
      publishDraft({ db, square: null, now: () => clock, enabled: false }, draftId),
    );
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`d ${code}`)];
      if (poll === 3) return [text(`b ${code} 6`)];
      return [];
    }, controller);

    await runApprovalSession(deps(api, { publishEnabled: false }), [id]);

    expect(sent[0]!.text).toBe('Trial run: publishing is off. "d" will not post; the draft stays pending.');
    expect(sent.map((s) => s.text)).toContain(
      `${code}: publishing is off for this run (start with --publish to post). The draft stays pending`,
    );
    expect(sent.some((s) => s.text.startsWith('Publishing'))).toBe(false);
    // The publisher is never reached; it would refuse on its own as well.
    expect(handlers.publish).not.toHaveBeenCalled();
    expect(status(id)).toEqual({ status: 'rejected', reject_reason: 'other' });
  });

  it('publishes on "d", confirms with the link, and ends', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    const { api, sent } = scriptedApi((poll) => (poll === 1 ? [text(`d ${draftCode(id)}`)] : []), controller);

    const summary = await runApprovalSession(deps(api), [id]);

    expect(handlers.publish).toHaveBeenCalledWith(id);
    expect(sent.at(-1)!.text).toBe(`Published ${draftCode(id)}: https://square.example/p/1`);
    expect(summary.drafts).toEqual([{ id, code: draftCode(id), status: 'approved' }]);
  });

  it('rewrite: offers the replacement under a new code and waits for it', async () => {
    const oldId = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, oldId);
    let newId = 0;
    handlers.rewrite.mockImplementation(async () => {
      newId = seedDraft(db, { createdAt: START.toISOString(), body: '#BTCHolds\n\nA second take, 31% of wallets.' });
      seedVisual(db, newId);
      return newId;
    });
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`v ${draftCode(oldId)}`)];
      if (poll === 3) return [text(`d ${draftCode(newId)}`)];
      return [];
    }, controller);

    const summary = await runApprovalSession(deps(api), [oldId]);

    expect(status(oldId)).toEqual({ status: 'rejected', reject_reason: 'rewrite-requested' });
    expect(status(newId).status).toBe('approved');
    expect(handlers.publish).toHaveBeenCalledWith(newId);
    expect(sent.filter((s) => s.type === 'photo').map((s) => s.photoUrl)).toEqual([
      `https://public.bnbstatic.com/card-${oldId}.png`,
      `https://public.bnbstatic.com/card-${newId}.png`,
    ]);
    expect(sent.map((s) => s.text)).toContain('#BTCHolds\n\nA second take, 31% of wallets.');
    expect(summary.drafts.map((d) => d.status)).toEqual(['rejected', 'approved']);
  });

  it('a failed rewrite puts the original back on the queue and keeps waiting', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    const code = draftCode(id);
    handlers.rewrite.mockRejectedValueOnce(new Error('the new draft failed the gates'));
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`v ${code}`)];
      if (poll === 3) return [text(`b ${code} 1`)];
      return [];
    }, controller);

    await runApprovalSession(deps(api), [id]);

    expect(sent.map((s) => s.text)).toContain(`Rewrite failed for ${code}: the new draft failed the gates`);
    expect(status(id)).toEqual({ status: 'rejected', reject_reason: 'voice' });
  });

  it('withdraws a replacement that could not be sent, so no unseen draft waits for approval', async () => {
    const oldId = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, oldId);
    let newId = 0;
    handlers.rewrite.mockImplementation(async () => {
      newId = seedDraft(db, { createdAt: START.toISOString() });
      seedVisual(db, newId);
      return newId;
    });
    const { api } = scriptedApi((poll) => {
      if (poll === 1) return [text(`v ${draftCode(oldId)}`)];
      if (poll === 3) return [text(`b ${draftCode(oldId)} 6`)];
      return [];
    }, controller);
    api.sendPhoto.mockImplementation(async (_c: string, url: string) => {
      if (url.includes(`card-${newId}`)) throw new Error('Zalo down');
      return {};
    });

    await runApprovalSession(deps(api), [oldId]);

    expect(status(newId)).toEqual({ status: 'rejected', reject_reason: 'not-sent' });
    expect(status(oldId)).toEqual({ status: 'rejected', reject_reason: 'other' });
  });

  it('new visual: draws a new card, uploads it, and offers the same draft again', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    handlers.newVisual.mockImplementation(async (draftId: number) => {
      seedVisual(db, draftId, { imageUrl: null, pngPath: png('card-v2.png') });
    });
    square.uploadImage.mockResolvedValueOnce('https://public.bnbstatic.com/v2.png');
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`a ${draftCode(id)}`)];
      if (poll === 3) return [text(`b ${draftCode(id)} 4`)];
      return [];
    }, controller);

    await runApprovalSession(deps(api), [id]);

    expect(handlers.newVisual).toHaveBeenCalledWith(id);
    expect(sent.filter((s) => s.type === 'photo').map((s) => s.photoUrl)).toEqual([
      `https://public.bnbstatic.com/card-${id}.png`,
      'https://public.bnbstatic.com/v2.png',
    ]);
  });

  it('stops when aborted and tells the owner the draft is no longer watched', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 2) controller.abort();
      return [];
    }, controller);

    const summary = await runApprovalSession(deps(api), [id]);

    expect(summary.reason).toBe('aborted');
    // Withdrawn, not left pending: no later run can act on a draft it did not offer.
    expect(status(id)).toEqual({ status: 'rejected', reject_reason: 'session-ended' });
    expect(sent.at(-1)!.text).toBe(`Approval session stopped (aborted). ${draftCode(id)} withdrawn, not posted.`);
  });

  it('gives up at the deadline and withdraws what is still pending', async () => {
    // Created an hour into the session, so it has not expired when the
    // session's own deadline (6 h + 30 min from its start) passes.
    const id = seedDraft(db, { createdAt: new Date(START.getTime() + 3600_000).toISOString() });
    seedVisual(db, id);
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 2) clock = new Date(START.getTime() + 6.5 * 3600_000 + 60_000);
      return [];
    }, controller);

    const summary = await runApprovalSession(deps(api), [id]);

    expect(summary.reason).toBe('deadline');
    expect(status(id)).toEqual({ status: 'rejected', reject_reason: 'session-ended' });
    expect(sent.at(-1)!.text).toBe(`Approval session stopped (deadline). ${draftCode(id)} withdrawn, not posted.`);
  });

  it('does not upload a card that is already on Square', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    const { api } = scriptedApi((poll) => (poll === 1 ? [text(`b ${draftCode(id)} 6`)] : []), controller);

    await runApprovalSession(deps(api), [id]);

    expect(square.uploadImage).not.toHaveBeenCalled();
  });

  it('needs a code after a rewrite, so a bare "d" cannot post a replacement nobody has read', async () => {
    const oldId = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, oldId);
    let newId = 0;
    handlers.rewrite.mockImplementation(async () => {
      newId = seedDraft(db, { createdAt: START.toISOString() });
      seedVisual(db, newId);
      return newId;
    });
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`v ${draftCode(oldId)}`)];
      if (poll === 2) return [text('d')];
      if (poll === 4) return [text(`b ${draftCode(newId)} 6`)];
      return [];
    }, controller);

    await runApprovalSession(deps(api), [oldId]);

    expect(handlers.publish).not.toHaveBeenCalled();
    expect(sent.map((s) => s.text)).toContain(
      `This run has offered more than one draft. Add the code, for example: d ${draftCode(newId)}`,
    );
  });

  it('keeps the shown card for publishing when a new card cannot be sent to the chat', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    const v1 = seedVisual(db, id);
    let v2 = 0;
    handlers.newVisual.mockImplementation(async (draftId: number) => {
      v2 = seedVisual(db, draftId, { imageUrl: null, pngPath: png('card-v2.png') });
    });
    square.uploadImage.mockResolvedValueOnce('https://public.bnbstatic.com/v2.png');
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`a ${draftCode(id)}`)];
      if (poll === 3) return [text(`b ${draftCode(id)} 6`)];
      return [];
    }, controller);
    api.sendPhoto.mockImplementation(async (_c: string, url: string) => {
      if (url.endsWith('v2.png')) throw new Error('Zalo down');
      return {};
    });

    await runApprovalSession(deps(api), [id]);

    const offered = db.prepare('SELECT id FROM visuals WHERE offered_at IS NOT NULL ORDER BY id').all() as { id: number }[];
    expect(offered.map((r) => r.id)).toEqual([v1]);
    expect(v2).toBeGreaterThan(v1);
    expect(sent.map((s) => s.text).some((t) => t.startsWith('Error: '))).toBe(true);
  });

  it('reports a new card that could not be uploaded, instead of sending it without its image', async () => {
    const id = seedDraft(db, { createdAt: START.toISOString() });
    seedVisual(db, id);
    handlers.newVisual.mockImplementation(async (draftId: number) => {
      seedVisual(db, draftId, { imageUrl: null, pngPath: png('card-v2.png') });
    });
    square.uploadImage.mockRejectedValueOnce(new Error('Square down'));
    const { api, sent } = scriptedApi((poll) => {
      if (poll === 1) return [text(`a ${draftCode(id)}`)];
      if (poll === 3) return [text(`b ${draftCode(id)} 6`)];
      return [];
    }, controller);

    await runApprovalSession(deps(api), [id]);

    expect(sent.filter((s) => s.type === 'photo')).toHaveLength(1);
    expect(sent.map((s) => s.text)).toContain('Error: could not upload the new card: Square down');
  });
});
