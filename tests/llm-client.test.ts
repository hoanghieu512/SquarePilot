import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import { LlmClient, LlmError } from '../src/llm/client.js';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const okBody = {
  choices: [{ message: { content: 'SquarePilot online.' } }],
  usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0 },
};

describe('LlmClient', () => {
  let db: Database.Database;
  let client: LlmClient;

  beforeEach(() => {
    db = memoryDb();
    client = new LlmClient({
      apiKey: 'sk-or-test',
      modelFree: 'vendor/model:free',
      modelPaid: 'vendor/model-paid',
      db,
      maxAttempts: 1,
      sleep: async () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('defaults to the free tier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okBody)));
    const result = await client.complete({ purpose: 'test', user: 'hi' });
    expect(result.model).toBe('vendor/model:free');
    expect(result.tier).toBe('free');
  });

  it('uses the paid model only when the tier says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okBody)));
    const result = await client.complete({ purpose: 'test', user: 'hi', tier: 'paid' });
    expect(result.model).toBe('vendor/model-paid');
  });

  it('records a successful call with its usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okBody)));
    await client.complete({ purpose: 'draft', user: 'hi' });

    const row = db.prepare('SELECT * FROM llm_calls').get() as {
      purpose: string;
      model: string;
      prompt_tokens: number;
      output_tokens: number;
      ok: number;
    };
    expect(row.purpose).toBe('draft');
    expect(row.model).toBe('vendor/model:free');
    expect(row.prompt_tokens).toBe(12);
    expect(row.output_tokens).toBe(4);
    expect(row.ok).toBe(1);
  });

  it('records failed calls too — a rejected call still consumed a rate-limit slot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, 429)),
    );

    await expect(client.complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(LlmError);

    const row = db.prepare('SELECT ok, error FROM llm_calls').get() as { ok: number; error: string };
    expect(row.ok).toBe(0);
    expect(row.error).toContain('rate limited');
  });

  it('rejects truncated output — leaked reasoning reads like prose and would slip past every later gate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [
            { message: { content: 'The user asks: "Reply with exactly..." So we must' }, finish_reason: 'length' },
          ],
        }),
      ),
    );

    await expect(client.complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(/truncated/);

    const row = db.prepare('SELECT ok FROM llm_calls').get() as { ok: number };
    expect(row.ok).toBe(0);
  });

  it('treats an empty completion as a failure rather than an empty draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] })),
    );

    await expect(client.complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(/empty completion/);

    const row = db.prepare('SELECT ok FROM llm_calls').get() as { ok: number };
    expect(row.ok).toBe(0);
  });

  it('records network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(client.complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(/ECONNREFUSED/);
    const row = db.prepare('SELECT ok, error FROM llm_calls').get() as { ok: number; error: string };
    expect(row.ok).toBe(0);
    expect(row.error).toContain('ECONNREFUSED');
  });

  it('never puts the api key anywhere but the Authorization header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okBody));
    vi.stubGlobal('fetch', fetchMock);

    await client.complete({ purpose: 'test', user: 'hi' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('sk-or-test');
    expect(String(init.body)).not.toContain('sk-or-test');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
  });

  describe('retry', () => {
    function retryingClient() {
      return new LlmClient({
        apiKey: 'sk-or-test',
        modelFree: 'vendor/model:free',
        modelPaid: 'vendor/model-paid',
        db,
        maxAttempts: 3,
        sleep: async () => {},
      });
    }

    it('retries a transient upstream overload and succeeds', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { message: 'Upstream error from Nvidia: Service temporarily overloaded' } }, 502),
        )
        .mockResolvedValueOnce(jsonResponse(okBody));
      vi.stubGlobal('fetch', fetchMock);

      const result = await retryingClient().complete({ purpose: 'draft', user: 'hi' });

      expect(result.text).toBe('SquarePilot online.');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Both the failure and the success are on the ledger: the failed attempt
      // still consumed a free-tier slot.
      const rows = db.prepare('SELECT ok FROM llm_calls ORDER BY id').all() as { ok: number }[];
      expect(rows.map((r) => r.ok)).toEqual([0, 1]);
    });

    it('retries rate limits', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
        .mockResolvedValueOnce(jsonResponse(okBody));
      vi.stubGlobal('fetch', fetchMock);

      await retryingClient().complete({ purpose: 'draft', user: 'hi' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a real rejection', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: { message: 'model not found' } }, 404),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(retryingClient().complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(
        /model not found/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry truncation — the same prompt truncates again, so retrying only burns free-tier slots', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: 'The user asks:' }, finish_reason: 'length' }],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(retryingClient().complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(
        /truncated/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after the attempt budget and reports the last error', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: { message: 'Service temporarily overloaded' } }, 502),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(retryingClient().complete({ purpose: 'draft', user: 'hi' })).rejects.toThrow(
        /overloaded/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
