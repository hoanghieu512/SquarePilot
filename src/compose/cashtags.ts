import { hashtagToHeadline } from './data-gate.js';

/**
 * Cashtags (`$BTC`) on Binance Square.
 *
 * Square parses a `$TICKER` in the body into a coin link, and Write to Earn
 * (from 2026-10-19) pays a commission when a reader trades through it. Its own
 * tips cap a post at three. The PRD bounds them further (US#34): a cashtag only
 * for a coin the post is actually about, and never inferred from the trend's
 * `tradingPairs`, because Binance mapped #GoldReboundsNearly5% to $ENA.
 *
 * So the model writes cashtags (it knows what the post is about), and this
 * module only enforces: a cashtag must be grounded in the hashtag or the
 * evidence, each coin is tagged once, at most three. The single thing it adds
 * is the `$` on the first bare ticker of a coin the hashtag itself names,
 * because a post about the trending coin without its cashtag loses the link.
 */

export const MAX_CASHTAGS = 3;

interface Coin {
  ticker: string;
  /** Full names, matched as whole words. Uppercase, no spaces (hashtags have none). */
  names: string[];
}

/** Coins common enough on Square trends to recognise by name as well as ticker. */
export const KNOWN_COINS: readonly Coin[] = [
  { ticker: 'BTC', names: ['BITCOIN'] },
  { ticker: 'ETH', names: ['ETHEREUM', 'ETHER'] },
  { ticker: 'BNB', names: [] },
  { ticker: 'SOL', names: ['SOLANA'] },
  { ticker: 'XRP', names: [] },
  { ticker: 'DOGE', names: ['DOGECOIN'] },
  { ticker: 'ADA', names: ['CARDANO'] },
  { ticker: 'TON', names: ['TONCOIN'] },
  { ticker: 'TRX', names: ['TRON'] },
  { ticker: 'AVAX', names: [] },
  { ticker: 'LINK', names: ['CHAINLINK'] },
  { ticker: 'DOT', names: ['POLKADOT'] },
  { ticker: 'LTC', names: ['LITECOIN'] },
  { ticker: 'SUI', names: [] },
  { ticker: 'NEAR', names: [] },
  { ticker: 'PEPE', names: [] },
  { ticker: 'SHIB', names: ['SHIBAINU'] },
  { ticker: 'USDT', names: ['TETHER'] },
  { ticker: 'USDC', names: [] },
];

/**
 * Tickers that are also everyday English words. Upper-casing a hashtag or a
 * sentence turns "#GoldNearRecordHigh" or "traded near $2,700" into NEAR, so
 * these count only when written in capitals in the original text ("#NEARBreaks",
 * "NEAR rose"). Names that are common words (Ripple, Avalanche) are not names.
 */
const WORD_TICKERS = new Set(['NEAR', 'LINK', 'DOT', 'TON']);

/**
 * Upper-case tokens that look like tickers but name no coin. Evidence is full
 * of them, and `$SEC` or `$ETF` would link the post to whatever token happens
 * to squat that symbol.
 */
const NOT_COINS = new Set([
  'AI', 'AML', 'API', 'APR', 'APY', 'ATH', 'ATL', 'CEO', 'CEX', 'CFO', 'CFTC', 'CNY', 'CPI',
  'DAO', 'DEX', 'ET', 'ETF', 'ETFS', 'EU', 'EUR', 'FED', 'FOMC', 'FUD', 'GDP', 'IPO', 'JPY',
  'KYC', 'MEV', 'NFT', 'NYSE', 'OTC', 'PCE', 'PPI', 'RWA', 'SEC', 'TPS', 'TVL', 'UK', 'US',
  'USA', 'USD', 'UTC',
]);

const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
const UPPER_TOKEN_RE = /\b[A-Z][A-Z0-9]{1,9}\b/g;

export interface CashtagContext {
  hashtag: string;
  /** Evidence and perspective summary: what the post may be about. */
  grounding: string[];
}

export interface CashtagResult {
  text: string;
  kept: string[];
  /** Cashtags turned back into plain tickers, with the reason. */
  removed: { ticker: string; reason: 'ungrounded' | 'repeat' | 'over-cap' }[];
  added: string[];
}

/** Coins named by full name in a set of upper-cased words. Names only, never tickers. */
function coinsByName(words: Set<string>): string[] {
  return KNOWN_COINS.filter((c) => c.names.some((n) => words.has(n))).map((c) => c.ticker);
}

/** Coins the trending hashtag itself names, in KNOWN_COINS order. */
export function hashtagCoins(hashtag: string): string[] {
  const words = new Set(hashtagToHeadline(hashtag).split(/[^A-Z0-9]+/).filter(Boolean));
  const raw = hashtag.replace(/^#/, '');
  return KNOWN_COINS.filter((c) => {
    if (c.names.some((n) => words.has(n))) return true;
    if (!words.has(c.ticker)) return false;
    // A word ticker must be written in capitals in the hashtag itself.
    return !WORD_TICKERS.has(c.ticker) || new RegExp(`(?<![A-Z])${c.ticker}(?![a-z])`).test(raw);
  }).map((c) => c.ticker);
}

/**
 * Every ticker the post could legitimately be about: the hashtag's coins, and
 * from the evidence only explicit cashtags, tickers written in capitals, and
 * full coin names.
 */
export function groundedTickers(ctx: CashtagContext): Set<string> {
  const out = new Set<string>(hashtagCoins(ctx.hashtag));
  for (const text of ctx.grounding) {
    for (const m of text.matchAll(CASHTAG_RE)) out.add(m[1]!.toUpperCase());
    for (const m of text.matchAll(UPPER_TOKEN_RE)) out.add(m[0]);
    const words = new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
    for (const t of coinsByName(words)) out.add(t);
  }
  for (const t of NOT_COINS) out.delete(t);
  return out;
}

export function normalizeCashtags(text: string, ctx: CashtagContext): CashtagResult {
  const grounded = groundedTickers(ctx);
  const kept: string[] = [];
  const removed: CashtagResult['removed'] = [];

  let out = text.replace(CASHTAG_RE, (whole, symbol: string) => {
    const ticker = symbol.toUpperCase();
    if (!grounded.has(ticker)) {
      removed.push({ ticker, reason: 'ungrounded' });
      return symbol;
    }
    if (kept.includes(ticker)) {
      removed.push({ ticker, reason: 'repeat' });
      return symbol;
    }
    if (kept.length >= MAX_CASHTAGS) {
      removed.push({ ticker, reason: 'over-cap' });
      return symbol;
    }
    kept.push(ticker);
    return whole;
  });

  const added: string[] = [];
  for (const ticker of hashtagCoins(ctx.hashtag)) {
    if (kept.includes(ticker) || kept.length >= MAX_CASHTAGS) continue;
    const bare = new RegExp(`(?<![$\\w])${ticker}\\b`);
    if (!bare.test(out)) continue;
    out = out.replace(bare, () => `$${ticker}`);
    kept.push(ticker);
    added.push(ticker);
  }

  return { text: out, kept, removed, added };
}

/** The drafter's instruction, with the coins the hashtag names as a hint. */
export function cashtagInstructions(hashtag: string): string {
  const coins = hashtagCoins(hashtag);
  const lines = [
    '### Cashtags',
    '',
    '- When the post is about a specific coin, write its ticker as a cashtag at the first mention, for example $BTC. Later mentions stay plain.',
    `- Only coins the post is actually about, at most ${MAX_CASHTAGS}. No cashtag for a coin mentioned in passing, and none when the topic is not a coin (stocks, gold, rates, a company).`,
    '- Never write a cashtag for a coin that is not in the hashtag or the evidence.',
  ];
  if (coins.length > 0) {
    lines.push(`- The trending hashtag names: ${coins.map((c) => `$${c}`).join(', ')}.`);
  }
  return lines.join('\n');
}
