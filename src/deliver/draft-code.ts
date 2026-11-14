export const DRAFT_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const BASE = DRAFT_CODE_ALPHABET.length;

const CHAR_TO_VAL = new Map<string, number>();
for (let i = 0; i < DRAFT_CODE_ALPHABET.length; i++) {
  CHAR_TO_VAL.set(DRAFT_CODE_ALPHABET[i]!, i);
}

export function draftCode(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid draft id: ${id}`);
  }
  let n = id;
  let out = '';
  while (n > 0) {
    const rem = n % BASE;
    out = DRAFT_CODE_ALPHABET[rem]! + out;
    n = Math.floor(n / BASE);
  }
  return out.padStart(2, DRAFT_CODE_ALPHABET[0]!);
}

export function parseDraftCode(code: string): number | null {
  if (typeof code !== 'string' || code.length < 2) return null;
  const upper = code.toUpperCase();
  let val = 0;
  for (let i = 0; i < upper.length; i++) {
    const digit = CHAR_TO_VAL.get(upper[i]!);
    if (digit === undefined) return null;
    val = val * BASE + digit;
    if (!Number.isSafeInteger(val)) return null;
  }
  return val >= 1 ? val : null;
}
