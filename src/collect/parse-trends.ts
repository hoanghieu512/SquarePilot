export interface TradingPair {
  symbol: string;
  code: string;
  priceChange: string | null;
}

export interface Trend {
  hashtag: string;
  hashtagId: number | null;
  rank: number;
  viewCount: number;
  contentCount: number;
  tradingPairs: TradingPair[];
}

/**
 * Thrown when the embedded JSON no longer has the shape we parse.
 *
 * This must never degrade into an empty array: "Binance changed their page"
 * and "there are no trends today" would then look identical, and the pipeline
 * would quietly stop producing posts while reporting a quiet day.
 */
export class TrendParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrendParseError';
  }
}

const APP_DATA_RE = /<script[^>]*id="__APP_DATA"[^>]*>([\s\S]*?)<\/script>/;

/** Path is walked by name so a reordered payload still parses. */
const HASHTAGS_PATH = ['pageData', 'redux', 'ui', 'sidebarData', 'hashTags'] as const;

function walk(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  const seen: string[] = [];
  for (const key of path) {
    if (typeof node !== 'object' || node === null || !(key in node)) {
      throw new TrendParseError(
        `__APP_DATA is missing "${[...seen, key].join('.')}" — Binance changed the page structure`,
      );
    }
    node = (node as Record<string, unknown>)[key];
    seen.push(key);
  }
  return node;
}

function requireField<T>(row: Record<string, unknown>, key: string, index: number, check: (v: unknown) => v is T): T {
  const value = row[key];
  if (!check(value)) {
    throw new TrendParseError(
      `Trend at index ${index} has an unusable "${key}" (got ${JSON.stringify(value)}) — Binance changed the field`,
    );
  }
  return value;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Binance exposes the coins it associated with a topic in two places, and
 * populates neither reliably — measured 2026-08-21: `tradingPairDTOList` was
 * empty on all ten trends, `topContent.tradingPairs` on nine of ten. Read both,
 * dedupe, and treat the result as a bonus rather than a guaranteed field.
 */
function collectPairSources(row: Record<string, unknown>): unknown[] {
  const sources: unknown[] = [row.tradingPairDTOList];
  const top = row.topContent;
  if (typeof top === 'object' && top !== null) {
    sources.push((top as Record<string, unknown>).tradingPairs);
  }
  return sources;
}

function parsePairs(sources: unknown[]): TradingPair[] {
  const pairs: TradingPair[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (!isString(e.symbol) || !isString(e.code) || seen.has(e.symbol)) continue;
      seen.add(e.symbol);
      pairs.push({
        symbol: e.symbol,
        code: e.code,
        priceChange: isString(e.priceChange) ? e.priceChange : null,
      });
    }
  }
  return pairs;
}

/** Extract the trending list from a fully rendered trends page. */
export function parseTrends(html: string): Trend[] {
  const match = html.match(APP_DATA_RE);
  if (!match?.[1]) {
    throw new TrendParseError(
      'No __APP_DATA script in the page — the response is probably a Cloudflare challenge, not the trends page',
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(match[1]);
  } catch (err) {
    throw new TrendParseError(`__APP_DATA is not valid JSON: ${(err as Error).message}`);
  }

  const raw = walk(payload, HASHTAGS_PATH);
  if (!Array.isArray(raw)) {
    throw new TrendParseError(`Expected ${HASHTAGS_PATH.join('.')} to be an array, got ${typeof raw}`);
  }
  if (raw.length === 0) {
    throw new TrendParseError(
      'Trending list is empty — treated as a broken page, not a quiet day, so a silent failure cannot hide here',
    );
  }

  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TrendParseError(`Trend at index ${index} is not an object`);
    }
    const row = entry as Record<string, unknown>;
    const hashtag = requireField(row, 'hashtag', index, isString).trim();
    if (hashtag === '') {
      throw new TrendParseError(`Trend at index ${index} has an empty hashtag`);
    }

    return {
      hashtag,
      hashtagId: isNumber(row.hashtagId) ? row.hashtagId : null,
      rank: index + 1,
      viewCount: isNumber(row.viewCount) ? row.viewCount : 0,
      contentCount: isNumber(row.contentCount) ? row.contentCount : 0,
      tradingPairs: parsePairs(collectPairSources(row)),
    };
  });
}
