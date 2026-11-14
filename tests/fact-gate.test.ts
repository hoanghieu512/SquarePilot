import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../src/llm/client.js';
import { factSourcesFrom, runFactGate, type FactSources } from '../src/compose/fact-gate.js';
import { MODE_SPECS } from '../src/compose/modes.js';
import type { VoiceAssets } from '../src/compose/prompt-assets.js';

function judge(reply: string) {
  const complete = vi.fn(async (_args: { system: string; user: string }) => ({ text: reply }));
  return { llm: { complete } as unknown as LlmClient, complete };
}

const sources: FactSources = {
  hashtag: '#BitcoinHoldsSupport',
  trendLine: '137290 views across 1856 posts.',
  summary: 'The level everyone quotes depends on the window chosen.',
  evidence: ['BTC last traded at $68,214.', 'A top post states: "The 200-week average has never broken."'],
  guardrails: [],
  anchorMaterial: [],
};

const PASS = '{"pass":true,"violations":[]}';

describe('runFactGate', () => {
  it('fails on an invented figure without calling the judge', async () => {
    const { llm, complete } = judge(PASS);
    const out = await runFactGate('Near $68k, and 70% of supply has not moved.', sources, {
      llm,
      currentYear: 2026,
    });

    expect(out.ok).toBe(false);
    expect(out.unsupportedFigures).toEqual(['70%']);
    expect(out.corrections).toEqual([
      'The figure "70%" is not in the evidence. Remove it or use a figure the evidence states; do not estimate or recall numbers.',
    ]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('accepts figures from the hashtag, the attention line and the anchor material', async () => {
    const { llm } = judge(PASS);
    const out = await runFactGate('Past 100K, 137,290 views, and the desk took 14 hours to settle it.', {
      ...sources,
      hashtag: '#BitcoinHoldsAbove100K',
      anchorMaterial: ['It took 14 hours to settle.'],
    }, { llm, currentYear: 2026 });

    expect(out.unsupportedFigures).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it('asks the judge once the figures pass, and passes on a clean verdict', async () => {
    const { llm, complete } = judge(PASS);
    const out = await runFactGate('Near $68k. Windows decide the story.', sources, { llm, currentYear: 2026 });

    expect(out).toMatchObject({ ok: true, usedModel: true, corrections: [] });
    expect(complete).toHaveBeenCalledTimes(1);
    const { user, system } = complete.mock.calls[0]![0];
    expect(user).toContain('BTC last traded at $68,214.');
    expect(user).toContain('Near $68k. Windows decide the story.');
    expect(system).toContain('A top post states');
  });

  it("turns the judge's violations into corrections", async () => {
    const { llm } = judge(
      '{"pass":false,"violations":["has held every cycle - the sources say nothing about past cycles"]}',
    );
    const out = await runFactGate('The level has held every cycle.', sources, { llm, currentYear: 2026 });

    expect(out.ok).toBe(false);
    expect(out.corrections).toEqual([
      'Unsupported claim: has held every cycle - the sources say nothing about past cycles. Remove it, or say only what the evidence states.',
    ]);
  });

  it('does not count a pass that still lists violations', async () => {
    const { llm } = judge('{"pass":true,"violations":["x - y"]}');
    const out = await runFactGate('Plain text.', sources, { llm, currentYear: 2026 });
    expect(out.ok).toBe(false);
  });

  it('treats an unreadable verdict as a failure', async () => {
    const { llm } = judge('looks fine to me');
    const out = await runFactGate('Plain text.', sources, { llm, currentYear: 2026 });

    expect(out.ok).toBe(false);
    expect(out.corrections[0]).toMatch(/unreadable verdict/);
  });

  it('skips the judge when asked, keeping the figure check', async () => {
    const { llm, complete } = judge(PASS);
    const ok = await runFactGate('Near $68k.', sources, { llm, currentYear: 2026, judge: false });
    const bad = await runFactGate('Near $90k.', sources, { llm, currentYear: 2026, judge: false });

    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('runFactGate when the judge is cut off', () => {
  it('fails the attempt instead of throwing, and still rethrows other errors', async () => {
    const { LlmError } = await import('../src/llm/client.js');
    const cut = {
      complete: vi.fn(async () => {
        throw new LlmError('hit the token limit', false, undefined, true);
      }),
    } as unknown as LlmClient;
    const out = await runFactGate('Near $68k.', sources, { llm: cut, currentYear: 2026 });
    expect(out.ok).toBe(false);
    expect(out.corrections[0]).toMatch(/ran out of tokens/);

    const down = {
      complete: vi.fn(async () => {
        throw new LlmError('provider down', true);
      }),
    } as unknown as LlmClient;
    await expect(runFactGate('Near $68k.', sources, { llm: down, currentYear: 2026 })).rejects.toThrow('provider down');
  });
});

describe('factSourcesFrom', () => {
  it('uses what the drafter was given as material and leaves out the posts it was told to avoid', () => {
    const assets: VoiceAssets = { aboutMe: '', toneGuidelines: '', antiAiRules: '' };
    const s = factSourcesFrom({
      trend: { hashtag: '#X', hashtagId: 1, rank: 1, viewCount: 10, contentCount: 2, tradingPairs: [] },
      perspective: { kind: 'lens', ref: 'r', summary: 'S', evidence: ['E1'], guardrails: ['G1'] },
      mode: MODE_SPECS.observation,
      topPosts: [{ text: 'Unverified 99% claim', likeCount: 0 } as never],
      assets,
      anchor: { tier: 'derived', ref: null, material: ['M1'], mayNameJob: true },
    });

    expect(s).toEqual({
      hashtag: '#X',
      trendLine: '10 views across 2 posts.',
      summary: 'S',
      evidence: ['E1'],
      guardrails: ['G1'],
      anchorMaterial: ['M1'],
    });
  });
});
