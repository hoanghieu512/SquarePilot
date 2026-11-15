import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SquareError, createSquareClient, resolveSquareKey } from '../src/client/square-client.js';

const KEY = 'sq-test-key-123456';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Routes by URL suffix; each route returns the next queued response. */
function fakeFetch(routes: Record<string, Response[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const key = Object.keys(routes).find((k) => u.endsWith(k) || u.startsWith(k));
    const queue = key ? routes[key]! : [];
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${u}`);
    return next;
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

const noSleep = async () => {};

describe('resolveSquareKey', () => {
  it('prefers the environment variable', () => {
    expect(resolveSquareKey({ BINANCE_SQUARE_OPENAPI_KEY: ` ${KEY} ` }, '/nonexistent')).toBe(KEY);
  });

  it('falls back to the key file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sq-'));
    const file = join(dir, 'openapi-key');
    writeFileSync(file, `${KEY}\n`);
    expect(resolveSquareKey({}, file)).toBe(KEY);
  });

  it('throws a message naming the file, never a key, when nothing is configured', () => {
    expect(() => resolveSquareKey({}, '/nonexistent/openapi-key')).toThrow(/\/nonexistent\/openapi-key/);
  });
});

describe('uploadImage', () => {
  it('presigns, PUTs the PNG, polls until processed and returns the image URL', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/image/presignedUrl': [json({ code: '000000', data: { presignedUrl: 'https://s3.example/put?sig=1', fileTicket: 't1' } })],
      'https://s3.example/put': [new Response(null, { status: 200 })],
      '/image/imageStatus': [
        json({ code: '000000', data: { status: 0 } }),
        json({ code: '000000', data: { status: 1, imageUrl: 'https://img.example/card.png' } }),
      ],
    });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });

    const url = await client.uploadImage(Buffer.from([137, 80, 78, 71]), 'card.png');

    expect(url).toBe('https://img.example/card.png');
    const presign = calls[0]!;
    expect((presign.init.headers as Record<string, string>)['X-Square-OpenAPI-Key']).toBe(KEY);
    expect(JSON.parse(String(presign.init.body))).toEqual({ imageName: 'card.png' });
    const put = calls[1]!;
    expect(put.init.method).toBe('PUT');
    expect((put.init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect((put.init.headers as Record<string, string>)['X-Square-OpenAPI-Key']).toBeUndefined();
    expect(calls).toHaveLength(4);
  });

  it('fails when processing fails', async () => {
    const { fetchImpl } = fakeFetch({
      '/image/presignedUrl': [json({ code: '000000', data: { presignedUrl: 'https://s3.example/put', fileTicket: 't1' } })],
      'https://s3.example/put': [new Response(null, { status: 200 })],
      '/image/imageStatus': [json({ code: '000000', data: { status: 2, failedReason: 'bad format' } })],
    });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
    await expect(client.uploadImage(Buffer.from([1]), 'c.png')).rejects.toThrow(/bad format/);
  });

  it('gives up after the poll limit', async () => {
    const { fetchImpl } = fakeFetch({
      '/image/presignedUrl': [json({ code: '000000', data: { presignedUrl: 'https://s3.example/put', fileTicket: 't1' } })],
      'https://s3.example/put': [new Response(null, { status: 200 })],
      '/image/imageStatus': [json({ code: '000000', data: { status: 0 } }), json({ code: '000000', data: { status: 0 } })],
    });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep, maxPolls: 2 });
    await expect(client.uploadImage(Buffer.from([1]), 'c.png')).rejects.toThrow(/after 2 polls/);
  });

  it('surfaces an API error code and never echoes the key', async () => {
    const { fetchImpl } = fakeFetch({
      '/image/presignedUrl': [json({ code: '220014', message: `Daily upload limit exceeded for ${KEY}` })],
    });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
    const err = await client.uploadImage(Buffer.from([1]), 'c.png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquareError);
    expect((err as SquareError).code).toBe('220014');
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe('uploadImage, secrets in errors', () => {
  it('never puts the presigned URL in the error when the PUT fails at the network level', async () => {
    const signed = 'https://s3.example/put?X-Amz-Signature=SECRETSIG';
    const fn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://s3.example')) throw new Error(`connect ECONNRESET ${signed}`);
      return json({ code: '000000', data: { presignedUrl: signed, fileTicket: 't1' } });
    });
    const client = createSquareClient({ apiKey: KEY, fetchImpl: fn as unknown as typeof fetch, sleep: noSleep });

    const err = await client.uploadImage(Buffer.from([1]), 'c.png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquareError);
    expect((err as Error).message).not.toContain('SECRETSIG');
  });
});

describe('publishPost', () => {
  it('posts a short post with its images to the v1 endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/content/add': [json({ code: '000000', data: { id: 123, shareLink: 'https://square.example/p/123' } })],
    });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });

    const out = await client.publishPost({ body: '#Tag\n\nBody', imageUrls: ['https://img.example/a.png'] });

    expect(out).toEqual({ status: 'published', id: '123', shareLink: 'https://square.example/p/123' });
    expect(calls[0]!.url).toContain('/v1/public/pgc/openApi/content/add');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      contentType: 1,
      bodyTextOnly: '#Tag\n\nBody',
      imageList: ['https://img.example/a.png'],
    });
  });

  it('treats HTTP 504 as published without an id, never as a failure', async () => {
    const { fetchImpl } = fakeFetch({ '/content/add': [new Response('Gateway Timeout', { status: 504 })] });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });

    await expect(client.publishPost({ body: 'x', imageUrls: [] })).resolves.toEqual({
      status: 'published_without_id',
      id: null,
      shareLink: null,
    });
  });

  it('throws on any other non-JSON response', async () => {
    const { fetchImpl } = fakeFetch({ '/content/add': [new Response('oops', { status: 500 })] });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
    await expect(client.publishPost({ body: 'x', imageUrls: [] })).rejects.toThrow(/non-JSON \(HTTP 500\)/);
  });

  it('marks a gateway answer and a dropped connection as ambiguous, an API rejection as definite', async () => {
    // Ambiguous means the post may be live: the approver must not offer the
    // draft again, or a second "d" posts it twice.
    const cases: [Response | Error, boolean][] = [
      [new Response('<html>Bad Gateway</html>', { status: 502 }), true],
      [new Error('socket hang up'), true],
      [json({ code: '20002', message: 'sensitive words' }), false],
    ];
    for (const [answer, ambiguous] of cases) {
      const fetchImpl = vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }) as unknown as typeof fetch;
      const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
      const err = await client.publishPost({ body: 'x', imageUrls: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SquareError);
      expect((err as SquareError).ambiguous).toBe(ambiguous);
    }
  });

  it('treats a 5xx JSON error, an envelope with no code, and a body that breaks off as ambiguous', async () => {
    // Review 2026-11-15: each of these used to be a definite failure, so the
    // draft went back on the queue while the post might be live.
    const brokenBody = new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error('socket hang up'));
        },
      }),
      { status: 200 },
    );
    const cases: Response[] = [
      json({ code: '100001', message: 'upstream busy' }, 503),
      json({ message: 'ok?' }, 200),
      brokenBody,
    ];
    for (const answer of cases) {
      const fetchImpl = vi.fn(async () => answer) as unknown as typeof fetch;
      const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
      const err = await client.publishPost({ body: 'x', imageUrls: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SquareError);
      expect((err as SquareError).ambiguous).toBe(true);
    }
  });

  it('reads an unexpected envelope as ambiguous instead of crashing on it', async () => {
    // Audit 2026-11-15: JSON null and a non-string message threw a TypeError,
    // which is not a SquareError, so the approver put the draft back on the queue.
    for (const answer of [
      new Response('null', { status: 200 }),
      json({ code: '500', message: { detail: 'busy' } }, 200),
    ]) {
      const fetchImpl = vi.fn(async () => answer) as unknown as typeof fetch;
      const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
      const err = await client.publishPost({ body: 'x', imageUrls: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SquareError);
      expect((err as SquareError).ambiguous).toBe(true);
    }
  });

  it('treats only the known rejection codes of /content/add as definite', async () => {
    const cases: [string, boolean][] = [
      ['20002', false],
      ['20022', false],
      ['220009', false],
      ['100001', true],
      ['220003', true],
    ];
    for (const [code, ambiguous] of cases) {
      const fetchImpl = vi.fn(async () => json({ code, message: 'no' }, 200)) as unknown as typeof fetch;
      const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
      const err = await client.publishPost({ body: 'x', imageUrls: [] }).catch((e: unknown) => e);
      expect((err as SquareError).ambiguous, code).toBe(ambiguous);
    }
  });

  it('reads an empty post id as no id', async () => {
    const { fetchImpl } = fakeFetch({ '/content/add': [json({ code: '000000', data: { id: '' } })] });
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
    await expect(client.publishPost({ body: 'x', imageUrls: [] })).resolves.toEqual({
      status: 'published',
      id: null,
      shareLink: null,
    });
  });

  it('refuses more than four images before any request', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const client = createSquareClient({ apiKey: KEY, fetchImpl, sleep: noSleep });
    await expect(client.publishPost({ body: 'x', imageUrls: ['1', '2', '3', '4', '5'] })).rejects.toThrow(/At most 4/);
    expect(calls).toHaveLength(0);
  });
});
