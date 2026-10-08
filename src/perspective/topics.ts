import { significantWords } from './tension-finder.js';

/**
 * Map the concrete words in a hashtag to the abstract topics a lens declares.
 *
 * A lens says `applies_when: [macro, equities]`; a hashtag says
 * `#WarshSaysInflationIsFedTopFocus`. Comparing those two directly never
 * matches, so every lens was rejected as "does not cover" — the rung looked
 * like it was working while never firing once.
 *
 * A keyword table rather than a model: this decides whether a whole rung is
 * available, so it needs to be inspectable and to give the same answer twice.
 */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  macro: [
    'inflation', 'cpi', 'ppi', 'fed', 'fomc', 'powell', 'warsh', 'rate', 'rates',
    'yield', 'yields', 'treasury', 'bond', 'bonds', 'dollar', 'currency', 'jobless',
    'claims', 'unemployment', 'payrolls', 'gdp', 'recession', 'vix', 'volatility',
    'tariff', 'tariffs', 'economy', 'economic', 'deficit', 'hike', 'cut', 'easing',
  ],
  metrics: [
    'high', 'highest', 'low', 'lowest', 'record', 'surge', 'surges', 'jumps', 'plunge',
    'rebound', 'rebounds', 'gains', 'drops', 'week', 'month', 'year', 'since', 'above',
    'below', 'exceeds', 'tops', 'breaks',
  ],
  equities: [
    'stock', 'stocks', 'shares', 'shareholder', 'earnings', 'buyback', 'buybacks',
    'ipo', 'nasdaq', 'sp500', 'dow', 'samsung', 'micron', 'nvidia', 'walmart',
    'sandisk', 'xiaomi', 'strategy', 'mstr', 'dividend', 'preferred',
  ],
  price: ['price', 'usd', 'usdt', 'btc', 'eth', 'sol', 'bitcoin', 'ethereum', 'solana'],
  protocol: [
    'protocol', 'mainnet', 'testnet', 'upgrade', 'fork', 'layer', 'rollup', 'bridge',
    'staking', 'validator', 'consensus', 'glamsterdam', 'devnet', 'chain',
  ],
  mechanism: ['mechanism', 'proof', 'zk', 'circuit', 'settlement', 'clearing', 'custody'],
  policy: [
    'act', 'bill', 'congress', 'senate', 'regulation', 'regulator', 'sec', 'cftc',
    'doj', 'probe', 'lawsuit', 'compliance', 'clarity', 'genius', 'rules', 'proposed',
  ],
  exploit: ['exploit', 'hack', 'hacked', 'drained', 'breach', 'vulnerability', 'stolen'],
  custody: ['custody', 'custodian', 'depository', 'reserve', 'vault', 'wallet'],
  unlock: ['unlock', 'unlocks', 'vesting', 'lockup', 'cliff', 'expiry', 'expires'],
  'macro-release': ['data', 'report', 'print', 'release', 'announce', 'announces', 'friday'],
  listing: ['listing', 'listed', 'lists', 'launch', 'launches', 'debut'],
  exchange: ['binance', 'okx', 'coinbase', 'kraken', 'bybit', 'exchange'],
  'capital-structure': ['repurchase', 'issuance', 'raise', 'convertible', 'debt', 'equity'],
  'tokenized-stock': ['tokenized', 'xstocks', 'rwa'],
  ranking: ['rank', 'ranking', 'top', 'leads', 'leading', 'best', 'worst'],
  earnings: ['q1', 'q2', 'q3', 'q4', 'revenue', 'profit', 'loss', 'guidance'],
  index: ['index', 'sp', 'nasdaq', 'vix'],
  governance: ['governance', 'vote', 'proposal', 'dao'],
  'access-control': ['permission', 'whitelist', 'kyc', 'identity', 'license'],
  privacy: ['privacy', 'private', 'shielded', 'confidential'],
  counterparty: ['counterparty', 'issuer', 'broker', 'venue', 'clearinghouse'],
  outage: ['outage', 'halt', 'halted', 'suspend', 'suspended', 'downtime'],
  enforcement: ['enforcement', 'fine', 'penalty', 'charges', 'sues'],
  settlement: ['settle', 'settles', 'settlement', 'clearing', 't+2'],
  'market-structure': ['liquidity', 'orderbook', 'spread', 'maker', 'taker', 'venue'],
};

/**
 * Classify a hashtag into the topic vocabulary lenses are written against.
 *
 * Returns the concrete words too: an angle still matches on those, and a lens
 * whose `applies_when` happens to name a literal word keeps working.
 */
export function classifyTopics(hashtag: string): string[] {
  const words = new Set(significantWords(hashtag));
  const topics = new Set<string>(words);

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((k) => words.has(k))) topics.add(topic);
  }

  return [...topics];
}

export { TOPIC_KEYWORDS };
