import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import type { ZaloApi, ZaloUpdate } from '../src/deliver/zalo-api.js';
import { draftCode, parseDraftCode } from '../src/deliver/draft-code.js';
import {
  expireStale,
  pendingDraftIds,
  resolve,
  revertToPending,
  statusOf,
} from '../src/deliver/approval-store.js';
import {
  REJECT_REASONS,
  handleUpdate,
  parseCommand,
  pollLoop,
  pollOnce,
  sendForApproval,
  splitMessage,
  type ApproverDeps,
  type DraftCard,
} from '../src/deliver/zalo-approver.js';

const CHAT = 'chat-allowed-1';
const USER = 'user-1';
const NOW = new Date('2026-11-14T12:00:00.000Z');

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

function makeCard(over: Partial<DraftCard> = {}): DraftCard {
  return {
    draftId: 1,
    hashtag: '#Test',
    body: 'Paragraph one line one.\nParagraph one line two.\n\nParagraph two.',
    nfc: 120,
    nfd: 125,
    perspective: { kind: 'lens', summary: 'Funding is a mood' },
    mode: 'observe',
    model: 'model-x',
    escalated: false,
    gates: { tone: 'pass', shape: 'pass', persona: 'pass' },
    anchor: { tier: 'bank', ref: 'A01' },
    photoUrl: 'https://img.example.com/draft-1.png',
    ...over,
  };
}

function fakeApi() {
  const calls: { type: 'photo' | 'message'; chatId: string; text: string; photoUrl?: string }[] = [];
  const api = {
    getMe: vi.fn(async () => ({ id: 'bot' })),
    sendPhoto: vi.fn(async (chatId: string, photoUrl: string, caption?: string) => {
      calls.push({ type: 'photo', chatId, photoUrl, text: caption ?? '' });
      return { message_id: 'p1' };
    }),
    sendMessage: vi.fn(async (chatId: string, text: string) => {
      calls.push({ type: 'message', chatId, text });
      return { message_id: 'm1' };
    }),
    getUpdates: vi.fn(async () => [] as ZaloUpdate[]),
    setWebhook: vi.fn(async () => ({})),
    deleteWebhook: vi.fn(async () => ({})),
    getWebhookInfo: vi.fn(async () => ({})),
  };
  return { api, calls };
}

let msgCounter = 0;
function textUpdate(
  text: string,
  over: { chatId?: string; userId?: string; isBot?: boolean; messageId?: string; eventName?: string } = {},
): ZaloUpdate {
  msgCounter += 1;
  return {
    event_name: over.eventName ?? 'message.text.received',
    message: {
      from: {
        id: over.userId ?? USER,
        display_name: 'Owner',
        is_bot: over.isBot ?? false,
      },
      chat: {
        id: over.chatId ?? CHAT,
        chat_type: 'PRIVATE',
      },
      text,
      message_id: over.messageId ?? `msg-${msgCounter}`,
      date: 1750316131602,
    },
  };
}

describe('draftCode and parseDraftCode', () => {
  it('round-trips every id from 1 to 100000 with uppercase output of at least 2 symbols', () => {
    const allowed = new Set('ACDEFGHJKMNPQRTUVWXY34679');
    for (let id = 1; id <= 100_000; id++) {
      const code = draftCode(id);
      if (id <= 50 || id % 997 === 0 || id === 100_000) {
        expect(code.length).toBeGreaterThanOrEqual(2);
        expect(code).toBe(code.toUpperCase());
        for (const ch of code) {
          expect(allowed.has(ch)).toBe(true);
        }
      }
      expect(parseDraftCode(code)).toBe(id);
    }
  });

  it('parses case-insensitively', () => {
    const id = parseDraftCode('K7');
    expect(id).not.toBeNull();
    expect(parseDraftCode('k7')).toBe(id);
    expect(draftCode(id!)).toBe('K7');
    expect(parseDraftCode('gnAA')).toBe(parseDraftCode('GNAA'));
  });

  it('rejects look-alike symbols, short strings, and invalid inputs', () => {
    for (const lookalike of ['0', 'O', '1', 'I', 'L', '2', 'Z', '5', 'S', '8', 'B']) {
      expect(parseDraftCode(`A${lookalike}`), `A${lookalike}`).toBeNull();
      expect(parseDraftCode(`${lookalike}A`), `${lookalike}A`).toBeNull();
    }
    for (const bad of ['', 'A', 'K', '7', 'AA', 'AAA', 'K7!', 'K 7', '-K7']) {
      expect(parseDraftCode(bad), bad).toBeNull();
    }
  });
});

describe('parseCommand', () => {
  it('parses all specified Vietnamese and shorthand examples', () => {
    expect(parseCommand('d K7')).toEqual({ action: 'publish', code: 'K7' });
    expect(parseCommand('Đăng K7')).toEqual({ action: 'publish', code: 'K7' });
    expect(parseCommand('dang k7')).toEqual({ action: 'publish', code: 'K7' });
    expect(parseCommand('  D   k7 ')).toEqual({ action: 'publish', code: 'K7' });
    expect(parseCommand('viết lại K7')).toEqual({ action: 'rewrite', code: 'K7' });
    expect(parseCommand('v K7')).toEqual({ action: 'rewrite', code: 'K7' });
    expect(parseCommand('viet K7')).toEqual({ action: 'rewrite', code: 'K7' });
    expect(parseCommand('a K7')).toEqual({ action: 'newVisual', code: 'K7' });
    expect(parseCommand('anh K7')).toEqual({ action: 'newVisual', code: 'K7' });
    expect(parseCommand('đổi ảnh K7')).toEqual({ action: 'newVisual', code: 'K7' });
    expect(parseCommand('b K7 3')).toEqual({ action: 'reject', code: 'K7', reason: 'facts' });
    expect(parseCommand('Bỏ k7')).toEqual({ action: 'reject', code: 'K7' });
    expect(parseCommand('b 3')).toEqual({ action: 'reject', reason: 'facts' });
    expect(parseCommand('?')).toEqual({ action: 'help' });
    expect(parseCommand('help')).toEqual({ action: 'help' });
  });

  it('parses code-less commands for single-draft shorthand', () => {
    expect(parseCommand('d')).toEqual({ action: 'publish' });
    expect(parseCommand('Đăng')).toEqual({ action: 'publish' });
    expect(parseCommand('v')).toEqual({ action: 'rewrite' });
    expect(parseCommand('viết lại')).toEqual({ action: 'rewrite' });
    expect(parseCommand('a')).toEqual({ action: 'newVisual' });
    expect(parseCommand('đổi ảnh')).toEqual({ action: 'newVisual' });
    expect(parseCommand('b')).toEqual({ action: 'reject' });
  });

  it('rejects unknown verbs, invalid codes, out-of-range reasons, and extra tokens', () => {
    for (const bad of [
      'hello',
      'd K7 9',
      'dK7',
      'd K7 3',
      'v K7 1',
      'a K7 2',
      'b K7 0',
      'b K7 7',
      'b 9',
      'd O1',
      'd B8',
      'd A',
      '? K7',
      'help me',
      '',
      '   ',
    ]) {
      expect(parseCommand(bad), bad).toBeNull();
    }
  });
});

describe('splitMessage', () => {
  it('packs whole paragraphs greedily and rejoins with \\n\\n when splits fall on paragraph boundaries', () => {
    const p1 = 'First paragraph with some text. '.repeat(25).trim();
    const p2 = 'Second paragraph with more text. '.repeat(25).trim();
    const p3 = 'Third paragraph ending the post. '.repeat(25).trim();
    const text = [p1, p2, p3].join('\n\n');

    const chunks = splitMessage(text, 1900);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1900);
    }
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('preserves all non-whitespace characters in order and stays <= 1900 on a 4500-character body', () => {
    // Mix of normal paragraphs, an oversized multi-sentence paragraph, an oversized space-only paragraph, and a hard-cut block.
    const sentenceBlock = Array.from(
      { length: 45 },
      (_, i) => `Sentence number ${i + 1} explains the market structure in detail.`,
    ).join(' ');
    const wordBlock = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const body = `${sentenceBlock}\n\n${wordBlock}`;
    expect(body.length).toBeGreaterThanOrEqual(4500);

    const chunks = splitMessage(body, 1900);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(1900);
    }
    expect(chunks.join('').replace(/\s+/g, '')).toBe(body.replace(/\s+/g, ''));

    // Also test a 4500-character contiguous string with no spaces (hard cut).
    const contiguous = Array.from({ length: 4500 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const hardChunks = splitMessage(contiguous, 1900);
    expect(hardChunks.map((c) => c.length)).toEqual([1900, 1900, 700]);
    expect(hardChunks.join('')).toBe(contiguous);
  });
});

describe('zalo-approver and approval-store', () => {
  let db: Database.Database;
  let published: ReturnType<typeof vi.fn>;
  let rewritten: ReturnType<typeof vi.fn>;
  let newVisual: ReturnType<typeof vi.fn>;
  let rejected: ReturnType<typeof vi.fn>;
  let fake: ReturnType<typeof fakeApi>;
  let deps: ApproverDeps;

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
      api: fake.api as unknown as ZaloApi,
      db,
      chatId: CHAT,
      now: () => NOW,
      seen: new Set<string>(),
      onPublish: published as unknown as ApproverDeps['onPublish'],
      onRewrite: rewritten as unknown as ApproverDeps['onRewrite'],
      onNewVisual: newVisual as unknown as ApproverDeps['onNewVisual'],
      onReject: rejected as unknown as NonNullable<ApproverDeps['onReject']>,
    };
  });

  afterEach(() => {
    db.close();
  });

  describe('approval-store helpers', () => {
    it('tracks status, pending ids, resolve, revertToPending, and expireStale', () => {
      const id1 = insertDraft(hoursAgo(7));
      const id2 = insertDraft(hoursAgo(2));
      expect(statusOf(db, id1)).toBe('pending');
      expect(statusOf(db, 9999)).toBeNull();
      expect(pendingDraftIds(db)).toEqual([id1, id2]);

      const expired = expireStale(db, NOW);
      expect(expired).toEqual([id1]);
      expect(statusOf(db, id1)).toBe('expired');
      expect(pendingDraftIds(db)).toEqual([id2]);

      expect(resolve(db, NOW, id2, 'approved', null)).toBe(true);
      expect(resolve(db, NOW, id2, 'approved', null)).toBe(false);
      expect(statusOf(db, id2)).toBe('approved');

      revertToPending(db, id2);
      expect(row(id2)).toEqual({ status: 'pending', reject_reason: null, resolved_at: null });
    });
  });

  describe('sendForApproval', () => {
    it('sends photo with header caption, then verbatim body chunks, then footer with real code', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      const p1 = 'First paragraph of the draft.\nWith a second line.';
      const p2 = 'Second paragraph with *markdown* _chars_ #tag $100.';
      await sendForApproval(
        deps,
        makeCard({
          draftId: id,
          hashtag: '#Bitcoin',
          body: `${p1}\n\n${p2}`,
          escalated: true,
          gates: { tone: 'pass', shape: 'ok', persona: 'pass', data: 'pass' },
          anchor: { tier: 'bank', ref: 'A01' },
          photoUrl: 'https://img.example.com/1.png',
        }),
      );

      expect(fake.calls.map((c) => c.type)).toEqual(['photo', 'message', 'message']);
      expect(fake.calls[0]?.photoUrl).toBe('https://img.example.com/1.png');
      expect(fake.calls[0]?.text.split('\n')).toEqual([
        `[${code}] #Bitcoin`,
        'NFC 120 / NFD 125',
        'lens: Funding is a mood',
        'observe',
        'model-x (escalated)',
        'gates: tone pass · shape ok · persona pass · data pass',
        'anchor: bank A01',
      ]);

      // Body arrives verbatim in one chunk since it fits <= 1900.
      expect(fake.calls[1]?.text).toBe(`${p1}\n\n${p2}`);

      // Footer uses the real code and lists the six numbered reasons.
      const footerLines = fake.calls[2]!.text.split('\n');
      expect(footerLines[0]).toBe(
        `[${code}] Reply: d ${code} publish · v ${code} rewrite · a ${code} new visual · b ${code} <n> reject`,
      );
      for (let i = 0; i < REJECT_REASONS.length; i++) {
        expect(footerLines[1]).toContain(`${i + 1}`);
        expect(footerLines[1]).toContain(REJECT_REASONS[i]!.label);
      }

      for (const c of fake.calls) {
        expect(c.text.length).toBeLessThanOrEqual(1900);
      }
      expect(published).not.toHaveBeenCalled();
    });

    it('sends header + (no image) as text when photoUrl is null and splits long body into chunks', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      const longSummary = 'S'.repeat(2200);
      const chunk1 = 'Paragraph A. '.repeat(100).trim();
      const chunk2 = 'Paragraph B. '.repeat(100).trim();

      await sendForApproval(
        deps,
        makeCard({
          draftId: id,
          photoUrl: null,
          perspective: { kind: 'tension', summary: longSummary },
          anchor: { tier: null, ref: null },
          body: `${chunk1}\n\n${chunk2}`,
        }),
      );

      expect(fake.api.sendPhoto).not.toHaveBeenCalled();
      expect(fake.calls.map((c) => c.type)).toEqual(['message', 'message', 'message', 'message']);
      expect(fake.calls[0]!.text).toContain(`[${code}] #Test`);
      expect(fake.calls[0]!.text).toContain('…');
      expect(fake.calls[0]!.text).toContain('anchor: none');
      expect(fake.calls[0]!.text.endsWith('\n(no image)')).toBe(true);
      expect(fake.calls[1]!.text).toBe(chunk1);
      expect(fake.calls[2]!.text).toBe(chunk2);
      expect(fake.calls[3]!.text).toContain(`[${code}] Reply: d ${code} publish`);

      for (const c of fake.calls) {
        expect(c.text.length).toBeLessThanOrEqual(1900);
      }
    });

    it('refuses a draft that is not pending', async () => {
      const id = insertDraft(hoursAgo(1), 'approved');
      await expect(sendForApproval(deps, makeCard({ draftId: id }))).rejects.toThrow(/pending/);
      expect(fake.api.sendPhoto).not.toHaveBeenCalled();
      expect(fake.api.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdate security and deduplication', () => {
    it('ignores foreign chats, bot messages, and non-text events with no reply and no state change', async () => {
      const id = insertDraft();
      const code = draftCode(id);

      await handleUpdate(deps, textUpdate(`d ${code}`, { chatId: 'foreign-chat' }));
      await handleUpdate(deps, textUpdate(`d ${code}`, { isBot: true }));
      await handleUpdate(
        deps,
        textUpdate(`d ${code}`, { eventName: 'message.image.received' }),
      );
      await handleUpdate(
        deps,
        textUpdate(`d ${code}`, { eventName: 'message.sticker.received' }),
      );
      await handleUpdate(
        deps,
        textUpdate(`d ${code}`, { eventName: 'message.voice.received' }),
      );
      await handleUpdate(
        deps,
        textUpdate(`d ${code}`, { eventName: 'message.unsupported.received' }),
      );

      expect(published).not.toHaveBeenCalled();
      expect(fake.api.sendMessage).not.toHaveBeenCalled();
      expect(row(id).status).toBe('pending');
    });

    it('acts on a command from the configured chat when the sender has no is_bot field', async () => {
      const id = insertDraft();
      const upd = textUpdate(`a ${draftCode(id)}`);
      delete (upd.message!.from as { is_bot?: boolean }).is_bot;

      await handleUpdate(deps, upd);

      expect(newVisual).toHaveBeenCalledTimes(1);
    });

    it('deduplicates message_id in deps.seen and caps seen at 1000 entries by evicting oldest', async () => {
      for (let i = 1; i <= 1000; i++) {
        deps.seen.add(`old-${i}`);
      }
      const id = insertDraft();
      const code = draftCode(id);
      const upd = textUpdate(`a ${code}`, { messageId: 'dup-msg-1' });

      await handleUpdate(deps, upd);
      await handleUpdate(deps, upd);

      expect(newVisual).toHaveBeenCalledTimes(1);
      expect(fake.api.sendMessage).toHaveBeenCalledTimes(1);
      expect(deps.seen.size).toBe(1000);
      expect(deps.seen.has('old-1')).toBe(false);
      expect(deps.seen.has('old-2')).toBe(true);
      expect(deps.seen.has('dup-msg-1')).toBe(true);
    });
  });

  describe('handleUpdate commands and state transitions', () => {
    it('replies to unknown commands and help commands without touching drafts', async () => {
      const id = insertDraft();

      await handleUpdate(deps, textUpdate('hello there'));
      expect(fake.calls.at(-1)?.text).toBe('Unknown command. Send ? for help.');

      await handleUpdate(deps, textUpdate('?'));
      const helpReply = fake.calls.at(-1)!.text;
      expect(helpReply).toContain('publish');
      expect(helpReply).toContain('rewrite');
      expect(helpReply).toContain('Off voice');
      expect(row(id).status).toBe('pending');
      expect(published).not.toHaveBeenCalled();
    });

    it('handles missing code with 0, 1, or 2+ pending drafts, and unknown explicit code', async () => {
      // 0 pending drafts
      await handleUpdate(deps, textUpdate('d'));
      expect(fake.calls.at(-1)?.text).toBe('No draft is pending');

      // Unknown explicit code
      await handleUpdate(deps, textUpdate('d K7'));
      expect(fake.calls.at(-1)?.text).toBe('No draft K7');

      // 1 pending draft -> targets that draft
      const id1 = insertDraft();
      const code1 = draftCode(id1);
      await handleUpdate(deps, textUpdate('a'));
      expect(newVisual).toHaveBeenCalledWith(id1);
      expect(fake.calls.at(-1)?.text).toBe(`New visual requested for ${code1}`);

      // 2 pending drafts -> prompts for code with a real pending code
      const id2 = insertDraft();
      const code2 = draftCode(id2);
      await handleUpdate(deps, textUpdate('d'));
      const multiReply = fake.calls.at(-1)!.text;
      expect(multiReply).toMatch(/^2 drafts are pending, add the code, for example: d /);
      expect(multiReply.endsWith(code1) || multiReply.endsWith(code2)).toBe(true);
      expect(published).not.toHaveBeenCalled();
    });

    it('expires stale drafts first and replies "CODE is expired"', async () => {
      const id = insertDraft(hoursAgo(7));
      const code = draftCode(id);

      await handleUpdate(deps, textUpdate(`d ${code}`));

      expect(published).not.toHaveBeenCalled();
      expect(row(id).status).toBe('expired');
      expect(fake.calls.at(-1)?.text).toBe(`${code} is expired`);
    });

    it('publishes once, sends "Publishing CODE…" before onPublish, and answers "CODE is approved" on a second publish', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      const order: string[] = [];

      fake.api.sendMessage.mockImplementation(async (_chatId: string, text: string) => {
        order.push(`reply:${text}`);
        return { message_id: 'm' };
      });
      published.mockImplementation(async (draftId: number) => {
        order.push(`onPublish:${draftId}`);
      });

      await handleUpdate(deps, textUpdate(`d ${code}`));
      expect(order).toEqual([
        `reply:Publishing ${code}…`,
        `onPublish:${id}`,
        `reply:Published ${code}`,
      ]);
      expect(row(id).status).toBe('approved');
      expect(row(id).resolved_at).toBe(NOW.toISOString());

      await handleUpdate(deps, textUpdate(`d ${code}`));
      expect(published).toHaveBeenCalledTimes(1);
      expect(order.at(-1)).toBe(`reply:${code} is approved`);
    });

    it('reverts to pending and reports failure when onPublish throws', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      published.mockRejectedValueOnce(new Error('square is down'));

      await handleUpdate(deps, textUpdate(`d ${code}`));

      expect(row(id)).toEqual({ status: 'pending', reject_reason: null, resolved_at: null });
      expect(fake.calls.map((c) => c.text)).toEqual([
        `Publishing ${code}…`,
        `Publish failed for ${code}: square is down`,
      ]);
    });

    it('continues to run onPublish and keeps draft approved even if the reply helper throws', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      fake.api.sendMessage.mockRejectedValue(new Error('zalo network glitch'));

      await handleUpdate(deps, textUpdate(`d ${code}`));

      expect(published).toHaveBeenCalledTimes(1);
      expect(published).toHaveBeenCalledWith(id);
      expect(row(id).status).toBe('approved');
    });

    it('rewrite marks rejected with rewrite-requested, replies before onRewrite, and calls onRewrite', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      const order: string[] = [];
      fake.api.sendMessage.mockImplementation(async (_c: string, text: string) => {
        order.push(`reply:${text}`);
        return {};
      });
      rewritten.mockImplementation(async () => {
        order.push('onRewrite');
      });

      await handleUpdate(deps, textUpdate(`viết lại ${code}`));

      expect(order).toEqual([`reply:Rewriting ${code}`, 'onRewrite']);
      expect(row(id)).toEqual({
        status: 'rejected',
        reject_reason: 'rewrite-requested',
        resolved_at: NOW.toISOString(),
      });
      expect(published).not.toHaveBeenCalled();
    });

    it('newVisual keeps draft pending, replies before onNewVisual, and calls onNewVisual', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      const order: string[] = [];
      fake.api.sendMessage.mockImplementation(async (_c: string, text: string) => {
        order.push(`reply:${text}`);
        return {};
      });
      newVisual.mockImplementation(async () => {
        order.push('onNewVisual');
      });

      await handleUpdate(deps, textUpdate(`a ${code}`));

      expect(order).toEqual([`reply:New visual requested for ${code}`, 'onNewVisual']);
      expect(row(id).status).toBe('pending');
      expect(published).not.toHaveBeenCalled();
    });

    it('reject without reason lists reasons and keeps status pending; reject with reason rejects and calls onReject', async () => {
      const id = insertDraft();
      const code = draftCode(id);

      await handleUpdate(deps, textUpdate(`Bỏ ${code}`));
      expect(row(id).status).toBe('pending');
      expect(rejected).not.toHaveBeenCalled();
      const promptReply = fake.calls.at(-1)!.text;
      expect(promptReply).toContain(`Reply b ${code} <n>`);
      for (const r of REJECT_REASONS) {
        expect(promptReply).toContain(r.label);
      }

      await handleUpdate(deps, textUpdate(`b ${code} 3`));
      expect(row(id)).toEqual({
        status: 'rejected',
        reject_reason: 'facts',
        resolved_at: NOW.toISOString(),
      });
      expect(fake.calls.at(-1)?.text).toBe(`Rejected ${code} (Wrong or unsupported facts)`);
      expect(rejected).toHaveBeenCalledWith(id, 'facts');
      expect(published).not.toHaveBeenCalled();
    });

    it('replies "Error: <message>" and rethrows when a handler throws', async () => {
      const id = insertDraft();
      const code = draftCode(id);
      newVisual.mockRejectedValueOnce(new Error('satori boom'));

      await expect(handleUpdate(deps, textUpdate(`a ${code}`))).rejects.toThrow('satori boom');
      expect(fake.calls.map((c) => c.text)).toEqual([
        `New visual requested for ${code}`,
        'Error: satori boom',
      ]);
    });
  });

  describe('pollOnce and pollLoop', () => {
    it('pollOnce processes all updates and swallows per-update handler errors', async () => {
      const id1 = insertDraft();
      const id2 = insertDraft();
      newVisual.mockRejectedValueOnce(new Error('visual failed'));
      fake.api.getUpdates.mockResolvedValueOnce([
        textUpdate(`a ${draftCode(id1)}`),
        textUpdate(`v ${draftCode(id2)}`),
      ]);

      await pollOnce(deps, 25);

      expect(fake.api.getUpdates).toHaveBeenCalledWith(25);
      expect(rewritten).toHaveBeenCalledWith(id2);
      expect(published).not.toHaveBeenCalled();
    });

    it('pollLoop backs off 5s, 10s, 20s, 40s, 60s, 60s on getUpdates failures and resets after success', async () => {
      const controller = new AbortController();
      const sleeps: number[] = [];
      let callCount = 0;

      fake.api.getUpdates.mockImplementation(async () => {
        callCount += 1;
        if (callCount <= 6) {
          throw new Error('network down');
        }
        if (callCount === 7) {
          return [];
        }
        if (callCount === 8) {
          throw new Error('network down again');
        }
        controller.abort();
        return [];
      });

      const sleep = vi.fn(async (ms: number) => {
        sleeps.push(ms);
        if (sleeps.length === 7) {
          controller.abort();
        }
      });

      await pollLoop(deps, { signal: controller.signal, sleep, timeoutSec: 20 });

      expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 5_000]);
    });
  });
});
