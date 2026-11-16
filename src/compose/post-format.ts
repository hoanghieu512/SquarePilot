/**
 * Small fixes to a draft's text that code can make with certainty, so they
 * never cost a rewrite.
 */

const YEAR = /^(19|20)\d{2}$/;

/**
 * Four or more digits with nothing grouping them, optionally after "$". Not
 * inside a word, a decimal, a time, a path or a code: the character before
 * may not be a letter, digit, "." "," ":" "/" "#" or "$", and the number may
 * not run on into a letter or a decimal part.
 */
const LONG_NUMBER = /(?<![\w.,:/#$])(\$?)(\d{4,})(?!\w|[.,:]\d)/g;

/**
 * "283050 views across 2344 posts" → "283,050 views across 2,344 posts".
 *
 * Years (1900 to 2099) are left as they are, and so is the hashtag line,
 * whose spelling routes the post to its topic.
 */
export function groupLongNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.trimStart().startsWith('#')
        ? line
        : line.replace(LONG_NUMBER, (match, dollar: string, digits: string) =>
            digits.length === 4 && YEAR.test(digits)
              ? match
              : `${dollar}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`,
          ),
    )
    .join('\n');
}

const MODEL_DISCLAIMER = /^\*?\s*(not (financial|investment) advice|nfa|dyor)\b/i;

/**
 * Drop a closing disclaimer the model wrote itself. Every post gets the
 * standard line appended (`withDisclaimer`), and a draft that ended with its
 * own "Not investment advice." would carry two.
 */
export function dropModelDisclaimer(text: string): string {
  const paras = text.trimEnd().split(/\n\s*\n/);
  const last = paras[paras.length - 1]!.trim();
  if (paras.length > 1 && last.length <= 80 && MODEL_DISCLAIMER.test(last)) {
    return paras.slice(0, -1).join('\n\n').trimEnd();
  }
  return text;
}
