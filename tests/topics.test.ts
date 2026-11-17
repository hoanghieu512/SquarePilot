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

  it('splits the hashtag the way the card headline does, so no word is glued or lost', () => {
    // 2026-11-17: "returnas", "186websites", "2.09mmstr", "for$244.7m",
    // "post$1.065b"; "ETFs" vanished altogether.
    const etf = classifyTopics('#BitcoinSpotETFsPost$1.065BOutflowsForThirdStraightWeek');
    expect(etf).toEqual(expect.arrayContaining(['bitcoin', 'etfs', 'post', 'outflows', 'price']));
    expect(etf.some((w) => w.includes('$1.065b') && w !== '$1.065b')).toBe(false);

    const mstr = classifyTopics('#StrategySells2.09MMSTRSharesFor$244.7M');
    expect(mstr).toEqual(expect.arrayContaining(['strategy', 'mstr', 'shares', 'equities']));

    expect(classifyTopics('#NvidiaBoardNotConsideringHuang’sReturnasCEO')).toEqual(
      expect.arrayContaining(['huang', 'return', 'ceo', 'equities']),
    );
    expect(classifyTopics('#OPTIMJACKAttackInfectsAtLeast186Websites')).toEqual(
      expect.arrayContaining(['optimjack', 'attack', 'websites']),
    );
    expect(classifyTopics('#TONStrategyReports$23.97MQ3NetLoss')).toEqual(
      expect.arrayContaining(['reports', 'q3', 'loss', 'earnings']),
    );
  });

  it('returns only literal words when nothing in the table matches', () => {
    const topics = classifyTopics('#SomeUnrecognisableThing');
    expect(topics).toContain('unrecognisable');
    expect(topics).not.toContain('macro');
  });
});
