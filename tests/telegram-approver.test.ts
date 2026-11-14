import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/database/migrations.js';
import type { TelegramApi, Update } from '../src/deliver/telegram-api.js';
import {
  REJECT_REASONS,
  approvalKeyboard,
  expireStale,
  formatCardText,
  handleUpdate,
  parseCallback,
  pollOnce,
  rejectKeyboard,
  sendForApproval,
  type ApproverDeps,
  type DraftCard,
} from '../src/deliver/telegram-approver.js';

const CHAT = 111;
const USER = 222;
const NOW = new Date('2026-11-14T12:00:00.000Z');

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

function card(over: Partial<DraftCard> = {}): DraftCard {
  return {
    draftId: 1,
    hashtag: '#Test',
    body: 'Body line one.\nBody line two.',
    nfc: 120,
    nfd: 125,
    perspective: { kind: 'lens', summary: 'Funding is a mood' },
    mode: 'observe',
    model: 'model-x',
    escalated: false,
    gates: { tone: 'pass', shape: 'pass', persona: 'pass' },
    anchor: { tier: 'bank', ref: 'A01' },
    pngPath: '/nonexistent.png',
    ...over,
  };
}

function fakeApi() {
  const calls: string[] = [];
  const api = {
    sendPhoto: vi.fn(async () => {
      calls.push('photo');
      return { message_id: 1 };
    }),
    sendMessage: vi.fn(async () => {
      calls.push('message');
      return { message_id: 2 };
    }),
    editMessageReplyMarkup: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    getUpdates: vi.fn(async () => [] as Update[]),
  };
  return { api, calls };
}

function cb(data: string, over: { chat?: number; user?: number; id?: string } = {}): Update {
  return {
    update_id: 1,
    callback_query: {
      id: over.id ?? 'cq1',
      from: { id: over.user ?? USER },
      message: { message_id: 50, chat: { id: over.chat ?? CHAT } },
      data,
    },
  };
}

describe('keyboards and parseCallback', () => {
  it('keeps every callback_data under 64 bytes for the largest id', () => {
    const id = 2147483647;
    const all = [
      ...approvalKeyboard(id).inline_keyboard.flat(),
      ...rejectKeyboard(id).inline_keyboard.flat(),
    ];
    for (const b of all) expect(Buffer.byteLength(b.callback_data)).toBeLessThan(64);
  });

  it('approval keyboard is one row of four labelled buttons', () => {
    const kb = approvalKeyboard(42);
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]!.map((b) => [b.text, b.callback_data])).toEqual([
      ['Publish', 'p:42'],
      ['Rewrite', 'w:42'],
      ['New visual', 'v:42'],
      ['Reject', 'x:42'],
    ]);
  });

  it('reject keyboard has one button per reason plus Back', () => {
    const buttons = rejectKeyboard(5).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual([
      ...REJECT_REASONS.map((r) => `r:5:${r.code}`),
      'b:5',
    ]);
    expect(buttons.at(-1)!.text).toBe('Back');
    expect(REJECT_REASONS.map((r) => r.code)).toEqual([
      'voice',
      'take',
      'facts',
      'visual',
      'timing',
      'other',
    ]);
  });

  it('round-trips every action', () => {
    expect(parseCallback('p:5')).toEqual({ action: 'publish', draftId: 5 });
    expect(parseCallback('w:5')).toEqual({ action: 'rewrite', draftId: 5 });
    expect(parseCallback('v:5')).toEqual({ action: 'newVisual', draftId: 5 });
    expect(parseCallback('x:5')).toEqual({ action: 'rejectMenu', draftId: 5 });
    expect(parseCallback('b:5')).toEqual({ action: 'back', draftId: 5 });
    expect(parseCallback('r:5:facts')).toEqual({ action: 'reject', draftId: 5, reason: 'facts' });
  });

  it('rejects malformed input', () => {
    for (const bad of ['p:', 'p:abc', 'r:5:nope', 'z:5', 'p:5:extra', '', 'r:5', 'p:-1', 'p:1.5']) {
      expect(parseCallback(bad), bad).toBeNull();
    }
  });
});

describe('formatCardText', () => {
  it('keeps the body verbatim and lists every meta line', () => {
    const c = card({ escalated: true });
    const text = formatCardText(c);
    expect(text.startsWith(`${c.body}\n\n`)).toBe(true);
    const meta = text.slice(c.body.length + 2).split('\n');
    expect(meta).toEqual([
      '#Test',
      'NFC 120 / NFD 125',
      'lens: Funding is a mood',
      'observe',
      'model-x (escalated)',
      'gates: tone pass · shape pass · persona pass',
      'anchor: bank A01',
      'draft #1',
    ]);
  });

  it('says anchor: none when there is no anchor', () => {
    expect(formatCardText(card({ anchor: { tier: null, ref: null } }))).toContain('\nanchor: none\n');
  });

  it('stays under 4096 characters for a 5000 character body', () => {
    const text = formatCardText(card({ body: 'x'.repeat(5000) }));
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('…');
    expect(text).toContain('draft #1');
  });
});

describe('approver', () => {
  let db: Database.Database;
  let published: ReturnType<typeof vi.fn>;
  let rewritten: ReturnType<typeof vi.fn>;
  let newVisual: ReturnType<typeof vi.fn>;
  let rejected: ReturnType<typeof vi.fn>;
  let fake: ReturnType<typeof fakeApi>;
  let deps: ApproverDeps;
  let pngPath: string;

  function insertDraft(createdAt = hoursAgo(1), status = 'pending'): number {
    const info = db
      .prepare(
        `INSERT INTO drafts (selection_id, body, nfc_len, nfd_len, model_used, status, created_at)
         VALUES (1, 'b', 1, 1, 'm', ?, ?)`,
      )
      .run(status, createdAt);
    return Number(info.lastInsertRowid);
  }

  const row = (id: number) =>
    db.prepare('SELECT status, reject_reason, resolved_at FROM drafts WHERE id = ?').get(id) as {
      status: string;
      reject_reason: string | null;
      resolved_at: string | null;
    };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#T', 1, 1, 1, '2026-11-14T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-11-14T00:00:00Z')`,
    ).run();
    published = vi.fn(async () => {});
    rewritten = vi.fn(async () => {});
    newVisual = vi.fn(async () => {});
    rejected = vi.fn(async () => {});
    fake = fakeApi();
    deps = {
      api: fake.api as unknown as TelegramApi,
      db,
      chatId: CHAT,
      allowedUserIds: [USER],
      now: () => NOW,
      onPublish: published as unknown as ApproverDeps['onPublish'],
      onRewrite: rewritten as unknown as ApproverDeps['onRewrite'],
      onNewVisual: newVisual as unknown as ApproverDeps['onNewVisual'],
      onReject: rejected as unknown as NonNullable<ApproverDeps['onReject']>,
    };
    pngPath = join(mkdtempSync(join(tmpdir(), 'tg-approver-')), 'draft.png');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(() => {
    // Invariant: only an allowed "p" callback may ever reach onPublish. Tests
    // that press "p" from the allowed user assert their own call counts.
    db.close();
  });

  describe('sendForApproval', () => {
    it('sends the photo before the message, with a short caption', async () => {
      const id = insertDraft();
      await sendForApproval(deps, card({ draftId: id, pngPath, body: 'y'.repeat(5000) }));

      expect(fake.calls).toEqual(['photo', 'message']);
      const [chat, png, caption] = fake.api.sendPhoto.mock.calls[0] as unknown as [number, Buffer, string];
      expect(chat).toBe(CHAT);
      expect(png.length).toBe(4);
      expect(caption).toBe(`#Test · draft #${id}`);
      expect(caption.length).toBeLessThan(1024);
      const [, text, markup] = fake.api.sendMessage.mock.calls[0] as unknown as [
        number,
        string,
        unknown,
      ];
      expect(text.length).toBeLessThan(4096);
      expect(markup).toEqual(approvalKeyboard(id));
      expect(published).not.toHaveBeenCalled();
    });

    it('keeps the caption under 1024 chars even for a huge hashtag', async () => {
      const id = insertDraft();
      await sendForApproval(deps, card({ draftId: id, pngPath, hashtag: '#' + 'h'.repeat(2000) }));
      const caption = (fake.api.sendPhoto.mock.calls[0] as unknown as [number, Buffer, string])[2];
      expect(caption.length).toBeLessThanOrEqual(1024);
    });

    it('refuses a draft that is not pending', async () => {
      const id = insertDraft(hoursAgo(1), 'approved');
      await expect(sendForApproval(deps, card({ draftId: id, pngPath }))).rejects.toThrow(/pending/);
      expect(fake.api.sendPhoto).not.toHaveBeenCalled();
      expect(fake.api.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdate', () => {
    it('publish happy path', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`p:${id}`));

      const r = row(id);
      expect(r.status).toBe('approved');
      expect(r.resolved_at).toBe(NOW.toISOString());
      expect(published).toHaveBeenCalledTimes(1);
      expect(published).toHaveBeenCalledWith(id);
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('a double publish press calls onPublish once', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`p:${id}`));
      await handleUpdate(deps, cb(`p:${id}`, { id: 'cq2' }));

      expect(published).toHaveBeenCalledTimes(1);
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(2);
      expect(fake.api.answerCallbackQuery).toHaveBeenLastCalledWith('cq2', 'Draft is approved');
    });

    it('ignores another chat', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`p:${id}`, { chat: 999 }));
      expect(published).not.toHaveBeenCalled();
      expect(row(id).status).toBe('pending');
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('ignores another user', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`p:${id}`, { user: 999 }));
      await handleUpdate(deps, cb(`r:${id}:facts`, { user: 999 }));
      await handleUpdate(deps, cb(`w:${id}`, { user: 999 }));
      expect(published).not.toHaveBeenCalled();
      expect(rewritten).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
      expect(row(id).status).toBe('pending');
    });

    it('ignores updates without a callback query', async () => {
      await handleUpdate(deps, { update_id: 1 });
      expect(fake.api.answerCallbackQuery).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
    });

    it('answers Unknown action for unparseable data', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb('p:abc'));
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledWith('cq1', 'Unknown action');
      expect(published).not.toHaveBeenCalled();
      expect(row(id).status).toBe('pending');
    });

    it('answers for a missing draft and does nothing else', async () => {
      await handleUpdate(deps, cb('p:9999'));
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledWith('cq1', 'Draft is missing');
      expect(published).not.toHaveBeenCalled();
    });

    it('restores pending and reports when onPublish throws', async () => {
      const id = insertDraft();
      published.mockRejectedValueOnce(new Error('square is down'));
      await handleUpdate(deps, cb(`p:${id}`));

      const r = row(id);
      expect(r.status).toBe('pending');
      expect(r.resolved_at).toBeNull();
      expect(fake.api.sendMessage).toHaveBeenCalledTimes(1);
      const [chat, text] = fake.api.sendMessage.mock.calls[0] as unknown as [number, string];
      expect(chat).toBe(CHAT);
      expect(text).toContain('square is down');
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    describe('answer ordering', () => {
      let order: string[];
      beforeEach(() => {
        order = [];
        fake.api.answerCallbackQuery.mockImplementation(async () => {
          order.push('answer');
        });
        fake.api.sendMessage.mockImplementation(async (_chat: unknown, text: unknown) => {
          order.push(`message:${String(text)}`);
          return { message_id: 2 };
        });
        fake.api.editMessageReplyMarkup.mockImplementation(async () => {
          order.push('keyboard');
        });
        published.mockImplementation(async () => {
          order.push('publish');
        });
        rewritten.mockImplementation(async () => {
          order.push('rewrite');
        });
        newVisual.mockImplementation(async () => {
          order.push('newVisual');
        });
        rejected.mockImplementation(async () => {
          order.push('reject');
        });
      });

      it('answers before onPublish, then removes the keyboard and sends one message', async () => {
        const id = insertDraft();
        await handleUpdate(deps, cb(`p:${id}`));
        expect(order).toEqual(['answer', 'publish', 'keyboard', `message:Published draft #${id}`]);
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledWith('cq1', 'Publishing…');
        expect(row(id).status).toBe('approved');
      });

      it('answers once, before onPublish, and reports a failed publish', async () => {
        const id = insertDraft();
        published.mockImplementationOnce(async () => {
          order.push('publish');
          throw new Error('square is down');
        });
        await handleUpdate(deps, cb(`p:${id}`));
        expect(order).toEqual([
          'answer',
          'publish',
          `message:Publish failed for draft #${id}: square is down`,
        ]);
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(row(id).status).toBe('pending');
        expect(row(id).resolved_at).toBeNull();
      });

      it('answers before onRewrite', async () => {
        const id = insertDraft();
        await handleUpdate(deps, cb(`w:${id}`));
        expect(order.indexOf('answer')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('answer')).toBeLessThan(order.indexOf('rewrite'));
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledWith('cq1', 'Rewriting…');
        expect(row(id).status).toBe('rejected');
      });

      it('answers before onNewVisual and onReject', async () => {
        const id = insertDraft();
        await handleUpdate(deps, cb(`v:${id}`));
        expect(order).toEqual(['answer', 'newVisual']);
        order.length = 0;
        await handleUpdate(deps, cb(`r:${id}:voice`));
        expect(order.indexOf('answer')).toBeLessThan(order.indexOf('reject'));
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(2);
      });

      it('still publishes once and keeps the draft approved when the answer throws', async () => {
        const id = insertDraft();
        fake.api.answerCallbackQuery.mockRejectedValue(new Error('query expired'));
        await handleUpdate(deps, cb(`p:${id}`));
        expect(published).toHaveBeenCalledTimes(1);
        expect(row(id).status).toBe('approved');
        expect(order).toContain(`message:Published draft #${id}`);
        expect(fake.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
      });

      it('still runs onRewrite when the answer throws', async () => {
        const id = insertDraft();
        fake.api.answerCallbackQuery.mockRejectedValue(new Error('query expired'));
        await handleUpdate(deps, cb(`w:${id}`));
        expect(rewritten).toHaveBeenCalledTimes(1);
        expect(row(id).status).toBe('rejected');
      });
    });

    it('reject flow: menu, reason, back', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`x:${id}`));
      expect(fake.api.editMessageReplyMarkup).toHaveBeenLastCalledWith(CHAT, 50, rejectKeyboard(id));
      expect(row(id).status).toBe('pending');

      await handleUpdate(deps, cb(`b:${id}`));
      expect(fake.api.editMessageReplyMarkup).toHaveBeenLastCalledWith(CHAT, 50, approvalKeyboard(id));
      expect(row(id).status).toBe('pending');

      await handleUpdate(deps, cb(`r:${id}:facts`));
      const r = row(id);
      expect(r.status).toBe('rejected');
      expect(r.reject_reason).toBe('facts');
      expect(r.resolved_at).toBe(NOW.toISOString());
      expect(fake.api.editMessageReplyMarkup).toHaveBeenLastCalledWith(CHAT, 50, null);
      expect(rejected).toHaveBeenCalledWith(id, 'facts');
      expect(published).not.toHaveBeenCalled();
    });

    it('rewrite rejects with the rewrite-requested reason', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`w:${id}`));
      const r = row(id);
      expect(r.status).toBe('rejected');
      expect(r.reject_reason).toBe('rewrite-requested');
      expect(r.resolved_at).not.toBeNull();
      expect(fake.api.editMessageReplyMarkup).toHaveBeenLastCalledWith(CHAT, 50, null);
      expect(rewritten).toHaveBeenCalledWith(id);
      expect(published).not.toHaveBeenCalled();
    });

    it('new visual keeps the draft pending', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`v:${id}`));
      expect(row(id).status).toBe('pending');
      expect(newVisual).toHaveBeenCalledWith(id);
      expect(published).not.toHaveBeenCalled();
    });

    it('a resolved draft ignores further buttons', async () => {
      const id = insertDraft();
      await handleUpdate(deps, cb(`r:${id}:voice`));
      rejected.mockClear();
      await handleUpdate(deps, cb(`p:${id}`));
      await handleUpdate(deps, cb(`w:${id}`));
      expect(published).not.toHaveBeenCalled();
      expect(rewritten).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
      expect(row(id).status).toBe('rejected');
      expect(row(id).reject_reason).toBe('voice');
    });

    it('works without an onReject callback', async () => {
      const id = insertDraft();
      delete (deps as { onReject?: unknown }).onReject;
      await handleUpdate(deps, cb(`r:${id}:other`));
      expect(row(id).reject_reason).toBe('other');
    });
  });

  describe('expireStale', () => {
    it('expires only drafts older than the ttl', () => {
      const old = insertDraft(hoursAgo(7));
      const fresh = insertDraft(hoursAgo(5));
      const done = insertDraft(hoursAgo(9), 'approved');

      const ids = expireStale(db, NOW);

      expect(ids).toEqual([old]);
      expect(row(old).status).toBe('expired');
      expect(row(old).resolved_at).toBe(NOW.toISOString());
      expect(row(fresh).status).toBe('pending');
      expect(row(done).status).toBe('approved');
      expect(fake.api.sendMessage).not.toHaveBeenCalled();
    });

    it('pressing publish on an expired draft calls nothing', async () => {
      const id = insertDraft(hoursAgo(7));
      await handleUpdate(deps, cb(`p:${id}`));

      expect(published).not.toHaveBeenCalled();
      expect(row(id).status).toBe('expired');
      expect(fake.api.answerCallbackQuery).toHaveBeenCalledWith('cq1', 'Draft is expired');
      expect(fake.api.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('pollOnce', () => {
    it('advances the offset past the highest update id', async () => {
      const a = insertDraft();
      fake.api.getUpdates.mockResolvedValueOnce([
        { ...cb(`v:${a}`), update_id: 10 },
        { ...cb(`v:${a}`), update_id: 12 },
      ]);
      const next = await pollOnce(deps, 5);
      expect(next).toBe(13);
      expect(fake.api.getUpdates).toHaveBeenCalledWith(5, 30);
    });

    it('keeps the offset when there are no updates', async () => {
      expect(await pollOnce(deps, 5)).toBe(5);
    });

    it('continues after one handler throws', async () => {
      const a = insertDraft();
      const b = insertDraft();
      newVisual.mockRejectedValueOnce(new Error('render failed'));
      fake.api.getUpdates.mockResolvedValueOnce([
        { ...cb(`v:${a}`), update_id: 20 },
        { ...cb(`w:${b}`), update_id: 21 },
      ]);

      const next = await pollOnce(deps, 0);

      expect(next).toBe(22);
      expect(rewritten).toHaveBeenCalledWith(b);
      expect(published).not.toHaveBeenCalled();
    });
  });
});
