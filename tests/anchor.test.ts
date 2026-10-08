import { describe, expect, it } from 'vitest';
import {
  DERIVED_MAX,
  pipelineFactsFor,
  resolveAnchor,
  type AnchorInput,
} from '../src/compose/anchor.js';
import type { Trend } from '../src/collect/parse-trends.js';
import type { AnchorBank, BankAnchor } from '../src/perspective/anchor-bank.js';
import type { Perspective } from '../src/perspective/types.js';

const lens: Perspective = {
  kind: 'lens',
  ref: 'what-the-number-hides',
  summary: 'The number hides its denominator.',
  evidence: ['#X carries 100 views across 10 posts.'],
  guardrails: [],
};

function anchor(id: string, over: Partial<BankAnchor> = {}): BankAnchor {
  return {
    id,
    title: id,
    lenses: ['what-the-number-hides'],
    textEn: `Anchor ${id}: the number on screen did not match the one in my head.`,
    used: false,
    lastUsed: null,
    ...over,
  };
}

const approved = (...anchors: BankAnchor[]): AnchorBank => ({
  status: 'approved',
  cooldownDays: 30,
  anchors,
});

const FACTS = ['Read the 10 posts showing under #X on Square.'];

function input(over: Partial<AnchorInput> = {}): AnchorInput {
  return {
    perspective: lens,
    rawNotes: [],
    bank: approved(),
    pipelineFacts: FACTS,
    recentTiers: [],
    personaCapInUse: false,
    now: new Date('2026-10-04T00:00:00Z'),
    ...over,
  };
}

describe('resolveAnchor', () => {
  it('uses a note the author sent today before anything else', () => {
    const a = resolveAnchor(input({ rawNotes: ['I sold half at the open.'], bank: approved(anchor('A01')) }));

    expect(a.tier).toBe('raw');
    expect(a.material).toEqual(['I sold half at the open.']);
  });

  it('draws a bank anchor that belongs to the lens', () => {
    const a = resolveAnchor(input({ bank: approved(anchor('A01')) }));

    expect(a.tier).toBe('bank');
    expect(a.ref).toBe('A01');
    expect(a.material[0]).toMatch(/^Anchor A01/);
  });

  it('does not force a bank anchor onto a post that has no lens', () => {
    // An anchor from a different lens is how a post ends up shoehorning the job in.
    const tension: Perspective = { ...lens, kind: 'tension', ref: 'scale' };
    const a = resolveAnchor(input({ perspective: tension, bank: approved(anchor('A01')) }));

    expect(a.tier).not.toBe('bank');
  });

  it('reads nothing from a bank that is not approved', () => {
    const pending: AnchorBank = { status: 'draft-pending-review', cooldownDays: 30, anchors: [] };
    expect(resolveAnchor(input({ bank: pending })).tier).toBe('derived');
  });

  it('skips an anchor still inside its cooldown', () => {
    const recent = anchor('A01', { used: true, lastUsed: '2026-09-20' });
    expect(resolveAnchor(input({ bank: approved(recent) })).tier).toBe('derived');
  });

  it('lets an anchor back once the cooldown has passed', () => {
    const old = anchor('A01', { used: true, lastUsed: '2026-09-01' });
    expect(resolveAnchor(input({ bank: approved(old) })).ref).toBe('A01');
  });

  it('prefers an anchor that has never been used', () => {
    const old = anchor('A01', { used: true, lastUsed: '2026-08-01' });
    expect(resolveAnchor(input({ bank: approved(old, anchor('A03')) })).ref).toBe('A03');
  });

  it('passes over an anchor that names the job while the cap is in use', () => {
    // A bank anchor can name the job outright, e.g. by opening on "Where I work".
    const namesJob = anchor('A04', { textEn: 'Where I work, nobody ships on a Friday afternoon.' });

    expect(resolveAnchor(input({ bank: approved(namesJob), personaCapInUse: true })).tier).toBe('derived');
    expect(resolveAnchor(input({ bank: approved(namesJob), personaCapInUse: false })).ref).toBe('A04');
  });

  it('falls back to what the pipeline actually did today', () => {
    const a = resolveAnchor(input());

    expect(a.tier).toBe('derived');
    expect(a.material).toEqual(FACTS);
  });

  it(`allows at most ${DERIVED_MAX} derived anchors in the last ten posts`, () => {
    const full = Array(DERIVED_MAX).fill('derived');
    expect(resolveAnchor(input({ recentTiers: full })).tier).toBe('stance');
  });

  it('only counts derived anchors inside the ten-post window', () => {
    const outside = [...Array(10).fill('stance'), ...Array(DERIVED_MAX).fill('derived')];
    expect(resolveAnchor(input({ recentTiers: outside })).tier).toBe('derived');
  });

  it('ends on a stated position, with no first-person material to draw on', () => {
    const a = resolveAnchor(input({ pipelineFacts: [] }));

    expect(a.tier).toBe('stance');
    expect(a.material).toEqual([]);
  });

  it('forbids naming the job while the cap is in use, at every tier', () => {
    expect(resolveAnchor(input({ personaCapInUse: true })).mayNameJob).toBe(false);
    expect(resolveAnchor(input({ personaCapInUse: false })).mayNameJob).toBe(true);
  });
});

describe('pipelineFactsFor', () => {
  const trend: Trend = {
    hashtag: '#FedHoldsRates',
    hashtagId: 1,
    rank: 1,
    viewCount: 52_000,
    contentCount: 640,
    tradingPairs: [],
  };
  const post = { id: '1', authorName: 'a', text: 't', likeCount: 0, viewCount: 1 };

  it('states what was read and looked up, with the real numbers', () => {
    const facts = pipelineFactsFor(trend, [post, post, post]);

    expect(facts.join(' ')).toMatch(/Read the 3 most-read posts under #FedHoldsRates/);
    expect(facts.join(' ')).toMatch(/52000 views across 640 posts/);
  });

  it('does not claim the posts were read when none came back', () => {
    // The reader can fail and the pipeline carries on; the fact must not.
    expect(pipelineFactsFor(trend, []).join(' ')).not.toMatch(/Read the/);
  });
});
