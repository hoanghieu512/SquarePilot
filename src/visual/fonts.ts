import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('fonts');

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

/**
 * Display and label faces from Fontshare (chosen 2026-11-16, the system
 * faces read thin and plain on the card).
 *
 * The files are not in this repository and must never be: the ITF Free Font
 * License allows the fonts in published images but forbids redistributing
 * the files, including through a public repository, and forbids converting
 * or subsetting them. Each owner downloads them from fontshare.com into the
 * font folder (`SQUAREPILOT_FONT_DIR`, default `~/.squarepilot/fonts`), one
 * folder per package as unzipped, and the official OTF files are read as they
 * are. Paths below are relative to that folder.
 */
interface FontSet {
  display900: string;
  display700: string;
  label700: string;
  label400: string;
}

const AZERET = 'azeret-mono/AzeretMono_Complete/Fonts/OTF/AzeretMono';

export const FONT_SETS: Record<string, FontSet> = {
  'zodiak-azeret': {
    display900: 'zodiak/Zodiak_Complete/Fonts/OTF/Zodiak-Black.otf',
    display700: 'zodiak/Zodiak_Complete/Fonts/OTF/Zodiak-Bold.otf',
    label700: `${AZERET}-Bold.otf`,
    label400: `${AZERET}-Regular.otf`,
  },
  'bespoke-serif-azeret': {
    display900: 'bespoke-serif/BespokeSerif_Complete/Fonts/OTF/BespokeSerif-Extrabold.otf',
    display700: 'bespoke-serif/BespokeSerif_Complete/Fonts/OTF/BespokeSerif-Bold.otf',
    label700: `${AZERET}-Bold.otf`,
    label400: `${AZERET}-Regular.otf`,
  },
};

/**
 * Zodiak for headlines and the focal number, Azeret Mono for labels: picked
 * 2026-11-16 from four Fontshare pairings drawn on the same card, for the
 * heaviest, most even figures. Bespoke Serif is the kept alternative
 * (`SQUAREPILOT_FONT_SET=bespoke-serif-azeret`); "system" draws with the
 * macOS faces.
 */
export const DEFAULT_FONT_SET = 'zodiak-azeret';

export function fontDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUAREPILOT_FONT_DIR?.trim() || path.join(os.homedir(), '.squarepilot', 'fonts');
}

function systemFonts(): LoadedFont[] {
  const serif = fs.readFileSync(firstAvailable(CANDIDATES.serif, 'serif'));
  const mono = fs.readFileSync(firstAvailable(CANDIDATES.mono, 'mono'));
  // Satori matches on family name, so both weights of the serif point at the
  // same file: the renderer asks for 900 on the focal number and 700 elsewhere.
  return [
    { name: 'Display', data: serif, weight: 900, style: 'normal' },
    { name: 'Display', data: serif, weight: 700, style: 'normal' },
    { name: 'Label', data: mono, weight: 700, style: 'normal' },
    { name: 'Label', data: mono, weight: 400, style: 'normal' },
  ];
}

const cache = new Map<string, LoadedFont[]>();

/**
 * The faces the card is drawn with. A named set whose files are missing
 * falls back to the system faces with a warning: a card in the old faces is
 * better than no card, since there is no post without one.
 */
export function loadFonts(
  opts: { set?: string; dir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): LoadedFont[] {
  const name = opts.set ?? (env.SQUAREPILOT_FONT_SET?.trim() || DEFAULT_FONT_SET);
  const dir = opts.dir ?? fontDir(env);
  const key = `${name}@${dir}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let fonts: LoadedFont[];
  const set = FONT_SETS[name];
  if (name === 'system') {
    fonts = systemFonts();
  } else if (!set) {
    throw new FontError(`Unknown font set "${name}". Known: system, ${Object.keys(FONT_SETS).join(', ')}`);
  } else {
    const files = [set.display900, set.display700, set.label700, set.label400].map((f) => path.join(dir, f));
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length > 0) {
      logger.warn(`Font set "${name}" is missing ${missing.length} file(s) under ${dir}; drawing with the system faces`, {
        missing: missing.map((f) => path.relative(dir, f)),
      });
      fonts = systemFonts();
    } else {
      const [d9, d7, l7, l4] = files.map((f) => fs.readFileSync(f));
      fonts = [
        { name: 'Display', data: d9!, weight: 900, style: 'normal' },
        { name: 'Display', data: d7!, weight: 700, style: 'normal' },
        { name: 'Label', data: l7!, weight: 700, style: 'normal' },
        { name: 'Label', data: l4!, weight: 400, style: 'normal' },
        // None of the Fontshare faces has the full Vietnamese set (ơ, ư and
        // most tone marks are missing, checked 2026-11-16). Satori takes a
        // glyph a face lacks from any other loaded font, so the system faces
        // ride along and a stray accented letter draws instead of a box.
        ...systemFonts().map((f) => ({ ...f, name: `${f.name}Fallback` })),
      ];
    }
  }
  cache.set(key, fonts);
  return fonts;
}

/** Test seam: drop the cache so a missing-font case can be exercised. */
export function resetFontCache(): void {
  cache.clear();
}
