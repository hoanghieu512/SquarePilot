import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('llm');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type Tier = 'free' | 'paid';

export interface LlmOptions {
  apiKey: string;
  modelFree: string;
  modelPaid: string;
  db?: Database.Database;
  /** Attempts per call, including the first. Set to 1 in tests that assert on a single fetch. */
  maxAttempts?: number;
  /** Injectable so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Reasoning models spend output tokens thinking before they answer. When the
 * budget runs out mid-thought the provider hands back the *reasoning* as
 * content — measured: max_tokens=32 yields "The user asks: ..." instead of the
 * answer, with finish_reason "length". That text looks like prose, so nothing
 * downstream would catch it. Budget generously and reject truncation outright.
 */
const DEFAULT_MAX_TOKENS = 4096;
const BACKOFF_MS = [1000, 3000];

/**
 * Free-tier models are shared capacity and refuse requests under load —
 * measured 2 failures in 4 calls on first contact, all "temporarily
 * overloaded". Those clear on their own within seconds.
 *
 * Retryability is decided at each throw site rather than sniffed from the
 * message, because the two failure families look alike but behave oppositely:
 * an overload resolves by waiting, a truncated response repeats forever.
 */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface CompleteArgs {
  /** What this call is for — recorded in llm_calls so cost can be attributed. */
  purpose: string;
  system?: string;
  user: string;
  tier?: Tier;
  maxTokens?: number;
  temperature?: number;
  draftId?: number;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  model: string;
  tier: Tier;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string; reasoning?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
  error?: { message?: string };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * OpenRouter wrapper.
 *
 * Tiering is a model name, not a code path: `free` and `paid` run through the
 * same request so an escalation can never behave differently from the original
 * attempt. Every call is recorded, including failures — a call that produced
 * nothing still cost a rate-limit slot, and on the free tier that is the
 * scarce resource.
 */
export class LlmClient {
  constructor(private readonly opts: LlmOptions) {}

  modelFor(tier: Tier): string {
    return tier === 'paid' ? this.opts.modelPaid : this.opts.modelFree;
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const maxAttempts = this.opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let lastError: LlmError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.attempt(args);
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        lastError = err;

        if (!err.retryable || attempt >= maxAttempts) break;

        const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`, {
          reason: err.message,
        });
        await sleep(delay);
      }
    }

    throw lastError!;
  }

  private async attempt(args: CompleteArgs): Promise<CompleteResult> {
    const tier = args.tier ?? 'free';
    const model = this.modelFor(tier);

    const messages: { role: string; content: string }[] = [];
    if (args.system) messages.push({ role: 'system', content: args.system });
    messages.push({ role: 'user', content: args.user });

    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: args.temperature ?? 0.8,
          usage: { include: true },
        }),
        signal: args.signal ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record({ draftId: args.draftId, purpose: args.purpose, model, ok: false, error: message });
      // Connection-level failure: nothing reached the model, always worth another try.
      throw new LlmError(`Request to OpenRouter failed: ${message}`, true);
    }

    const raw = (await response.json().catch(() => ({}))) as OpenRouterResponse;

    if (!response.ok || raw.error) {
      const message = raw.error?.message ?? `HTTP ${response.status}`;
      this.record({ draftId: args.draftId, purpose: args.purpose, model, ok: false, error: message });
      throw new LlmError(
        `OpenRouter rejected the request: ${message}`,
        isTransientStatus(response.status),
        response.status,
      );
    }

    const choice = raw.choices?.[0];

    if (choice?.finish_reason === 'length') {
      const message = `Model ${model} hit the token limit before finishing — output is truncated and may be leaked reasoning`;
      this.record({ draftId: args.draftId, purpose: args.purpose, model, ok: false, error: message });
      // Deterministic: the same prompt will truncate again. Retrying only
      // burns free-tier slots. The caller must raise maxTokens instead.
      throw new LlmError(message, false);
    }

    const text = choice?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      this.record({
        draftId: args.draftId,
        purpose: args.purpose,
        model,
        ok: false,
        error: 'empty completion',
      });
      // Seen under load alongside overload errors — worth one more attempt.
      throw new LlmError(`Model ${model} returned an empty completion`, true);
    }

    const result: CompleteResult = {
      text,
      model,
      tier,
      promptTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
      costUsd: raw.usage?.cost ?? 0,
    };

    this.record({
      draftId: args.draftId,
      purpose: args.purpose,
      model,
      ok: true,
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });

    logger.debug(`${args.purpose} via ${model}`, {
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });

    return result;
  }

  private record(row: {
    draftId?: number;
    purpose: string;
    model: string;
    ok: boolean;
    promptTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
  }): void {
    if (!this.opts.db) return;
    this.opts.db
      .prepare(
        `INSERT INTO llm_calls
           (draft_id, purpose, model, prompt_tokens, output_tokens, cost_usd, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.draftId ?? null,
        row.purpose,
        row.model,
        row.promptTokens ?? 0,
        row.outputTokens ?? 0,
        row.costUsd ?? 0,
        row.ok ? 1 : 0,
        row.error ?? null,
        new Date().toISOString(),
      );
  }
}
