import { USER_AGENT } from './browser.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('hashtag');

const ENDPOINT = 'https://www.binance.com/bapi/composite/v4/friendly/pgc/content/queryByHashtag';

export interface HashtagPost {
  id: string | null;
  authorName: string | null;
  text: string;
  likeCount: number;
  viewCount: number;
}

export class HashtagReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashtagReadError';
  }
}

interface RawPost {
  id?: unknown;
  contentId?: unknown;
  authorName?: unknown;
  authorInfo?: { nickName?: unknown };
  title?: unknown;
  subTitle?: unknown;
  content?: unknown;
  likeCount?: unknown;
  viewCount?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The payload names the body differently per post kind; take the first that has text. */
function bodyOf(post: RawPost): string {
  return str(post.content) ?? str(post.subTitle) ?? str(post.title) ?? '';
}

export function parseHashtagPosts(payload: unknown): HashtagPost[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new HashtagReadError('queryByHashtag returned a non-object response');
  }
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    throw new HashtagReadError('queryByHashtag response has no "data" object');
  }
  const list = (data as { feedData?: unknown }).feedData;
  if (!Array.isArray(list)) {
    throw new HashtagReadError(
      `queryByHashtag response has no array at data.feedData (got ${typeof list}) — Binance changed the payload`,
    );
  }

  return list
    .filter((p): p is RawPost => typeof p === 'object' && p !== null)
    .map((p) => ({
      id: str(p.id) ?? str(p.contentId),
      authorName: str(p.authorName) ?? str(p.authorInfo?.nickName),
      text: bodyOf(p),
      likeCount: num(p.likeCount),
      viewCount: num(p.viewCount),
    }))
    .filter((p) => p.text !== '');
}

/**
 * Read what is already being written under a hashtag.
 *
 * Two uses downstream: avoiding an angle the top posts already took, and
 * feeding tension-finder — a point everyone agrees on too easily is where a
 * tension usually hides.
 */
export async function readHashtagPosts(hashtag: string, pageSize = 20): Promise<HashtagPost[]> {
  const tag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  const url = `${ENDPOINT}?hashtag=${encodeURIComponent(tag)}&pageIndex=1&pageSize=${pageSize}&orderBy=HOT`;

  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', lang: 'en', clienttype: 'web' },
  });

  if (!response.ok) {
    throw new HashtagReadError(`queryByHashtag failed for ${tag}: HTTP ${response.status}`);
  }

  const posts = parseHashtagPosts(await response.json().catch(() => null));
  logger.debug(`${tag}: ${posts.length} posts read`);
  return posts;
}
