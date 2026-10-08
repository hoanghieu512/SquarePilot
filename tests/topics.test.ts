import { describe, expect, it } from 'vitest';
import { classifyTopics } from '../src/perspective/topics.js';

describe('classifyTopics', () => {
  it('maps a Fed hashtag to macro, the vocabulary lenses are written in', () => {
    const topics = classifyTopics('#WarshSaysInflationIsFedTopFocus');
    expect(topics).toContain('macro');
  });

  it('maps a record-high hashtag to metrics', () => {
    expect(classifyTopics('#SpotGoldHitsHighestSinceMay15')).toContain('metrics');
  });

  it('maps an earnings hashtag to equities', () => {
    expect(classifyTopics('#SamsungToAnnounceNewShareholderReturnPlanFriday')).toContain('equities');
  });

  it('maps a legislation hashtag to policy', () => {
    expect(classifyTopics('#TrumpPressesCongressToPassClarityAct')).toContain('policy');
  });

  it('maps a protocol upgrade to protocol', () => {
    expect(classifyTopics('#EthereumFoundationLaunchesGlamsterdam')).toContain('protocol');
  });

  it('keeps the literal words too, so angle matching is unaffected', () => {
    const topics = classifyTopics('#USJoblessClaimsFallTo206000');
    expect(topics).toContain('jobless');
    expect(topics).toContain('claims');
  });

  it('returns only literal words when nothing in the table matches', () => {
    const topics = classifyTopics('#SomeUnrecognisableThing');
    expect(topics).toContain('unrecognisable');
    expect(topics).not.toContain('macro');
  });
});
