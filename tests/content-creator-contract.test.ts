import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERSONA_PHRASES } from '../src/compose/persona-guard.js';
import { VOICE_BUDGET_CHARS, loadVoiceAssets } from '../src/compose/prompt-assets.js';
import { buildPrompt } from '../src/compose/drafter.js';
import { MODE_SPECS } from '../src/compose/modes.js';
import { parseAnchorBank } from '../src/perspective/anchor-bank.js';

/**
 * Checks against the real Content-Creator files, which this project reads but
 * does not own. The unit tests run on fixtures, so a layer edit over there can
 * break an assumption here while every other test stays green.
 *
 * Skipped when the sibling checkout is absent, so the suite still runs elsewhere.
 */
const CC_DIR = fileURLToPath(new URL('../../Content-Creator/', import.meta.url));
const VAULT_DIR = fileURLToPath(new URL('../../../vault/projects/content-creator/', import.meta.url));
const hasContentCreator = fs.existsSync(CC_DIR);
const hasVault = fs.existsSync(VAULT_DIR);

function phrasesInShapeAnalyzer(): string[] {
  const src = fs.readFileSync(`${CC_DIR}tools/shape-analyzer.mjs`, 'utf8');
  const block = src.match(/const PERSONA_PHRASES = \[([\s\S]*?)\];/);
  if (!block) throw new Error('PERSONA_PHRASES not found in shape-analyzer.mjs');
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe.skipIf(!hasContentCreator)('Content-Creator contract', () => {
  it('reads the phrase list out of shape-analyzer', () => {
    const phrases = phrasesInShapeAnalyzer();
    expect(phrases).toContain('QA');
    expect(phrases.length).toBeGreaterThanOrEqual(10);
  });

  it('bans every phrase here that the X pipeline bans', () => {
    // Same account on Square for both pipelines. A phrase missing on this side
    // is a phrase the cap quietly allows here and refuses there.
    const ours = new Set(PERSONA_PHRASES.map((p) => p.toLowerCase()));
    const missing = phrasesInShapeAnalyzer().filter((p) => !ours.has(p.toLowerCase()));
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!hasContentCreator)('voice layers as the drafter receives them', () => {
  const prompt = () =>
    buildPrompt({
      trend: { hashtag: '#T', hashtagId: 1, rank: 1, viewCount: 1, contentCount: 1, tradingPairs: [] },
      perspective: { kind: 'tension', ref: 't', summary: 's', evidence: ['e'], guardrails: [] },
      mode: MODE_SPECS.observation,
      topPosts: [],
      assets: loadVoiceAssets(CC_DIR),
      anchor: { tier: 'stance', ref: null, material: [], mayNameJob: false },
    });

  it('includes all of Hard Nos, down to the line on invented anchors', () => {
    const p = prompt();
    expect(p).toContain('Về thông tin nghề nghiệp');
    expect(p).toContain('Personal anchor bịa thì');
  });

  it('includes the anchor section of the tone guidelines', () => {
    expect(prompt()).toContain('Personal Anchor (đặc điểm nhận dạng của voice)');
  });

  it(`keeps the three files within ${VOICE_BUDGET_CHARS} characters`, () => {
    // A tripwire for growth, not a cut. Over budget means trim at the source.
    const a = loadVoiceAssets(CC_DIR);
    expect(a.aboutMe.length + a.toneGuidelines.length + a.antiAiRules.length).toBeLessThanOrEqual(
      VOICE_BUDGET_CHARS,
    );
  });
});

describe.skipIf(!hasVault)('anchor bank in the vault', () => {
  it('parses every anchor, each tied to a lens that exists', () => {
    // Status is forced in memory only: the real file stays pending until reviewed.
    const raw = fs.readFileSync(`${VAULT_DIR}anchor-bank.md`, 'utf8');
    const bank = parseAnchorBank(raw.replace(/^status: .*$/m, 'status: approved'));
    const lensIds = fs.readdirSync(`${VAULT_DIR}lenses`).map((f) => f.replace(/\.md$/, ''));

    expect(bank.anchors.length).toBeGreaterThan(0);
    for (const a of bank.anchors) {
      expect(a.textEn.length, a.id).toBeGreaterThan(40);
      expect(a.lenses.filter((l) => !lensIds.includes(l)), a.id).toEqual([]);
    }
  });
});
