import { readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import type { InlineKeyboardMarkup, TelegramApi, Update } from './telegram-api.js';

const logger = createLogger('approver');

const MAX_MESSAGE = 4096;
const MAX_CAPTION = 1024;
const DEFAULT_TTL_HOURS = 6;

export interface DraftCard {
  draftId: number;
  hashtag: string;
  body: string;
  nfc: number;
  nfd: number;
  perspective: { kind: 'angle' | 'lens' | 'tension'; summary: string };
  mode: string;
  model: string;
  escalated: boolean;
  gates: { tone: string; shape: string; persona: string };
  anchor: { tier: string | null; ref: string | null };
  pngPath: string;
}

export interface ApproverDeps {
  api: TelegramApi;
  db: Database.Database;
  chatId: number;
  allowedUserIds: number[];
  now: () => Date;
  onPublish(draftId: number): Promise<void>;
  onRewrite(draftId: number): Promise<void>;
  onNewVisual(draftId: number): Promise<void>;
  onReject?(draftId: number, reasonCode: string): Promise<void>;
}

export const REJECT_REASONS = [
  { code: 'voice', label: 'Off voice' },
  { code: 'take', label: 'Wrong take' },
  { code: 'facts', label: 'Wrong or unsupported facts' },
  { code: 'visual', label: 'Bad visual' },
  { code: 'timing', label: 'Stale or bad timing' },
  { code: 'other', label: 'Other' },
] as const;

export type RejectCode = (typeof REJECT_REASONS)[number]['code'];

export function formatCardText(card: DraftCard): string {
  const anchor =
    card.anchor.tier === null && card.anchor.ref === null
      ? 'anchor: none'
      : `anchor: ${[card.anchor.tier, card.anchor.ref].filter((p) => p !== null).join(' ')}`;
  const meta = [
    card.hashtag,
    `NFC ${card.nfc} / NFD ${card.nfd}`,
    `${card.perspective.kind}: ${card.perspective.summary}`,
    card.mode,
    `${card.model}${card.escalated ? ' (escalated)' : ''}`,
    `gates: tone ${card.gates.tone} · shape ${card.gates.shape} · persona ${card.gates.persona}`,
    anchor,
    `draft #${card.draftId}`,
  ].join('\n');

  // Strictly under the limit, so there is never an off-by-one at the boundary.
  const budget = MAX_MESSAGE - 1 - meta.length - 2;
  const body = card.body.length > budget ? `${card.body.slice(0, Math.max(0, budget - 1))}…` : card.body;
  return `${body}\n\n${meta}`;
}

export function approvalKeyboard(draftId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Publish', callback_data: `p:${draftId}` },
        { text: 'Rewrite', callback_data: `w:${draftId}` },
        { text: 'New visual', callback_data: `v:${draftId}` },
        { text: 'Reject', callback_data: `x:${draftId}` },
      ],
    ],
  };
}

export function rejectKeyboard(draftId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...REJECT_REASONS.map((r) => [{ text: r.label, callback_data: `r:${draftId}:${r.code}` }]),
      [{ text: 'Back', callback_data: `b:${draftId}` }],
    ],
  };
}

export type ParsedCallback =
  | { action: 'publish' | 'rewrite' | 'newVisual' | 'rejectMenu' | 'back'; draftId: number }
  | { action: 'reject'; draftId: number; reason: RejectCode };

const SIMPLE_ACTIONS = {
  p: 'publish',
  w: 'rewrite',
  v: 'newVisual',
  x: 'rejectMenu',
  b: 'back',
} as const;

export function parseCallback(data: string): ParsedCallback | null {
  const parts = data.split(':');
  const code = parts[0];
  const idText = parts[1];
  if (code === undefined || idText === undefined || !/^\d+$/.test(idText)) return null;
  const draftId = Number(idText);
  if (!Number.isSafeInteger(draftId)) return null;

  if (code === 'r') {
    if (parts.length !== 3) return null;
    const reason = REJECT_REASONS.find((r) => r.code === parts[2]);
    return reason ? { action: 'reject', draftId, reason: reason.code } : null;
  }
  if (parts.length !== 2 || !(code in SIMPLE_ACTIONS)) return null;
  return { action: SIMPLE_ACTIONS[code as keyof typeof SIMPLE_ACTIONS], draftId };
}

function statusOf(db: Database.Database, draftId: number): string | null {
  const r = db.prepare('SELECT status FROM drafts WHERE id = ?').get(draftId) as
    | { status: string }
    | undefined;
  return r?.status ?? null;
}

export async function sendForApproval(deps: ApproverDeps, card: DraftCard): Promise<void> {
  const status = statusOf(deps.db, card.draftId);
  if (status !== 'pending') {
    throw new Error(`Draft #${card.draftId} is ${status ?? 'missing'}, only a pending draft can be sent for approval`);
  }
  const png = await readFile(card.pngPath);
  let caption = `${card.hashtag} · draft #${card.draftId}`;
  if (caption.length > MAX_CAPTION) caption = `${caption.slice(0, MAX_CAPTION - 1)}…`;

  await deps.api.sendPhoto(deps.chatId, png, caption);
  await deps.api.sendMessage(deps.chatId, formatCardText(card), approvalKeyboard(card.draftId));
}

export function expireStale(db: Database.Database, now: Date, ttlHours = DEFAULT_TTL_HOURS): number[] {
  const cutoff = now.getTime() - ttlHours * 3600_000;
  const pending = db.prepare(`SELECT id, created_at FROM drafts WHERE status = 'pending'`).all() as {
    id: number;
    created_at: string;
  }[];
  const stale = pending.filter((d) => {
    const t = Date.parse(d.created_at);
    return Number.isFinite(t) && t < cutoff;
  });
  const update = db.prepare(
    `UPDATE drafts SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'`,
  );
  const expired: number[] = [];
  db.transaction(() => {
    for (const d of stale) {
      if (update.run(now.toISOString(), d.id).changes === 1) expired.push(d.id);
    }
  })();
  return expired;
}

function resolve(
  deps: ApproverDeps,
  draftId: number,
  status: 'approved' | 'rejected',
  reason: string | null,
): boolean {
  const info = deps.db
    .prepare(
      `UPDATE drafts SET status = ?, reject_reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    )
    .run(status, reason, deps.now().toISOString(), draftId);
  return info.changes === 1;
}

export async function handleUpdate(deps: ApproverDeps, update: Update): Promise<void> {
  const query = update.callback_query;
  if (!query) return;

  let answered = false;
  const answer = async (text?: string): Promise<void> => {
    if (answered) return;
    answered = true;
    try {
      await deps.api.answerCallbackQuery(query.id, text);
    } catch (err) {
      // A failed answer must never skip or undo the action.
      logger.warn('Could not answer callback query', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    const chat = query.message?.chat.id;
    if (chat !== deps.chatId || !deps.allowedUserIds.includes(query.from.id)) {
      logger.warn('Ignored callback from an unauthorised chat or user');
      await answer('Not allowed');
      return;
    }

    const parsed = query.data === undefined ? null : parseCallback(query.data);
    if (!parsed) {
      await answer('Unknown action');
      return;
    }

    const { draftId } = parsed;
    expireStale(deps.db, deps.now());
    const status = statusOf(deps.db, draftId);
    if (status !== 'pending') {
      await answer(`Draft is ${status ?? 'missing'}`);
      return;
    }

    const messageId = query.message!.message_id;
    const setKeyboard = async (markup: InlineKeyboardMarkup | null): Promise<void> => {
      try {
        await deps.api.editMessageReplyMarkup(deps.chatId, messageId, markup);
      } catch (err) {
        logger.warn('Could not update keyboard', { reason: err instanceof Error ? err.message : String(err) });
      }
    };

    switch (parsed.action) {
      case 'publish': {
        if (!resolve(deps, draftId, 'approved', null)) {
          await answer('Draft is not pending');
          return;
        }
        // Answer first: publishing can take long enough for Telegram to expire the query.
        await answer('Publishing…');
        try {
          await deps.onPublish(draftId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.db
            .prepare(
              `UPDATE drafts SET status = 'pending', resolved_at = NULL WHERE id = ? AND status = 'approved'`,
            )
            .run(draftId);
          await deps.api.sendMessage(deps.chatId, `Publish failed for draft #${draftId}: ${message}`);
          return;
        }
        await setKeyboard(null);
        await deps.api.sendMessage(deps.chatId, `Published draft #${draftId}`);
        return;
      }
      case 'rewrite': {
        if (!resolve(deps, draftId, 'rejected', 'rewrite-requested')) {
          await answer('Draft is not pending');
          return;
        }
        await answer('Rewriting…');
        await setKeyboard(null);
        await deps.onRewrite(draftId);
        return;
      }
      case 'newVisual':
        await answer('New visual requested');
        await deps.onNewVisual(draftId);
        return;
      case 'rejectMenu':
        await setKeyboard(rejectKeyboard(draftId));
        await answer();
        return;
      case 'back':
        await setKeyboard(approvalKeyboard(draftId));
        await answer();
        return;
      case 'reject': {
        if (!resolve(deps, draftId, 'rejected', parsed.reason)) {
          await answer('Draft is not pending');
          return;
        }
        await setKeyboard(null);
        await answer('Rejected');
        await deps.onReject?.(draftId, parsed.reason);
        return;
      }
    }
  } catch (err) {
    // Never leave the button spinning, then let the caller log the failure.
    await answer('Error').catch(() => {});
    throw err;
  }
}

export async function pollOnce(deps: ApproverDeps, offset: number): Promise<number> {
  const updates = await deps.api.getUpdates(offset, 30);
  let next = offset;
  for (const update of updates) {
    next = Math.max(next, update.update_id + 1);
    try {
      await handleUpdate(deps, update);
    } catch (err) {
      logger.error(`Update ${update.update_id} failed`, {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return next;
}
