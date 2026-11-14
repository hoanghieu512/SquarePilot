import { createLogger } from '../utils/logger.js';

const logger = createLogger('zalo');

const DEFAULT_API_BASE = 'https://bot-api.zaloplatforms.com';
const POLL_TIMEOUT_BUFFER_SEC = 15;

/**
 * Observed 2026-11-15 on the approval bot: a long poll that ends with no
 * message comes back as {"ok":false,"error_code":408,"description":"Request
 * timeout"}. That is an empty poll, not a failure. Treating it as a failure
 * made the poll loop back off for up to a minute, and with no offset on
 * getUpdates any message sent during the back-off is lost for good.
 */
const EMPTY_POLL_CODE = 408;

export interface ZaloMessage {
  message_id: string;
  date?: number;
  chat: { id: string; chat_type?: string };
  from?: { id: string; display_name?: string; is_bot?: boolean };
  text?: string;
}

export interface ZaloUpdate {
  event_name?: string;
  message?: ZaloMessage;
}

export interface ZaloApi {
  getMe(): Promise<unknown>;
  sendMessage(chatId: string, text: string): Promise<unknown>;
  sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<unknown>;
  getUpdates(timeoutSec: number): Promise<ZaloUpdate[]>;
  setWebhook(url: string, secretToken: string): Promise<unknown>;
  deleteWebhook(): Promise<unknown>;
  getWebhookInfo(): Promise<unknown>;
}

export interface ZaloApiOptions {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class ZaloError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = 'ZaloError';
  }
}

interface ZaloResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

function isUpdateWithChatId(item: unknown): item is ZaloUpdate {
  if (typeof item !== 'object' || item === null) return false;
  const msg = (item as { message?: unknown }).message;
  if (typeof msg !== 'object' || msg === null) return false;
  const chat = (msg as { chat?: unknown }).chat;
  if (typeof chat !== 'object' || chat === null) return false;
  const id = (chat as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0;
}

export function normalizeUpdates(raw: unknown): ZaloUpdate[] {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return [];
  }

  let payload: unknown = raw;
  if (!Array.isArray(raw) && ('ok' in raw || 'result' in raw) && !('message' in raw)) {
    const env = raw as ZaloResponse;
    if (env.ok === false) return [];
    payload = env.result;
  }

  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return [];
  }

  const candidates = Array.isArray(payload) ? payload : [payload];
  return candidates.filter(isUpdateWithChatId);
}

export function createZaloApi({
  token,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = fetch,
}: ZaloApiOptions): ZaloApi {
  const base = apiBase.replace(/\/+$/, '');
  const redact = (text: string): string => (token ? text.split(token).join('[redacted]') : text);

  async function call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    quietCodes: number[] = [],
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      logger.warn(`${method} request failed`, { reason: message });
      throw new ZaloError(`Request to Zalo ${method} failed: ${message}`);
    }

    const raw = (await response.json().catch(() => ({}))) as ZaloResponse;

    if (raw.ok !== true) {
      const description = redact(raw.description ?? `HTTP ${response.status}`);
      const code = raw.error_code;
      if (code === undefined || !quietCodes.includes(code)) {
        logger.warn(`${method} rejected`, { code, description });
      }
      throw new ZaloError(`Zalo ${method} failed: ${description}`, code);
    }
    return raw.result;
  }

  return {
    async getMe() {
      return await call('getMe', {});
    },
    async sendMessage(chatId, text) {
      return await call('sendMessage', {
        chat_id: chatId,
        text,
      });
    },
    async sendPhoto(chatId, photoUrl, caption) {
      if (!/^https?:\/\//i.test(photoUrl)) {
        throw new ZaloError('sendPhoto requires an http:// or https:// photoUrl');
      }
      return await call('sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        ...(caption !== undefined ? { caption } : {}),
      });
    },
    async getUpdates(timeoutSec) {
      const signal = AbortSignal.timeout(
        (Math.max(0, timeoutSec) + POLL_TIMEOUT_BUFFER_SEC) * 1000,
      );
      try {
        const result = await call('getUpdates', { timeout: String(timeoutSec) }, signal, [EMPTY_POLL_CODE]);
        return normalizeUpdates(result);
      } catch (err) {
        if (err instanceof ZaloError && err.errorCode === EMPTY_POLL_CODE) return [];
        throw err;
      }
    },
    async setWebhook(url, secretToken) {
      return await call('setWebhook', {
        url,
        secret_token: secretToken,
      });
    },
    async deleteWebhook() {
      return await call('deleteWebhook', {});
    },
    async getWebhookInfo() {
      return await call('getWebhookInfo', {});
    },
  };
}
