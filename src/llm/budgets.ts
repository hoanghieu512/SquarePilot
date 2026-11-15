import type { CompleteArgs } from './client.js';

/**
 * Token budgets per kind of call.
 *
 * Both models think before answering by default, at effort "high"
 * (OpenRouter /api/v1/models, checked 2026-11-15), and the thinking counts
 * against max_tokens. With a flat 4096 the thinking alone used the whole
 * budget twice on 2026-11-15: a paid draft cut off mid-thought, and a free
 * tone verdict that never arrived, which failed a draft that may have been
 * fine. Capping the thinking below max_tokens always leaves room for the
 * answer, and caps what a paid draft can cost.
 */
type Budget = Required<Pick<CompleteArgs, 'maxTokens' | 'reasoning'>>;

/** A post is under about 700 tokens; the rest of the answer room is slack. */
export const DRAFT_BUDGET: Budget = { maxTokens: 6144, reasoning: { maxTokens: 2048 } };

/** Judges walk the rules one by one, so they get more room to think. */
export const JUDGE_BUDGET: Budget = { maxTokens: 8192, reasoning: { maxTokens: 4096 } };
