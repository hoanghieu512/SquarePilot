import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { composeDraft } from '../src/compose/compose-draft.js';
import { MODE_SPECS } from '../src/compose/modes.js';
import { buildPrompt } from '../src/compose/drafter.js';
import type { VoiceAssets } from '../src/compose/prompt-assets.js';
import type { Trend } from '../src/collect/parse-trends.js';
import type { Perspective } from '../src/perspective/types.js';
import type { RecentPost } from '../src/compose/recent-posts.js';
import type { AnchorAssignment } from '../src/compose/anchor.js';

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
  const { client, fetchMock } = queueLlmWithMock(replies);
  return { client, calls: () => fetchMock.mock.calls.length };
}

function queueLlmWithMock(replies: string[]): {
  client: LlmClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
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
    fetchMock,
  };
}

const PASS = '{"pass":true,"violations":[]}';

function recentPost(text: string): RecentPost {
  return { source: 'db', ref: '1', date: '2026-10-01', shapeText: text, personaText: text };
}

const DERIVED: AnchorAssignment = {
  tier: 'derived',
  ref: null,
  material: ['Read the 10 posts showing under #USJoblessClaimsFallTo206000 on Square.'],
  mayNameJob: true,
};

function req(over: Partial<Parameters<typeof buildPrompt>[0]> = {}) {
  return {
    trend,
    perspective,
    mode: MODE_SPECS.observation,
    topPosts: [],
    assets,
    anchor: DERIVED,
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

  it('passes the voice layers through whole instead of cutting them at a length', () => {
    // A fixed 6000-character cut once ended about-me halfway through Hard Nos.
    const long = { ...assets, aboutMe: `${'About. '.repeat(1500)}HARD-NOS-TAIL` };
    expect(buildPrompt(req({ assets: long }))).toContain('HARD-NOS-TAIL');
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

  it('gives the drafter its anchor and nothing else to claim as done or seen', () => {
    const p = buildPrompt(req());

    expect(p).toContain('Read the 10 posts showing under #USJoblessClaimsFallTo206000 on Square.');
    expect(p).toMatch(/Any other claim of something you did, saw, held or tested is invented/);
  });

  it('anchors a post with no material on a stated position', () => {
    const stance: AnchorAssignment = { tier: 'stance', ref: null, material: [], mayNameJob: true };
    const p = buildPrompt(req({ anchor: stance }));

    expect(p).toMatch(/take a side, in first person/);
    expect(p).toMatch(/Do not claim to have done, seen, held, traded or tested anything/);
  });

  it('forbids naming the job while the cap is in use', () => {
    const p = buildPrompt(req({ anchor: { ...DERIVED, mayNameJob: false } }));
    expect(p).toMatch(/Do not name the author's job or years of experience/);
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
    const out = await composeDraft(req(), { llm: client, recent: [] });

    expect(out.ok).toBe(true);
    expect(out.tier).toBe('free');
    expect(out.escalated).toBe(false);
  });

  it('prepends the hashtag and reports both lengths', async () => {
    const { client } = queueLlm([GOOD, PASS]);
    const out = await composeDraft(req(), { llm: client, recent: [] });

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

    const out = await composeDraft(req(), { llm: client, recent: [], maxAttempts: 2 });

    expect(out.ok).toBe(true);
    expect(out.escalated).toBe(true);
    expect(out.attempts[0]!.tier).toBe('free');
    expect(out.attempts[1]!.tier).toBe('paid');
  });

  it('never pays on the first attempt, since that would destroy the measurement', async () => {
    const { client } = queueLlm([GOOD, PASS]);
    const out = await composeDraft(req(), { llm: client, recent: [] });
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
      recent: [recentPost('An earlier post where I mention my day job as a tester.')],
      maxAttempts: 1,
    });

    expect(out.ok).toBe(false);
    expect(out.attempts[0]!.toneOk).toBe(true);
    expect(out.attempts[0]!.personaOk).toBe(false);
    expect(out.attempts[0]!.corrections.join(' ')).toMatch(/stated position/);
  });

  it('counts the job mention in a hand-written post on the same account', async () => {
    // The mention sits in personaText (the disclaimer line, past the shape body).
    const handWritten = {
      ...recentPost('A post about settlement windows.'),
      source: 'vault' as const,
      personaText: 'A post about settlement windows.\n\n*Written by a QA, not an adviser.*',
    };
    const jobDraft = "I've worked as a QA for years. Nobody noticed. Still unfixed. No patch.";

    const { client } = queueLlm([jobDraft, PASS]);
    const out = await composeDraft(req(), { llm: client, recent: [handWritten], maxAttempts: 1 });

    expect(out.attempts[0]!.personaOk).toBe(false);
  });

  it('compares shape only against posts that have a measurable body', async () => {
    // A vault file whose text sits past its first '---' parses to an empty body;
    // scoring the draft against nothing would invent a distance.
    // One long-sentence paragraph sits within 0.03 of an empty post's metrics.
    const empty = { ...recentPost(''), source: 'vault' as const, personaText: 'x' };
    const flat =
      'The weekly print and the monthly print describe the same slide and only the window between them differs here.';
    const { client } = queueLlm([flat]);
    const out = await composeDraft(req(), { llm: client, recent: [empty], maxAttempts: 1 });

    expect(out.attempts[0]!.shapeOk).toBe(true);
  });

  it('returns the last body even when every attempt failed, so nothing is lost', async () => {
    const { client } = queueLlm([GOOD, '{"pass":false,"violations":["E4 - banned phrase"]}']);
    const out = await composeDraft(req(), { llm: client, recent: [], maxAttempts: 1 });

    expect(out.ok).toBe(false);
    expect(out.body).toContain('#USJoblessClaimsFallTo206000');
    expect(out.attempts).toHaveLength(1);
  });

  it('hands the assigned anchor to the tone judge', async () => {
    const { client, fetchMock } = queueLlmWithMock([GOOD, PASS]);
    await composeDraft(req(), { llm: client, recent: [] });

    // Call 1 is the draft, call 2 the judge.
    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(String(init.body)).toContain('Anchor assigned to this post');
  });

  it('records which gate failed on each attempt', async () => {
    const { client } = queueLlm([GOOD, '{"pass":false,"violations":["E3 - hedging"]}']);
    const out = await composeDraft(req(), { llm: client, recent: [], maxAttempts: 1 });

    const a = out.attempts[0]!;
    expect(a.toneOk).toBe(false);
    expect(a.shapeOk).toBe(true);
    expect(a.personaOk).toBe(true);
  });
});
