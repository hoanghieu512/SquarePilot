import { createLogger } from '../utils/logger.js';

const logger = createLogger('telegram');

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface CallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

export interface TelegramApi {
  sendPhoto(chatId: number, png: Buffer, caption: string): Promise<{ message_id: number }>;
  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<{ message_id: number }>;
  editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<void>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getUpdates(offset: number, timeoutSec: number): Promise<Update[]>;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

interface TelegramResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const redact = (text: string): string => (token ? text.split(token).join('[redacted]') : text);

  async function call(method: string, body: JSON_BODY | FormData): Promise<unknown> {
    const isForm = body instanceof FormData;
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        ...(isForm ? {} : { headers: { 'Content-Type': 'application/json' } }),
        body: isForm ? body : JSON.stringify(body),
      });
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      logger.warn(`${method} request failed`, { reason: message });
      throw new TelegramError(`Request to Telegram ${method} failed: ${message}`);
    }

    const raw = (await response.json().catch(() => ({}))) as TelegramResponse;

    if (!response.ok || raw.ok === false) {
      const description = redact(raw.description ?? `HTTP ${response.status}`);
      const code = raw.error_code ?? response.status;
      logger.warn(`${method} rejected`, { code, description });
      throw new TelegramError(`Telegram ${method} failed: ${description}`, code);
    }
    return raw.result;
  }

  return {
    async sendPhoto(chatId, png, caption) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', caption);
      form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'draft.png');
      return (await call('sendPhoto', form)) as { message_id: number };
    },
    async sendMessage(chatId, text, replyMarkup) {
      return (await call('sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      })) as { message_id: number };
    },
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      await call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
    },
    async editMessageText(chatId, messageId, text, replyMarkup) {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },
    async getUpdates(offset, timeoutSec) {
      const result = await call('getUpdates', {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['callback_query'],
      });
      return Array.isArray(result) ? (result as Update[]) : [];
    },
  };
}

type JSON_BODY = Record<string, unknown>;
