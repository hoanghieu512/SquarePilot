import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paperTexture } from '../src/pipeline.js';

describe('paperTexture', () => {
  it('finds the texture in the vault assets folder, and draws without one when it is absent', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-assets-'));
    expect(paperTexture(vault)).toBeUndefined();

    const dir = path.join(vault, 'outputs', 'visuals', 'assets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper-texture.jpg'), 'jpg');
    expect(paperTexture(vault)).toBe(path.join(dir, 'paper-texture.jpg'));

    // A PNG, when both exist, is preferred: it is the lossless one.
    fs.writeFileSync(path.join(dir, 'paper-texture.png'), 'png');
    expect(paperTexture(vault)).toBe(path.join(dir, 'paper-texture.png'));
  });
});
