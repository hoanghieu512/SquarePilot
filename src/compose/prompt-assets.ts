import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('assets');

/**
 * Voice files live in Content-Creator and are read at run time, never copied.
 *
 * One source of truth for tone: editing the file changes both the hand-written
 * pipeline and this one, with no deploy. The cost is that a missing file has to
 * be a hard failure - a draft written without the anti-AI rules would read like
 * anyone's crypto post, and nothing downstream would notice.
 */
export interface VoiceAssets {
  aboutMe: string;
  toneGuidelines: string;
  antiAiRules: string;
}

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

function readRequired(dir: string, name: string): string {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    throw new AssetError(
      `Voice asset missing: ${file}. Drafting without it would produce a post in nobody's voice.`,
    );
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text.length < 200) {
    throw new AssetError(`Voice asset looks empty or truncated: ${file} (${text.length} chars)`);
  }
  return text;
}

/** English posts use `anti-ai-rules-en.md`; the VN file bans English density. */
export function loadVoiceAssets(contentCreatorDir: string): VoiceAssets {
  const assets = {
    aboutMe: readRequired(contentCreatorDir, 'about-me.md'),
    toneGuidelines: readRequired(contentCreatorDir, 'tone-guidelines.md'),
    antiAiRules: readRequired(contentCreatorDir, 'anti-ai-rules-en.md'),
  };
  logger.debug('Voice assets loaded', {
    aboutMe: assets.aboutMe.length,
    tone: assets.toneGuidelines.length,
    antiAi: assets.antiAiRules.length,
  });
  return assets;
}
