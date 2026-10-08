import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { checkMechanical, runToneGate } from '../src/compose/tone-gate.js';
import type { VoiceAssets } from '../src/compose/prompt-assets.js';

const assets: VoiceAssets = {
  aboutMe: 'x'.repeat(300),
  toneGuidelines: 'y'.repeat(300),
  antiAiRules: 'z'.repeat(300),
};

/** Passes every mechanical check, so the model decides. Rule E2 needs three
 *  sentences of 2-5 words, so this fixture carries exactly three. */
const CLEAN = [
  "It's a gap between two screens.",
  'Nobody noticed.',
  "That's the whole story, and the filing says so on page four.",
  'Still unfixed.',
  'No patch for that.',
].join(' ');

function llmReturning(text: string): { client: LlmClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
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

afterEach(() => vi.unstubAllGlobals());

describe('checkMechanical', () => {
  it('finds banned phrases regardless of case', () => {
    const f = checkMechanical('In Conclusion, we should dive into the numbers.');
    expect(f.forbidden).toContain('in conclusion');
    expect(f.forbidden).toContain('dive into');
  });

  it('finds em-dash and en-dash', () => {
    const f = checkMechanical('The gap — and it is real – shows up late.');
    expect(f.bannedChars).toContain('em-dash');
    expect(f.bannedChars).toContain('en-dash');
  });

  it('counts short sentences of two to five words', () => {
    expect(checkMechanical('Nobody noticed. It broke. Money gone.').shortSentences).toBe(3);
  });

  it('does not count a one-word fragment as a short sentence', () => {
    expect(checkMechanical('Gone.').shortSentences).toBe(0);
  });

  it('detects contractions', () => {
    expect(checkMechanical("It's here.").hasContraction).toBe(true);
    expect(checkMechanical('It is here.').hasContraction).toBe(false);
  });

  it('counts emoji', () => {
    expect(checkMechanical('Up 🚀 and away 🔥').emojiCount).toBe(2);
  });
});

describe('runToneGate', () => {
  it('fails on mechanics without spending a model call', async () => {
    const { client, fetchMock } = llmReturning('{"pass":true,"violations":[]}');

    const verdict = await runToneGate('In conclusion, it is important to note this.', {
      llm: client,
      assets,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.usedModel).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the rule and the offending text in its correction', async () => {
    const { client } = llmReturning('{"pass":true,"violations":[]}');
    const verdict = await runToneGate('The gap — real — is late. It is here.', {
      llm: client,
      assets,
    });

    const joined = verdict.corrections.join(' ');
    expect(joined).toMatch(/E7/);
    expect(joined).toMatch(/em-dash/);
  });

  it('asks the model when mechanics are clean', async () => {
    const { client, fetchMock } = llmReturning('{"pass":true,"violations":[]}');

    const verdict = await runToneGate(CLEAN, { llm: client, assets });

    expect(verdict.ok).toBe(true);
    expect(verdict.usedModel).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the model violations through as corrections', async () => {
    const { client } = llmReturning(
      '{"pass":false,"violations":["E3 - hedging formula repeated - \\"I am not saying\\""]}',
    );

    const verdict = await runToneGate(CLEAN, { llm: client, assets });
    expect(verdict.ok).toBe(false);
    expect(verdict.corrections[0]).toMatch(/E3/);
  });

  it('tolerates prose wrapped around the JSON', async () => {
    const { client } = llmReturning('Sure, here you go:\n{"pass":true,"violations":[]}\nHope that helps.');
    expect((await runToneGate(CLEAN, { llm: client, assets })).ok).toBe(true);
  });

  it('treats an unreadable verdict as a failure, not a pass', async () => {
    // A judge that returns nonsense must not silently disable the gate.
    const { client } = llmReturning('I think it looks fine to me!');
    const verdict = await runToneGate(CLEAN, { llm: client, assets });

    expect(verdict.ok).toBe(false);
    expect(verdict.corrections[0]).toMatch(/unreadable/);
  });

  it('does not pass when the model says pass but still lists violations', async () => {
    const { client } = llmReturning('{"pass":true,"violations":["E4 - banned phrase"]}');
    expect((await runToneGate(CLEAN, { llm: client, assets })).ok).toBe(false);
  });
});
