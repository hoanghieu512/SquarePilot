import { describe, expect, it, vi } from 'vitest';
import { ZaloError, createZaloApi, normalizeUpdates } from '../src/deliver/zalo-api.js';

const TOKEN = '999:ZALO-SECRET-TOKEN';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('normalizeUpdates', () => {
  const validUpdate = {
    event_name: 'message.text.received',
    message: {
      from: { id: 'u1', display_name: 'x', is_bot: false },
      chat: { id: 'c1', chat_type: 'PRIVATE' },
      text: 'd K7',
      message_id: 'm1',
      date: 1750316131602,
    },
  };

  it('normalises a single bare update object', () => {
    expect(normalizeUpdates(validUpdate)).toEqual([validUpdate]);
  });

  it('normalises an array of updates and drops malformed items without message.chat.id', () => {
    const raw = [
      validUpdate,
      { event_name: 'weird', message: {} },
      { event_name: 'weird2', message: { chat: {} } },
      null,
      'str',
    ];
    expect(normalizeUpdates(raw)).toEqual([validUpdate]);
  });

  it('normalises an envelope whose result is an object, an array, or missing', () => {
    expect(normalizeUpdates({ ok: true, result: validUpdate })).toEqual([validUpdate]);
    expect(normalizeUpdates({ ok: true, result: [validUpdate] })).toEqual([validUpdate]);
    expect(normalizeUpdates({ ok: true })).toEqual([]);
    expect(normalizeUpdates({ ok: true, result: null })).toEqual([]);
    expect(normalizeUpdates({ ok: false, result: validUpdate })).toEqual([]);
  });

  it('returns empty array for null, undefined, or empty input', () => {
    expect(normalizeUpdates(null)).toEqual([]);
    expect(normalizeUpdates(undefined)).toEqual([]);
    expect(normalizeUpdates([])).toEqual([]);
    expect(normalizeUpdates({})).toEqual([]);
  });
});

describe('createZaloApi', () => {
  it('calls each method with the right URL, POST JSON body, and never sends parse_mode', async () => {
    const f = fakeFetch(200, { ok: true, result: { message_id: 'm1' } });
    const api = createZaloApi({
      token: TOKEN,
      apiBase: 'https://fake.zalo.test/',
      fetchImpl: f as unknown as typeof fetch,
    });

    await api.getMe();
    await api.sendMessage('chat-1', 'hello *world* _test_ #tag $100');
    await api.sendPhoto('chat-1', 'https://img.example.com/a.png', 'cap *1*');
    await api.sendPhoto('chat-1', 'http://img.example.com/b.png');
    await api.setWebhook('https://hook.example.com/zalo', 'sec-123');
    await api.deleteWebhook();
    await api.getWebhookInfo();

    const calls = f.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      rawBody: String(init?.body),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));

    expect(calls[0]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/getMe`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({});

    expect(calls[1]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/sendMessage`);
    expect(calls[1]?.body).toEqual({
      chat_id: 'chat-1',
      text: 'hello *world* _test_ #tag $100',
    });

    expect(calls[2]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/sendPhoto`);
    expect(calls[2]?.body).toEqual({
      chat_id: 'chat-1',
      photo: 'https://img.example.com/a.png',
      caption: 'cap *1*',
    });

    expect(calls[3]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/sendPhoto`);
    expect(calls[3]?.body).toEqual({
      chat_id: 'chat-1',
      photo: 'http://img.example.com/b.png',
    });

    expect(calls[4]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/setWebhook`);
    expect(calls[4]?.body).toEqual({
      url: 'https://hook.example.com/zalo',
      secret_token: 'sec-123',
    });

    expect(calls[5]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/deleteWebhook`);
    expect(calls[5]?.body).toEqual({});

    expect(calls[6]?.url).toBe(`https://fake.zalo.test/bot${TOKEN}/getWebhookInfo`);
    expect(calls[6]?.body).toEqual({});

    for (const c of calls) {
      expect(c.rawBody).not.toContain('parse_mode');
    }
  });

  it('defaults apiBase to https://bot-api.zaloplatforms.com', async () => {
    const f = fakeFetch(200, { ok: true, result: { id: 'bot' } });
    const api = createZaloApi({ token: TOKEN, fetchImpl: f as unknown as typeof fetch });
    await api.getMe();
    expect(String(f.mock.calls[0]?.[0])).toBe(`https://bot-api.zaloplatforms.com/bot${TOKEN}/getMe`);
  });

  it('throws ZaloError with description and errorCode when ok is false on HTTP 200', async () => {
    const f = fakeFetch(200, { ok: false, error_code: 400, description: 'Bad Request: invalid chat_id' });
    const api = createZaloApi({ token: TOKEN, fetchImpl: f as unknown as typeof fetch });

    const err = await api.sendMessage('c1', 'hi').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZaloError);
    expect((err as ZaloError).message).toContain('Bad Request: invalid chat_id');
    expect((err as ZaloError).errorCode).toBe(400);
  });

  it('judges success by ok and never by HTTP status', async () => {
    const f = fakeFetch(500, { ok: true, result: { message_id: 'm9' } });
    const api = createZaloApi({ token: TOKEN, fetchImpl: f as unknown as typeof fetch });
    await expect(api.sendMessage('c1', 'hi')).resolves.toEqual({ message_id: 'm9' });
  });

  it('redacts the token from thrown errors and logs when ok is false or when fetch rejects with the URL', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const f1 = fakeFetch(200, {
        ok: false,
        error_code: 401,
        description: `Invalid token ${TOKEN} at https://bot-api.zaloplatforms.com/bot${TOKEN}/sendMessage`,
      });
      const api1 = createZaloApi({ token: TOKEN, fetchImpl: f1 as unknown as typeof fetch });
      const err1 = (await api1.sendMessage('c1', 'x').catch((e: unknown) => e)) as Error;
      expect(err1).toBeInstanceOf(ZaloError);
      expect(err1.message).not.toContain(TOKEN);
      expect(err1.message).not.toContain('ZALO-SECRET-TOKEN');
      expect(err1.message).toContain('[redacted]');
      expect(String(err1.stack)).not.toContain('ZALO-SECRET-TOKEN');

      const f2 = vi.fn(async (url: string | URL | Request) => {
        throw new Error(`connect ECONNREFUSED for ${String(url)}`);
      });
      const api2 = createZaloApi({ token: TOKEN, fetchImpl: f2 as unknown as typeof fetch });
      const err2 = (await api2.getUpdates(5).catch((e: unknown) => e)) as Error;
      expect(err2).toBeInstanceOf(ZaloError);
      expect(err2.message).not.toContain(TOKEN);
      expect(err2.message).not.toContain('ZALO-SECRET-TOKEN');
      expect(err2.message).toContain('[redacted]');
      expect(String(err2.stack)).not.toContain('ZALO-SECRET-TOKEN');

      for (const call of logSpy.mock.calls) {
        const line = call.map(String).join(' ');
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain('ZALO-SECRET-TOKEN');
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it('getUpdates sends timeout as a string, sets an AbortSignal timeout longer than poll timeout, and normalises result shapes', async () => {
    const singleUpdate = {
      event_name: 'message.text.received',
      message: {
        from: { id: 'u1', display_name: 'x', is_bot: false },
        chat: { id: 'c1', chat_type: 'PRIVATE' },
        text: 'd K7',
        message_id: 'm1',
        date: 1750316131602,
      },
    };
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fSingle = fakeFetch(200, { ok: true, result: singleUpdate });
      const apiSingle = createZaloApi({ token: TOKEN, fetchImpl: fSingle as unknown as typeof fetch });
      const resSingle = await apiSingle.getUpdates(30);
      expect(resSingle).toEqual([singleUpdate]);

      const [, init] = fSingle.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toEqual({ timeout: '30' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(timeoutSpy).toHaveBeenCalledWith(45_000);

      const fArray = fakeFetch(200, { ok: true, result: [singleUpdate] });
      const apiArray = createZaloApi({ token: TOKEN, fetchImpl: fArray as unknown as typeof fetch });
      expect(await apiArray.getUpdates(10)).toEqual([singleUpdate]);

      const fEmpty = fakeFetch(200, { ok: true });
      const apiEmpty = createZaloApi({ token: TOKEN, fetchImpl: fEmpty as unknown as typeof fetch });
      expect(await apiEmpty.getUpdates(10)).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('treats the 408 "Request timeout" of an empty long poll as no updates, not an error', async () => {
    // Observed on the real bot 2026-11-15 whenever a poll ends with no message.
    const f = fakeFetch(200, { ok: false, error_code: 408, description: 'Request timeout' });
    const api = createZaloApi({ token: TOKEN, fetchImpl: f as unknown as typeof fetch });
    await expect(api.getUpdates(30)).resolves.toEqual([]);
  });

  it('still throws other getUpdates errors', async () => {
    const f = fakeFetch(200, { ok: false, error_code: 401, description: 'Unauthorized' });
    const api = createZaloApi({ token: TOKEN, fetchImpl: f as unknown as typeof fetch });
    await expect(api.getUpdates(30)).rejects.toBeInstanceOf(ZaloError);
  });

  it('sendPhoto rejects non-http(s) URLs before making any network call', async () => {
    const f = fakeFetch(200, { ok: true, result: {} });
    const api = createZaloApi({ token: TOKEN, fetchImpl: f as unknown as typeof fetch });

    await expect(api.sendPhoto('c1', 'data:image/png;base64,AAAA')).rejects.toBeInstanceOf(ZaloError);
    await expect(api.sendPhoto('c1', '/tmp/local.png')).rejects.toBeInstanceOf(ZaloError);
    await expect(api.sendPhoto('c1', 'ftp://files.example.com/a.png')).rejects.toBeInstanceOf(ZaloError);
    await expect(api.sendPhoto('c1', '')).rejects.toBeInstanceOf(ZaloError);

    expect(f).not.toHaveBeenCalled();
  });
});
