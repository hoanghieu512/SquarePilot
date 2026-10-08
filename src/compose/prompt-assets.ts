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

/**
 * The numbered sections of `tone-guidelines.md` a Square post needs.
 *
 * §4 is the X thread and single-tweet format (about 8.6k characters); a Square
 * post takes its form from the mode instead. §6 lists what the file does not
 * contain, for a human editing it. Everything else goes in whole: the earlier
 * fixed character cut ended about-me halfway through Hard Nos and nobody saw.
 */
export const TONE_SECTIONS = ['0', '1', '2', '3', '5'];

/**
 * Above this, the voice layers have grown enough to be worth trimming at the
 * source. A warning, not a cut: cutting is what hid Hard Nos from the drafter.
 */
export const VOICE_BUDGET_CHARS = 36_000;

/**
 * Keep the preamble plus the `## <n>.` sections listed, in file order.
 *
 * A listed section that cannot be found is an error. The file is edited by
 * hand and a renamed heading would otherwise drop a whole section silently.
 */
export function selectSections(markdown: string, keep: string[], fileName: string): string {
  const parts = markdown.split(/^(?=## )/m);
  const preamble = parts[0]!.startsWith('## ') ? '' : parts.shift()!;

  const numberOf = (part: string) => part.match(/^## (\d+)\./)?.[1];
  const found = new Set(parts.map(numberOf).filter(Boolean));
  const missing = keep.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new AssetError(
      `${fileName}: section ${missing.join(', ')} not found (expected a heading like "## ${missing[0]}. ..."). ` +
        'It may have been renamed; update TONE_SECTIONS rather than drafting without it.',
    );
  }

  const kept = parts.filter((p) => keep.includes(numberOf(p) ?? ''));
  return [preamble, ...kept].join('').trim();
}

/** English posts use `anti-ai-rules-en.md`; the VN file bans English density. */
export function loadVoiceAssets(contentCreatorDir: string): VoiceAssets {
  const assets = {
    aboutMe: readRequired(contentCreatorDir, 'about-me.md'),
    toneGuidelines: selectSections(
      readRequired(contentCreatorDir, 'tone-guidelines.md'),
      TONE_SECTIONS,
      'tone-guidelines.md',
    ),
    antiAiRules: readRequired(contentCreatorDir, 'anti-ai-rules-en.md'),
  };

  const total = assets.aboutMe.length + assets.toneGuidelines.length + assets.antiAiRules.length;
  logger.debug('Voice assets loaded', {
    aboutMe: assets.aboutMe.length,
    tone: assets.toneGuidelines.length,
    antiAi: assets.antiAiRules.length,
  });
  if (total > VOICE_BUDGET_CHARS) {
    logger.warn(
      `Voice layers total ${total} characters, over the ${VOICE_BUDGET_CHARS} budget. ` +
        'Nothing is cut; consider tightening the files in Content-Creator.',
    );
  }
  return assets;
}
