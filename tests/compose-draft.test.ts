import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { composeDraft } from '../src/compose/compose-draft.js';
import { MODE_SPECS } from '../src/compose/modes.js';
import { buildPrompt } from '../src/compose/drafter.js';
import type { VoiceAssets } from '../src/compose/prompt-assets.js';
import type { Trend } from '../src/collect/parse-trends.js';
import type { Perspective } from '../src/perspective/types.js';

const assets: VoiceAssets = {
  aboutMe: 'ABOUT-ME-MARKER '.repeat(20),
  toneGuidelines: 'TONE-MARKER '.repeat(30),
  antiAiRules: 'ANTIAI-MARKER '.repeat(30),
};

const trend: Trend = {
  hashtag: '#USJoblessClaimsFallTo206000',
  hashtagId: 1,
  rank: 1,
  viewCount: 137_290,
  contentCount: 1856,
  tradingPairs: [],
};

const perspective: Perspective = {
  kind: 'lens',
  ref: 'what-the-number-hides',
  summary: 'What the Number Hides',
  evidence: ['The trend carries 137290 views across 1856 posts.'],
  guardrails: [],
};

/** Clean on mechanics, and shaped unlike the history used below. */
const GOOD = [
  "It's two numbers for one move.",
  'Nobody noticed.',
  '',
  'The weekly print and the monthly print describe the same slide, and only the window differs. Which one you meet first decides what you think happened.',
  '',
  'Still unfixed.',
  '',
  'No patch for that.',
].join('\n');

function queueLlm(replies: string[]): { client: LlmClient; calls: () => number } {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const body = replies[Math.min(i, replies.length - 1)]!;
    i++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: body } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    client: new LlmClient({
      apiKey: 'k',
      modelFree: 'm:free',
      modelPaid: 'm-paid',
      maxAttempts: 1,
      sleep: async () => {},
    }),
    calls: () => fetchMock.mock.calls.length,
  };
}

const PASS = '{"pass":true,"violations":[]}';

function req(over: Partial<Parameters<typeof buildPrompt>[0]> = {}) {
  return {
    trend,
    perspective,
    mode: MODE_SPECS.observation,
    topPosts: [],
    assets,
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('buildPrompt', () => {
  it('includes all three voice layers', () => {
    const p = buildPrompt(req());
    expect(p).toContain('ABOUT-ME-MARKER');
    expect(p).toContain('TONE-MARKER');
    expect(p).toContain('ANTIAI-MARKER');
  });

  it('puts the pass/fail rules last, closest to generation', () => {
    const p = buildPrompt(req());
    expect(p.indexOf('ANTIAI-MARKER')).toBeGreaterThan(p.indexOf('TONE-MARKER'));
    expect(p.indexOf('TONE-MARKER')).toBeGreaterThan(p.indexOf('ABOUT-ME-MARKER'));
  });

  it('hands the model the point of view instead of asking for one', () => {
    const p = buildPrompt(req());
    expect(p).toContain('What the Number Hides');
    expect(p).toContain('The trend carries 137290 views');
  });

  it('carries guardrails through as hard limits', () => {
    const p = buildPrompt(
      req({ perspective: { ...perspective, guardrails: ['No price speculation on $DUSK.'] } }),
    );
    expect(p).toContain('No price speculation on $DUSK.');
    expect(p).toMatch(/Breaking one fails the post/);
  });

  it('tells the model not to write the hashtag itself', () => {
    expect(buildPrompt(req())).toMatch(/Do not include the hashtag/);
  });

  it('presents existing posts as material to avoid, not to reuse', () => {
    const p = buildPrompt(
      req({ topPosts: [{ id: '1', authorName: 'a', text: 'Everyone says this is bullish.', likeCount: 0, viewCount: 1 }] }),
    );
    expect(p).toMatch(/Do not repeat these angles/);
  });

  it('feeds corrections back verbatim and forbids working around them', () => {
    const p = buildPrompt(req({ corrections: ['Remove the em-dash (Rule E7).'] }));
    expect(p).toContain('Remove the em-dash (Rule E7).');
    expect(p).toMatch(/Do not work around the objection/);
  });
});

describe('composeDraft', () => {
  it('passes on the first attempt using the free tier', async () => {
    const { client } = queueLlm([GOOD, PASS]);
    const out = await composeDraft(req(), { llm: client, recentPosts: [] });

    expect(out.ok).toBe(true);
    expect(out.tier).toBe('free');
    expect(out.escalated).toBe(false);
  });

  it('prepends the hashtag and reports both lengths', async () => {
    const { client } = queueLlm([GOOD, PASS]);
    const out = await composeDraft(req(), { llm: client, recentPosts: [] });

    expect(out.body.startsWith('#USJoblessClaimsFallTo206000')).toBe(true);
    expect(out.lengths.nfd).toBeGreaterThan(0);
  });

  it('escalates to the paid model only after the free one fails', async () => {
    // Attempt 1: draft, then a tone verdict that rejects it. Attempt 2: draft,
    // then a passing verdict.
    const { client } = queueLlm([
      GOOD,
      '{"pass":false,"violations":["E3 - hedging repeated"]}',
      GOOD,
      PASS,
    ]);

    const out = await composeDraft(req(), { llm: client, recentPosts: [], maxAttempts: 2 });

    expect(out.ok).toBe(true);
    expect(out.escalated).toBe(true);
    expect(out.attempts[0]!.tier).toBe('free');
    expect(out.attempts[1]!.tier).toBe('paid');
  });

  it('never pays on the first attempt, since that would destroy the measurement', async () => {
    const { client } = queueLlm([GOOD, PASS]);
    const out = await composeDraft(req(), { llm: client, recentPosts: [] });
    expect(out.attempts[0]!.tier).toBe('free');
  });

  it('fails the draft when it names the job too often, even if tone passes', async () => {
    const jobDraft = [
      "I've worked as a QA for eight years.",
      'Nobody noticed.',
      '',
      'The weekly print and the monthly print describe one slide, and the window is the only difference between them.',
      '',
      'Still unfixed.',
      '',
      'No patch for that.',
    ].join('\n');

    const { client } = queueLlm([jobDraft, PASS]);
    const out = await composeDraft(req(), {
      llm: client,
      recentPosts: ['An earlier post where I mention my day job as a tester.'],
      maxAttempts: 1,
    });

    expect(out.ok).toBe(false);
    expect(out.attempts[0]!.toneOk).toBe(true);
    expect(out.attempts[0]!.personaOk).toBe(false);
    expect(out.attempts[0]!.corrections.join(' ')).toMatch(/stated position/);
  });

  it('returns the last body even when every attempt failed, so nothing is lost', async () => {
    const { client } = queueLlm([GOOD, '{"pass":false,"violations":["E4 - banned phrase"]}']);
    const out = await composeDraft(req(), { llm: client, recentPosts: [], maxAttempts: 1 });

    expect(out.ok).toBe(false);
    expect(out.body).toContain('#USJoblessClaimsFallTo206000');
    expect(out.attempts).toHaveLength(1);
  });

  it('records which gate failed on each attempt', async () => {
    const { client } = queueLlm([GOOD, '{"pass":false,"violations":["E3 - hedging"]}']);
    const out = await composeDraft(req(), { llm: client, recentPosts: [], maxAttempts: 1 });

    const a = out.attempts[0]!;
    expect(a.toneOk).toBe(false);
    expect(a.shapeOk).toBe(true);
    expect(a.personaOk).toBe(true);
  });
});
