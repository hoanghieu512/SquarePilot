import { describe, expect, it, vi } from 'vitest';
import { TelegramError, createTelegramApi } from '../src/deliver/telegram-api.js';

const TOKEN = '123:SECRET-TOKEN';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('createTelegramApi', () => {
  it('posts JSON to the bot method url', async () => {
    const f = fakeFetch(200, { ok: true, result: { message_id: 7 } });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);

    const res = await api.sendMessage(5, 'hello', { inline_keyboard: [] });

    expect(res.message_id).toBe(7);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: 5,
      text: 'hello',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('sendPhoto posts multipart with a "photo" field', async () => {
    const f = fakeFetch(200, { ok: true, result: { message_id: 1 } });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);

    await api.sendPhoto(5, Buffer.from([1, 2, 3]), 'cap');

    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain('/sendPhoto');
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const photo = form.get('photo') as File;
    expect(photo.name).toBe('draft.png');
    expect(form.get('caption')).toBe('cap');
    expect(form.get('chat_id')).toBe('5');
  });

  it('throws TelegramError with description and error_code on ok:false', async () => {
    const f = fakeFetch(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);

    const err = await api.sendMessage(1, 'x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).message).toContain('chat not found');
    expect((err as TelegramError).errorCode).toBe(400);
  });

  it('throws on ok:false even with HTTP 200', async () => {
    const f = fakeFetch(200, { ok: false, error_code: 403, description: 'Forbidden' });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);
    await expect(api.answerCallbackQuery('id')).rejects.toBeInstanceOf(TelegramError);
  });

  it('never leaks the token in an error message', async () => {
    const f = fakeFetch(401, { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);
    const err = (await api.sendMessage(1, 'x').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(err)).not.toContain('SECRET-TOKEN');
    expect(String(err.stack)).not.toContain('SECRET-TOKEN');
  });

  it('redacts the token from network failures', async () => {
    const f = vi.fn(async () => {
      throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`);
    });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);
    const err = (await api.getUpdates(0, 1).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).not.toContain('SECRET-TOKEN');
  });

  it('getUpdates passes offset and timeout and returns the result array', async () => {
    const f = fakeFetch(200, { ok: true, result: [{ update_id: 3 }] });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);

    const updates = await api.getUpdates(3, 30);

    expect(updates).toEqual([{ update_id: 3 }]);
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ offset: 3, timeout: 30 });
  });

  it('editMessageReplyMarkup with null sends an empty keyboard', async () => {
    const f = fakeFetch(200, { ok: true, result: true });
    const api = createTelegramApi(TOKEN, f as unknown as typeof fetch);
    await api.editMessageReplyMarkup(1, 2, null);
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body)) as { reply_markup: unknown };
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });
});
