/**
 * Character counting for Binance Square.
 *
 * The app counts UTF-16 code units of the NFD form, so an accented Vietnamese
 * vowel costs two or three. Measured on a real post: 1580 NFC read as 1990 in
 * the app, a ratio of 1.26. Counting with `.length` would let a post through
 * at 1710 that the app rejects at 2233.
 */
export const HARD_CAP_NFD = 2100;

/** Warn here so a hashtag can still be prepended without breaching the cap. */
export const WARN_NFD = 1900;

/** English posts sit far below the cap; this is the density target, not a limit. */
export const TARGET_NFC = 1600;

export interface Lengths {
  nfc: number;
  nfd: number;
}

export function measure(text: string): Lengths {
  return { nfc: text.normalize('NFC').length, nfd: text.normalize('NFD').length };
}

/** The annotation format already used by hand-written posts in the vault. */
export function formatCount(text: string): string {
  const { nfc, nfd } = measure(text);
  return nfc === nfd
    ? `[char count: ${nfc}/${HARD_CAP_NFD}]`
    : `[char count: ${nfc} NFC / **${nfd} NFD** - app Binance đếm NFD, giới hạn ${HARD_CAP_NFD}]`;
}

export interface ComposeResult {
  body: string;
  lengths: Lengths;
  /** True when the body had to be shortened to fit. */
  truncated: boolean;
}

export class TextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextValidationError';
  }
}

function trimToNfd(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.normalize('NFD').length <= budget) return { text, truncated: false };

  // Cut on paragraph, then sentence, then word - never mid-word.
  const paragraphs = text.split(/\n{2,}/);
  while (paragraphs.length > 1) {
    paragraphs.pop();
    const candidate = paragraphs.join('\n\n');
    if (candidate.normalize('NFD').length <= budget) return { text: candidate, truncated: true };
  }

  const sentences = (paragraphs[0] ?? '').split(/(?<=[.!?])\s+/);
  while (sentences.length > 1) {
    sentences.pop();
    const candidate = sentences.join(' ');
    if (candidate.normalize('NFD').length <= budget) return { text: candidate, truncated: true };
  }

  const words = (sentences[0] ?? '').split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const candidate = words.join(' ');
    if (candidate.normalize('NFD').length <= budget) return { text: candidate, truncated: true };
  }

  throw new TextValidationError(`Cannot fit any content within ${budget} NFD units`);
}

/**
 * Attach the trend hashtag and make the result fit.
 *
 * The hashtag is budgeted *before* the body is trimmed. Appending it afterwards
 * is how a post that measured 2090 ends up at 2131 and gets cut by the server,
 * which removes the hashtag first - the one part that cannot be lost, since the
 * API has no hashtag field and the tag in the text is what routes the post.
 */
export function composePost(body: string, hashtag: string, cap = HARD_CAP_NFD): ComposeResult {
  const tag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  const prefix = `${tag}\n\n`;
  const prefixCost = prefix.normalize('NFD').length;

  if (prefixCost >= cap) {
    throw new TextValidationError(`Hashtag ${tag} alone exceeds the ${cap} NFD budget`);
  }

  const { text, truncated } = trimToNfd(body.trim(), cap - prefixCost);
  const composed = prefix + text;
  return { body: composed, lengths: measure(composed), truncated };
}

export function withinCap(text: string, cap = HARD_CAP_NFD): boolean {
  return text.normalize('NFD').length <= cap;
}
