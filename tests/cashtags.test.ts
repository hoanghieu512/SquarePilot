import { describe, expect, it } from 'vitest';
import {
  MAX_CASHTAGS,
  cashtagInstructions,
  groundedTickers,
  hashtagCoins,
  normalizeCashtags,
} from '../src/compose/cashtags.js';

describe('hashtagCoins', () => {
  it.each([
    ['#BitcoinHits100K', ['BTC']],
    ['#BTCBreaks68K', ['BTC']],
    ['#SolanaETFApproved', ['SOL']],
    ['#BNBChainUpgrade', ['BNB']],
    ['#GoldReboundsNearly5%', []],
    ['#ElectronicArtsDeal', []],
    ['#WashingtonPolicyShift', []],
    // Everyday words that are also tickers (review 2026-11-15).
    ['#GoldNearRecordHigh', []],
    ['#FedDotPlot', []],
    ['#RateCutRippleEffect', []],
    ['#WeakLinkInCredit', []],
    ['#NEARBreaksOut', ['NEAR']],
  ])('%s names %j', (hashtag, coins) => {
    expect(hashtagCoins(hashtag)).toEqual(coins);
  });
});

describe('groundedTickers', () => {
  it('takes tickers, cashtags and coin names from the evidence, minus non-coin acronyms', () => {
    const g = groundedTickers({
      hashtag: '#MarketUpdate',
      grounding: ['SEC delays the ETF ruling; ETH staking flows rose.', 'Guardrail: no price talk on $DUSK.', 'Solana fees fell.'],
    });
    expect(g.has('ETH')).toBe(true);
    expect(g.has('DUSK')).toBe(true);
    expect(g.has('SOL')).toBe(true);
    expect(g.has('SEC')).toBe(false);
    expect(g.has('ETF')).toBe(false);
  });
});

describe('groundedTickers, everyday words', () => {
  it('does not ground a word ticker from lower-case prose', () => {
    const g = groundedTickers({ hashtag: '#Gold', grounding: ['Gold traded near $2,700 and the link held.'] });
    expect(g.has('NEAR')).toBe(false);
    expect(g.has('LINK')).toBe(false);
  });

  it('grounds a word ticker written in capitals', () => {
    const g = groundedTickers({ hashtag: '#Market', grounding: ['NEAR rose 4% on the day.'] });
    expect(g.has('NEAR')).toBe(true);
  });

  it('strips $NEAR from a gold post even though the hashtag says "Near"', () => {
    const r = normalizeCashtags('Gold sits close to the top, and $NEAR is not the story.', {
      hashtag: '#GoldNearRecordHigh',
      grounding: ['Gold spot traded near $2,700.'],
    });
    expect(r.text).toBe('Gold sits close to the top, and NEAR is not the story.');
  });

  it('gives no coin hint for a hashtag that only contains the word', () => {
    expect(cashtagInstructions('#GoldNearRecordHigh')).not.toContain('The trending hashtag names');
  });
});

describe('normalizeCashtags', () => {
  const btcCtx = { hashtag: '#BitcoinHits100K', grounding: ['BTC last traded at $68,214.'] };

  it('keeps a grounded cashtag', () => {
    const r = normalizeCashtags('$BTC is flat today.', btcCtx);
    expect(r.text).toBe('$BTC is flat today.');
    expect(r.kept).toEqual(['BTC']);
    expect(r.removed).toEqual([]);
  });

  it('strips the $ from a cashtag nothing grounds (the $ENA-on-gold case)', () => {
    const r = normalizeCashtags('Gold bounced, and $ENA moved with it.', {
      hashtag: '#GoldReboundsNearly5%',
      grounding: ['Gold spot rose 4.8% on the week.'],
    });
    expect(r.text).toBe('Gold bounced, and ENA moved with it.');
    expect(r.removed).toEqual([{ ticker: 'ENA', reason: 'ungrounded' }]);
  });

  it('never keeps a cashtag for a non-coin acronym, even when the evidence names it', () => {
    const r = normalizeCashtags('The $SEC ruling is late.', {
      hashtag: '#ETFDecision',
      grounding: ['SEC delays the ruling.'],
    });
    expect(r.text).toBe('The SEC ruling is late.');
  });

  it('tags each coin once, at the first mention', () => {
    const r = normalizeCashtags('$BTC first. Then $BTC again.', btcCtx);
    expect(r.text).toBe('$BTC first. Then BTC again.');
    expect(r.removed).toEqual([{ ticker: 'BTC', reason: 'repeat' }]);
  });

  it(`caps the post at ${MAX_CASHTAGS} coins`, () => {
    const r = normalizeCashtags('$BTC, $ETH, $SOL and $XRP all moved.', {
      hashtag: '#MarketUpdate',
      grounding: ['BTC, ETH, SOL and XRP all moved.'],
    });
    expect(r.text).toBe('$BTC, $ETH, $SOL and XRP all moved.');
    expect(r.removed).toEqual([{ ticker: 'XRP', reason: 'over-cap' }]);
  });

  it('adds the $ to the first bare ticker of a coin the hashtag names', () => {
    const r = normalizeCashtags('BTC is near the level. BTC buyers wait.', btcCtx);
    expect(r.text).toBe('$BTC is near the level. BTC buyers wait.');
    expect(r.added).toEqual(['BTC']);
  });

  it('does not add a cashtag when the post only uses the full name', () => {
    const r = normalizeCashtags('Bitcoin is near the level.', btcCtx);
    expect(r.text).toBe('Bitcoin is near the level.');
    expect(r.added).toEqual([]);
  });

  it('does not add a cashtag for a coin only the evidence names', () => {
    const r = normalizeCashtags('ETH staking flows rose.', {
      hashtag: '#MarketUpdate',
      grounding: ['ETH staking flows rose.'],
    });
    expect(r.text).toBe('ETH staking flows rose.');
  });

  it('leaves dollar amounts and wrapped tickers alone', () => {
    const r = normalizeCashtags('WBTC supply and $68k and US$3.4B.', btcCtx);
    expect(r.text).toBe('WBTC supply and $68k and US$3.4B.');
    expect(r.kept).toEqual([]);
  });
});

describe('cashtagInstructions', () => {
  it('hints the coins the hashtag names', () => {
    expect(cashtagInstructions('#BitcoinHits100K')).toContain('The trending hashtag names: $BTC.');
  });

  it('gives no coin hint for a non-coin trend', () => {
    expect(cashtagInstructions('#GoldReboundsNearly5%')).not.toContain('The trending hashtag names');
  });
});
