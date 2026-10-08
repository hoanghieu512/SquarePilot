import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetError, loadVoiceAssets, selectSections } from '../src/compose/prompt-assets.js';

const TONE = `# Tone Guidelines

Intro paragraph.

## 0. Meta Rule
Meta text.

## 1. Core Voice
Voice text.

## 2. Personal Anchor
ANCHOR-SECTION

## 3. Slang
Slang text.

## 4. Structure (Cấu trúc bài viết)
X-THREAD-FORMAT

## 5. Vốn kỹ thuật
Craft text.

## 6. File này KHÔNG chứa gì
META-FOR-HUMANS
`;

describe('selectSections', () => {
  it('keeps the preamble and the numbered sections asked for, in order', () => {
    const out = selectSections(TONE, ['1', '2'], 'tone.md');

    expect(out).toContain('Intro paragraph.');
    expect(out).toContain('Voice text.');
    expect(out).toContain('ANCHOR-SECTION');
    expect(out).not.toContain('Meta text.');
    expect(out.indexOf('Voice text.')).toBeLessThan(out.indexOf('ANCHOR-SECTION'));
  });

  it('fails when a section it relies on has been renamed or removed', () => {
    // Dropping it silently is the failure this replaces: a cut nobody notices.
    const without2 = TONE.replace('## 2. Personal Anchor', '## Personal Anchor');
    expect(() => selectSections(without2, ['2'], 'tone.md')).toThrow(AssetError);
    expect(() => selectSections(without2, ['2'], 'tone.md')).toThrow(/section 2/);
  });
});

describe('loadVoiceAssets', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cc-'));
    // About-me longer than the old 6000-character cut, with a marker at the end.
    fs.writeFileSync(path.join(dir, 'about-me.md'), `${'About. '.repeat(1200)}\nHARD-NOS-TAIL`);
    fs.writeFileSync(path.join(dir, 'tone-guidelines.md'), TONE + 'x'.repeat(200));
    fs.writeFileSync(path.join(dir, 'anti-ai-rules-en.md'), 'Rule E5. '.repeat(40));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads about-me whole, so the boundaries at its end reach the drafter', () => {
    expect(loadVoiceAssets(dir).aboutMe).toContain('HARD-NOS-TAIL');
  });

  it('keeps the tone sections that apply to a Square post and drops the X thread format', () => {
    const tone = loadVoiceAssets(dir).toneGuidelines;

    expect(tone).toContain('ANCHOR-SECTION');
    expect(tone).toContain('Craft text.');
    expect(tone).not.toContain('X-THREAD-FORMAT');
    expect(tone).not.toContain('META-FOR-HUMANS');
  });
});
