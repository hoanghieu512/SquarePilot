import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SAME_SHAPE,
  checkShape,
  measureShape,
  paragraphsOf,
  shapeDistance,
} from '../src/compose/shape-scorer.js';

const SQUARE_DIR = '/Users/lavopavden/Dev/vault/projects/content-creator/outputs/square';

/** Strip frontmatter, the backref line, headings and [meta] annotations. */
function bodyOf(raw: string): string {
  const afterFront = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  const out: string[] = [];
  let started = false;
  for (const line of afterFront.split('\n')) {
    const t = line.trim();
    if (/^##\s*Nguồn/i.test(t) || /^\*Not financial advice/i.test(t)) break;
    if (!started) {
      if (t === '' || t.startsWith('_←') || t.startsWith('##') || t.startsWith('[')) continue;
      started = true;
    }
    if (t === '---') break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function readDusk(date: string): string | null {
  const file = path.join(SQUARE_DIR, `${date}-dusk-square-post.md`);
  return fs.existsSync(file) ? bodyOf(fs.readFileSync(file, 'utf8')) : null;
}

describe('measureShape', () => {
  it('counts paragraphs and ignores a hashtag-only line', () => {
    const m = measureShape('First para.\n\nSecond para.\n\n#dusk');
    expect(m.paragraphs).toBe(2);
  });

  it('reports low variety when every paragraph is the same length', () => {
    const even = Array(6).fill('One two three four five six seven eight.').join('\n\n');
    expect(measureShape(even).cv).toBeLessThan(0.1);
  });

  it('reports high variety when lengths differ sharply', () => {
    const uneven = ['Short.', 'word '.repeat(60), 'Also short.', 'word '.repeat(40)].join('\n\n');
    expect(measureShape(uneven).cv).toBeGreaterThan(0.4);
  });

  it('locates the take by its marker', () => {
    const text = ['Opening.', 'Middle.', 'My take: this is the part that matters.'].join('\n\n');
    expect(measureShape(text).takePosition).toBe(1);
  });

  it('returns null when no take marker is present, rather than guessing', () => {
    expect(measureShape('Just facts.\n\nMore facts.').takePosition).toBeNull();
  });

  it('classifies the opening', () => {
    expect(measureShape('206,000 claims last week.').opening).toBe('NUM');
    expect(measureShape('I checked the filing.').opening).toBe('SELF');
    expect(measureShape('"Quoted," they said.').opening).toBe('QUOTE');
    expect(measureShape('Treasury buybacks rose.').opening).toBe('WORD');
  });
});

describe('shapeDistance', () => {
  it('gives zero for a post compared with itself', () => {
    const m = measureShape('One.\n\nTwo three four.\n\nMy take: five.');
    expect(shapeDistance(m, m)).toBe(0);
  });

  it('skips a dimension neither post has, instead of treating absence as agreement', () => {
    const a = measureShape('Alpha.\n\nBravo charlie.');
    const b = measureShape('Delta.\n\nEcho foxtrot.');
    expect(Number.isNaN(shapeDistance(a, b))).toBe(false);
  });
});

describe('checkShape', () => {
  it('passes when there is nothing to compare against', () => {
    expect(checkShape('Anything.', []).ok).toBe(true);
  });

  it('flags a draft that copies the rhythm of a recent post', () => {
    const post = ['Alpha bravo charlie.', 'Delta echo foxtrot.', 'My take: golf hotel.'].join('\n\n');
    const twin = ['Kilo lima mike.', 'November oscar papa.', 'My take: quebec romeo.'].join('\n\n');

    const verdict = checkShape(twin, [post]);
    expect(verdict.ok).toBe(false);
    expect(verdict.nearest).toBeLessThan(SAME_SHAPE);
  });

  it('gives numbers to change, not the advice to be different', () => {
    const post = ['Alpha bravo charlie.', 'Delta echo foxtrot.', 'My take: golf hotel.'].join('\n\n');
    const twin = ['Kilo lima mike.', 'November oscar papa.', 'My take: quebec romeo.'].join('\n\n');

    const { constraints } = checkShape(twin, [post]);
    expect(constraints.length).toBeGreaterThan(0);
    expect(constraints.join(' ')).toMatch(/paragraphs|judgement|question|single short line/);
    // "Be different" is the instruction that produced the repetition.
    expect(constraints.join(' ')).not.toMatch(/be different|vary it|mix it up/i);
  });

  it('passes a draft shaped unlike anything recent', () => {
    const post = ['Alpha bravo charlie.', 'Delta echo foxtrot.', 'My take: golf hotel.'].join('\n\n');
    const different = ['My take: right away.', 'word '.repeat(80), 'Short.', 'Is that the point?'].join('\n\n');
    expect(checkShape(different, [post]).ok).toBe(true);
  });
});

describe('against the real corpus', () => {
  it('reproduces the judgement that the last two Dusk posts share a shape', () => {
    // Huynh read 17/08, 18/08 and 19/08 and said the last two repeated the
    // format, while the declared rotation claimed all four axes differed.
    // If the scorer cannot reproduce that reading, it is measuring the wrong
    // thing and the gate built on it is worthless.
    const d17 = readDusk('2026-08-17');
    const d18 = readDusk('2026-08-18');
    const d19 = readDusk('2026-08-19');
    if (!d17 || !d18 || !d19) return; // corpus not present on this machine

    const [m17, m18, m19] = [measureShape(d17), measureShape(d18), measureShape(d19)];
    const late = shapeDistance(m18, m19);
    const early = shapeDistance(m17, m18);

    // The pair he called repetitive must sit closer than the pair he did not.
    expect(late).toBeLessThan(early);

    // And the gate must actually stop it. Ordering alone would let a threshold
    // sit above both and catch nothing, which is what 0.12 did.
    expect(late).toBeLessThan(SAME_SHAPE);
    expect(checkShape(d19, [d18]).ok).toBe(false);
  });

  it('measures every published Square post without throwing', () => {
    if (!fs.existsSync(SQUARE_DIR)) return;
    const files = fs.readdirSync(SQUARE_DIR).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const body = bodyOf(fs.readFileSync(path.join(SQUARE_DIR, file), 'utf8'));
      if (paragraphsOf(body).length === 0) continue;
      const m = measureShape(body);
      expect(m.paragraphs).toBeGreaterThan(0);
      expect(m.cv).toBeGreaterThanOrEqual(0);
      expect(m.shortSentenceRatio).toBeLessThanOrEqual(1);
    }
  });
});
