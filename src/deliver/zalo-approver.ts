import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import type { ZaloApi, ZaloUpdate } from './zalo-api.js';
import { DRAFT_CODE_ALPHABET, draftCode, parseDraftCode } from './draft-code.js';
import {
  expireStale,
  pendingDraftIds,
  resolve,
  revertRewriteToPending,
  revertToPending,
  statusOf,
} from './approval-store.js';

const logger = createLogger('zalo-approver');

const MAX_MESSAGE = 1900;
const MAX_SEEN = 1000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export const REJECT_REASONS = [
  { number: 1, code: 'voice', label: 'Off voice' },
  { number: 2, code: 'take', label: 'Wrong take' },
  { number: 3, code: 'facts', label: 'Wrong or unsupported facts' },
  { number: 4, code: 'visual', label: 'Bad visual' },
  { number: 5, code: 'timing', label: 'Stale or bad timing' },
  { number: 6, code: 'other', label: 'Other' },
] as const;

export type RejectCode = (typeof REJECT_REASONS)[number]['code'];

export interface DraftCard {
  draftId: number;
  hashtag: string;
  body: string;
  nfc: number;
  nfd: number;
  perspective: { kind: string; summary: string };
  mode: string;
  model: string;
  escalated: boolean;
  gates: Record<string, string>;
  anchor: { tier: string | null; ref: string | null };
  photoUrl: string | null;
}

export interface ApproverDeps {
  api: ZaloApi;
  db: Database.Database;
  chatId: string;
  now(): Date;
  seen: Set<string>;
  /** Resolves with an optional note (the post link) for the confirmation. */
  onPublish(id: number): Promise<string | void>;
  onRewrite(id: number): Promise<void>;
  onNewVisual(id: number): Promise<void>;
  onReject?(id: number, reasonCode: string): Promise<void>;
  /**
   * A reason publishing is unavailable for every draft (a trial run), checked
   * before the draft is touched: the owner gets one plain line instead of
   * "Publishing…" followed by a failure. `onPublish` must still refuse on its own.
   */
  publishBlocked?(): string | null;
  /**
   * The drafts this session offered. When given, commands reach only these:
   * a draft left pending by another run (a dry run, a session that stopped)
   * was never offered here, and a bare "d" must never post it.
   */
  scope?(): ReadonlySet<number>;
  /**
   * Whether the draft's card in the chat changed after `at`. A "d" received
   * before a new card arrived approves the card the owner saw, not the new one.
   */
  cardChangedSince?(draftId: number, at: Date): boolean;
}

export type ParsedCommand =
  | { action: 'help' }
  | { action: 'publish' | 'rewrite' | 'newVisual'; code?: string }
  | { action: 'reject'; code?: string; reason?: RejectCode };

const CODE_RE = new RegExp(`^[${DRAFT_CODE_ALPHABET}]{2,}$`, 'i');

function splitLongParagraph(paragraph: string, max: number): string[] {
  const pieces: string[] = [];
  let rem = paragraph;
  while (rem.length > max) {
    const slice = rem.slice(0, max);
    let cut = -1;

    // 1. Last sentence end followed by whitespace within slice
    const sentenceMatches = [...slice.matchAll(/[.!?…](?=\s)/g)];
    if (sentenceMatches.length > 0) {
      const last = sentenceMatches[sentenceMatches.length - 1]!;
      if (last.index !== undefined && last.index + 1 > 0) {
        cut = last.index + 1;
      }
    }

    // 2. Last whitespace within slice
    if (cut <= 0) {
      const spaceMatch = slice.match(/^([\s\S]*\S)\s+\S*$/);
      if (spaceMatch?.[1]) {
        cut = spaceMatch[1].length;
      }
    }

    // 3. Hard cut at max
    if (cut <= 0) {
      pieces.push(rem.slice(0, max));
      rem = rem.slice(max);
    } else {
      pieces.push(rem.slice(0, cut));
      rem = rem.slice(cut).replace(/^\s+/, '');
    }
  }
  if (rem.length > 0) {
    pieces.push(rem);
  }
  return pieces;
}

export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];

  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > max) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      const pieces = splitLongParagraph(para, max);
      for (let i = 0; i < pieces.length - 1; i++) {
        chunks.push(pieces[i]!);
      }
      current = pieces[pieces.length - 1] ?? '';
      continue;
    }

    if (current.length === 0) {
      current = para;
    } else if (current.length + 2 + para.length <= max) {
      current = `${current}\n\n${para}`;
    } else {
      chunks.push(current);
      current = para;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function formatReasonsLine(): string {
  return REJECT_REASONS.map((r) => `${r.number} ${r.label}`).join(' · ');
}

function formatHeader(card: DraftCard, code: string, maxLen: number): string {
  const tag = card.hashtag.startsWith('#') ? card.hashtag : `#${card.hashtag}`;
  const gatesText = Object.entries(card.gates)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const anchor =
    card.anchor.tier === null && card.anchor.ref === null
      ? 'anchor: none'
      : `anchor: ${[card.anchor.tier, card.anchor.ref].filter((p) => p !== null).join(' ')}`;

  const build = (summary: string): string =>
    [
      `[${code}] ${tag}`,
      `NFC ${card.nfc} / NFD ${card.nfd}`,
      `${card.perspective.kind}: ${summary}`,
      card.mode,
      `${card.model}${card.escalated ? ' (escalated)' : ''}`,
      `gates: ${gatesText}`,
      anchor,
    ].join('\n');

  const full = build(card.perspective.summary);
  if (full.length <= maxLen) return full;

  const excess = full.length - maxLen;
  const keep = Math.max(0, card.perspective.summary.length - excess - 1);
  const shortened = build(`${card.perspective.summary.slice(0, keep)}…`);
  if (shortened.length <= maxLen) return shortened;
  return `${shortened.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * One command per line, the command first and its meaning after a dot. The
 * first footer put both on one line ("a K7 new visual"), and the owner
 * reasonably copied the whole phrase; `parseCommand` now accepts that too.
 */
function formatCommandLines(code: string): string[] {
  return [
    `d ${code} · publish`,
    `v ${code} · rewrite`,
    `a ${code} · new visual`,
    `b ${code} 1-6 · reject, with a reason:`,
    formatReasonsLine(),
  ];
}

function formatFooter(code: string): string {
  return [`[${code}] Reply with one of:`, ...formatCommandLines(code)].join('\n');
}

export async function sendForApproval(
  deps: ApproverDeps,
  card: DraftCard,
  hooks: {
    /** Called once the card's image is in the chat, even if the text after it fails. */
    photoSent?(): void;
  } = {},
): Promise<void> {
  const status = statusOf(deps.db, card.draftId);
  if (status !== 'pending') {
    throw new Error(
      `Draft #${card.draftId} is ${status ?? 'missing'}, only a pending draft can be sent for approval`,
    );
  }

  const code = draftCode(card.draftId);
  const noImageSuffix = '\n(no image)';
  const headerBudget = card.photoUrl ? MAX_MESSAGE : MAX_MESSAGE - noImageSuffix.length;
  const header = formatHeader(card, code, headerBudget);

  if (card.photoUrl) {
    await deps.api.sendPhoto(deps.chatId, card.photoUrl, header);
    hooks.photoSent?.();
  } else {
    await deps.api.sendMessage(deps.chatId, `${header}${noImageSuffix}`);
  }

  for (const chunk of splitMessage(card.body, MAX_MESSAGE)) {
    await deps.api.sendMessage(deps.chatId, chunk);
  }

  await deps.api.sendMessage(deps.chatId, formatFooter(code));
}

function normalizeVerbToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

/** The words the footer prints after each command, as they may be copied back. */
const ACTION_LABELS: Record<'publish' | 'rewrite' | 'newVisual' | 'reject', string[]> = {
  publish: ['publish'],
  rewrite: ['rewrite'],
  newVisual: ['new', 'visual'],
  reject: ['reject'],
};

/** What the footer puts between a command and its label. */
const LABEL_SEPARATORS = new Set(['·', '-', ':']);

/**
 * Drop a copied footer label from the end of a command: "a K7 new visual",
 * "d K7 · publish", "b K7 3 reject". Strict on purpose, because a loose match
 * turned questions into publishes ("Đang publish?" parsed as "d"):
 * - the label must follow something (the code), never stand alone;
 * - its words must match exactly, with no punctuation attached;
 * - only one footer separator may sit between the code and the label.
 */
function stripActionLabel(rest: string[], label: string[]): string[] {
  if (rest.length <= label.length) return rest;
  const tail = rest.slice(rest.length - label.length).map(normalizeVerbToken);
  if (!tail.every((word, k) => word === label[k])) return rest;
  let end = rest.length - label.length;
  if (end > 1 && LABEL_SEPARATORS.has(rest[end - 1]!)) end -= 1;
  return rest.slice(0, end);
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const rawTokens = trimmed.split(/\s+/);
  const v0 = normalizeVerbToken(rawTokens[0]!);

  if (rawTokens.length === 1 && (v0 === '?' || v0 === 'help')) {
    return { action: 'help' };
  }

  const v1 = rawTokens[1] !== undefined ? normalizeVerbToken(rawTokens[1]) : undefined;
  let action: 'publish' | 'rewrite' | 'newVisual' | 'reject' | null = null;
  let idx = 0;

  if (v0 === 'viet' && v1 === 'lai') {
    action = 'rewrite';
    idx = 2;
  } else if (v0 === 'doi' && v1 === 'anh') {
    action = 'newVisual';
    idx = 2;
  } else if (v0 === 'd' || v0 === 'dang') {
    action = 'publish';
    idx = 1;
  } else if (v0 === 'v' || v0 === 'viet') {
    action = 'rewrite';
    idx = 1;
  } else if (v0 === 'a' || v0 === 'anh') {
    action = 'newVisual';
    idx = 1;
  } else if (v0 === 'b' || v0 === 'bo') {
    action = 'reject';
    idx = 1;
  } else {
    return null;
  }

  const rest = stripActionLabel(rawTokens.slice(idx), ACTION_LABELS[action]);
  if (rest.length === 0) {
    return { action };
  }

  if (action !== 'reject') {
    if (rest.length !== 1) return null;
    const rawCode = rest[0]!.toLowerCase();
    if (!CODE_RE.test(rawCode)) return null;
    return { action, code: rawCode.toUpperCase() };
  }

  // Reject grammar: b [code] [reason digit]
  if (rest.length === 1) {
    const arg = rest[0]!.toLowerCase();
    if (/^[1-6]$/.test(arg)) {
      const reason = REJECT_REASONS[Number(arg) - 1]!.code;
      return { action: 'reject', reason };
    }
    if (CODE_RE.test(arg)) {
      return { action: 'reject', code: arg.toUpperCase() };
    }
    return null;
  }

  if (rest.length === 2) {
    const [rawCodeToken, rawReason] = rest as [string, string];
    const rawCode = rawCodeToken.toLowerCase();
    if (!CODE_RE.test(rawCode) || !/^[1-6]$/.test(rawReason)) return null;
    const reason = REJECT_REASONS[Number(rawReason) - 1]!.code;
    return { action, code: rawCode.toUpperCase(), reason };
  }

  return null;
}

async function reply(deps: ApproverDeps, text: string): Promise<void> {
  try {
    await deps.api.sendMessage(deps.chatId, text);
  } catch (err) {
    logger.warn('Could not send Zalo reply', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function formatHelpMessage(): string {
  return [
    'Commands (CODE is the draft code, e.g. K7; leave it out when one draft is pending):',
    ...formatCommandLines('CODE'),
    '? · this help',
  ].join('\n');
}

/** `receivedAt`: when the poll that carried the update returned. */
export async function handleUpdate(deps: ApproverDeps, update: ZaloUpdate, receivedAt?: Date): Promise<void> {
  const msg = update.message;
  if (!msg) return;

  // Only an explicit is_bot: true is refused. The field is documented but not
  // yet observed on this bot, and treating a missing field as "bot" would
  // silently drop every command from the owner's private chat.
  if (msg.chat?.id !== deps.chatId || msg.from?.is_bot === true) {
    logger.warn('Ignored update from unauthorised chat or bot', {
      chatId: msg.chat?.id,
      isBot: msg.from?.is_bot,
    });
    return;
  }

  if (update.event_name !== 'message.text.received' || typeof msg.text !== 'string') {
    return;
  }

  if (msg.message_id) {
    if (deps.seen.has(msg.message_id)) return;
    deps.seen.add(msg.message_id);
    while (deps.seen.size > MAX_SEEN) {
      const oldest = deps.seen.values().next().value;
      if (oldest === undefined) break;
      deps.seen.delete(oldest);
    }
  }

  try {
    const parsed = parseCommand(msg.text);
    if (!parsed) {
      await reply(deps, `Unknown command.\n${formatHelpMessage()}`);
      return;
    }

    if (parsed.action === 'help') {
      await reply(deps, formatHelpMessage());
      return;
    }

    const expired = expireStale(deps.db, deps.now());

    let draftId: number;
    let code: string;
    let status: string | null;

    if (parsed.code !== undefined) {
      code = parsed.code;
      const decoded = parseDraftCode(code);
      status = decoded === null ? null : statusOf(deps.db, decoded);
      if (decoded === null || status === null) {
        await reply(deps, `No draft ${code}`);
        return;
      }
      if (deps.scope && !deps.scope().has(decoded)) {
        await reply(deps, `${code} is not part of this run`);
        return;
      }
      draftId = decoded;
    } else {
      const scope = deps.scope?.();
      const pending = pendingDraftIds(deps.db).filter((id) => !scope || scope.has(id));
      if (expired.length > 0) {
        const example = pending.length > 0 ? `, for example: d ${draftCode(pending[0]!)}` : '';
        await reply(deps, `Some drafts just expired. Send the command with a code${example}`);
        return;
      }
      if (pending.length === 0) {
        await reply(deps, 'No draft is pending');
        return;
      }
      // After a rewrite the chat holds more than one draft, and a bare
      // command sent before the replacement arrived meant the old one.
      if (scope && scope.size > 1) {
        await reply(
          deps,
          `This run has offered more than one draft. Add the code, for example: d ${draftCode(pending[pending.length - 1]!)}`,
        );
        return;
      }
      if (pending.length >= 2) {
        const exampleCode = draftCode(pending[0]!);
        await reply(
          deps,
          `${pending.length} drafts are pending, add the code, for example: d ${exampleCode}`,
        );
        return;
      }
      draftId = pending[0]!;
      code = draftCode(draftId);
      status = 'pending';
    }

    if (status !== 'pending') {
      await reply(deps, `${code} is ${status}`);
      return;
    }

    switch (parsed.action) {
      case 'publish': {
        const blocked = deps.publishBlocked?.() ?? null;
        if (blocked) {
          await reply(deps, `${code}: ${blocked}`);
          return;
        }
        if (receivedAt && deps.cardChangedSince?.(draftId, receivedAt)) {
          await reply(deps, `${code} has a new card since your message. Check it, then send d ${code} again.`);
          return;
        }
        if (!resolve(deps.db, deps.now(), draftId, 'approved', null)) {
          await reply(deps, `${code} is not pending`);
          return;
        }
        await reply(deps, `Publishing ${code}…`);
        let note: string | void;
        try {
          note = await deps.onPublish(draftId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // The post may be live: putting the draft back on the queue would
          // let the next "d" post it twice. It stays approved, for a person
          // to check against the account.
          if ((err as { uncertain?: unknown }).uncertain === true) {
            await reply(deps, `${code} may or may not be posted: ${message}. It will not be offered again.`);
            return;
          }
          revertToPending(deps.db, draftId);
          await reply(deps, `Publish failed for ${code}: ${message}`);
          return;
        }
        await reply(deps, note ? `Published ${code}: ${note}` : `Published ${code}`);
        return;
      }
      case 'rewrite': {
        if (!resolve(deps.db, deps.now(), draftId, 'rejected', 'rewrite-requested')) {
          await reply(deps, `${code} is not pending`);
          return;
        }
        await reply(deps, `Rewriting ${code}`);
        try {
          await deps.onRewrite(draftId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          revertRewriteToPending(deps.db, draftId);
          await reply(deps, `Rewrite failed for ${code}: ${message}`);
          return;
        }
        return;
      }
      case 'newVisual': {
        await reply(deps, `New visual requested for ${code}`);
        await deps.onNewVisual(draftId);
        return;
      }
      case 'reject': {
        if (!parsed.reason) {
          await reply(deps, `${formatReasonsLine()}\nReply b ${code} <n>`);
          return;
        }
        const entry = REJECT_REASONS.find((r) => r.code === parsed.reason)!;
        if (!resolve(deps.db, deps.now(), draftId, 'rejected', entry.code)) {
          await reply(deps, `${code} is not pending`);
          return;
        }
        await reply(deps, `Rejected ${code} (${entry.label})`);
        await deps.onReject?.(draftId, entry.code);
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reply(deps, `Error: ${message}`);
    throw err;
  }
}

export async function pollOnce(deps: ApproverDeps, timeoutSec = 30): Promise<void> {
  const updates = await deps.api.getUpdates(timeoutSec);
  for (const update of updates) {
    try {
      await handleUpdate(deps, update);
    } catch (err) {
      logger.error('Zalo update failed', {
        messageId: update.message?.message_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export interface PollLoopOptions {
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  timeoutSec?: number;
  /**
   * Runs after every poll, queued behind the commands from that poll so it
   * never sees a command half done (a draft between "approved" and
   * "published", or a rewrite whose replacement does not exist yet). Return
   * true to end the loop.
   */
  onCycle?: () => Promise<boolean | void>;
}

export async function pollLoop(deps: ApproverDeps, options: PollLoopOptions): Promise<void> {
  const { signal, timeoutSec = 30 } = options;

  // One switch for both ways to stop: the caller aborting, or onCycle saying
  // done. It also cancels the long poll in flight, so stopping takes effect
  // now instead of up to `timeoutSec` later.
  const stop = new AbortController();
  const onCallerAbort = (): void => stop.abort();
  if (signal.aborted) stop.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const timer = setTimeout(r, ms);
        stop.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            r();
          },
          { once: true },
        );
      }));

  let backoffMs = INITIAL_BACKOFF_MS;
  let queue: Promise<void> = Promise.resolve();

  const scheduleCycle = (): void => {
    const onCycle = options.onCycle;
    if (!onCycle) return;
    queue = queue.then(async () => {
      // Polls keep coming while a long command runs, so several cycles can be
      // queued behind it. Once one has said stop, the rest have nothing to add.
      if (stop.signal.aborted) return;
      try {
        if ((await onCycle()) === true) stop.abort();
      } catch (err) {
        logger.error('Zalo poll cycle check failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  try {
    while (!stop.signal.aborted) {
      let updates: ZaloUpdate[];
      try {
        updates = await deps.api.getUpdates(timeoutSec, stop.signal);
        backoffMs = INITIAL_BACKOFF_MS;
      } catch (err) {
        if (stop.signal.aborted) break;
        logger.warn('Zalo pollOnce failed, backing off', {
          backoffMs,
          reason: err instanceof Error ? err.message : String(err),
        });
        await sleep(backoffMs);
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
        scheduleCycle();
        continue;
      }

      const receivedAt = deps.now();
      for (const update of updates) {
        queue = queue.then(async () => {
          try {
            await handleUpdate(deps, update, receivedAt);
          } catch (err) {
            logger.error('Zalo update failed', {
              messageId: update.message?.message_id,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
      scheduleCycle();
    }
    await queue;
  } finally {
    signal.removeEventListener('abort', onCallerAbort);
  }
}
