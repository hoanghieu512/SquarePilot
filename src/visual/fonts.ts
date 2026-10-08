import fs from 'node:fs';

export interface LoadedFont {
  name: string;
  data: Buffer;
  weight: 400 | 700 | 900;
  style: 'normal';
}

/**
 * Satori needs font buffers; it cannot look anything up by name.
 *
 * The visual guidelines name DejaVu Serif and Liberation Mono, neither of which
 * ships with macOS. The notes in higgsfield-notes.md suggest SFNSMono, but that
 * advice was for PIL: measured 2026-09-30, satori fails on every font in
 * `/System/Library/Fonts` proper - NewYork and SFNSMono both throw while
 * parsing, because Apple ships them in a format the parser does not read.
 * Everything in `Supplemental/` works.
 *
 * Georgia and Courier New are the picks, and they happen to suit the style
 * better than the originals: a sturdy old-print serif, and a typewriter face
 * for the labels. Both carry Vietnamese diacritics, which matters even though
 * Square posts are English - the same renderer serves the Vietnamese pipeline.
 *
 * `.ttc` collections are avoided: the parser reads a single face.
 */
const CANDIDATES = {
  serif: [
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
  ],
  mono: [
    '/System/Library/Fonts/Supplemental/Courier New.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
  ],
} as const;

export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontError';
  }
}

function firstAvailable(paths: readonly string[], kind: string): string {
  const found = paths.find((p) => fs.existsSync(p));
  if (!found) {
    throw new FontError(
      `No ${kind} font found. Looked in: ${paths.join(', ')}. ` +
        'Install one or add its path to CANDIDATES.',
    );
  }
  return found;
}

let cache: LoadedFont[] | null = null;

export function loadFonts(): LoadedFont[] {
  if (cache) return cache;

  const serif = fs.readFileSync(firstAvailable(CANDIDATES.serif, 'serif'));
  const mono = fs.readFileSync(firstAvailable(CANDIDATES.mono, 'mono'));

  // Satori matches on family name, so both weights of the serif point at the
  // same file: the renderer asks for 900 on the focal number and 700 elsewhere.
  cache = [
    { name: 'Display', data: serif, weight: 900, style: 'normal' },
    { name: 'Display', data: serif, weight: 700, style: 'normal' },
    { name: 'Label', data: mono, weight: 700, style: 'normal' },
    { name: 'Label', data: mono, weight: 400, style: 'normal' },
  ];
  return cache;
}

/** Test seam: drop the cache so a missing-font case can be exercised. */
export function resetFontCache(): void {
  cache = null;
}
