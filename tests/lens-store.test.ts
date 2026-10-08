import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import {
  eligibleLenses,
  markLensUsed,
  readLenses,
  syncLenses,
  verifyEvidence,
  type Lens,
} from '../src/perspective/lens-store.js';

function lensFile(id: string, extra: string = ''): string {
  return `---
id: ${id}
name: "Test ${id}"
applies_when: [macro, equities]
evidence_required: "Must quote one real line."
cooldown_days: 4
${extra}
---

# Test ${id}

## Câu hỏi sinh ra

- What does the doc say?
- Does the implementation differ?

## Cảnh báo

Not a question line.
`;
}

function makeLens(over: Partial<Lens> = {}): Lens {
  return {
    id: 'l1',
    path: '/tmp/l1.md',
    name: 'L1',
    appliesWhen: ['macro'],
    evidenceRequired: 'a real quote',
    evidenceSource: 'author',
    cooldownDays: 4,
    lastUsed: null,
    useCount: 0,
    questions: [],
    ...over,
  };
}

describe('readLenses', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenses-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads frontmatter and the generated questions', () => {
    fs.writeFileSync(path.join(dir, 'a.md'), lensFile('alpha'));
    const [lens] = readLenses(dir);

    expect(lens!.id).toBe('alpha');
    expect(lens!.appliesWhen).toEqual(['macro', 'equities']);
    expect(lens!.cooldownDays).toBe(4);
    // No evidence_source in the file: must fall back to the conservative value.
    expect(lens!.evidenceSource).toBe('author');
    expect(lens!.questions).toEqual(['What does the doc say?', 'Does the implementation differ?']);
  });

  it('skips a lens with no evidence_required — that lens is the failure it guards against', () => {
    fs.writeFileSync(
      path.join(dir, 'b.md'),
      `---\nid: nobar\nname: "No bar"\napplies_when: [macro]\n---\n\nbody\n`,
    );
    expect(readLenses(dir)).toHaveLength(0);
  });

  it('returns an empty bank instead of throwing when the directory is absent', () => {
    expect(readLenses(path.join(dir, 'missing'))).toEqual([]);
  });

  it('reads the six real lenses from the vault', () => {
    const vaultLenses = '/Users/lavopavden/Dev/vault/projects/content-creator/lenses';
    if (!fs.existsSync(vaultLenses)) return;

    const lenses = readLenses(vaultLenses);
    expect(lenses.length).toBeGreaterThanOrEqual(6);
    for (const lens of lenses) {
      expect(lens.evidenceRequired.length).toBeGreaterThan(10);
      expect(lens.appliesWhen.length).toBeGreaterThan(0);
      expect(lens.questions.length).toBeGreaterThan(0);
      expect(['data', 'docs', 'author']).toContain(lens.evidenceSource);
    }
  });
});

describe('syncLenses', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('keeps usage state when the file is edited', () => {
    syncLenses(db, [makeLens()]);
    markLensUsed(db, 'l1', new Date('2026-08-20T00:00:00Z'));

    // The file is rewritten with a different cooldown; usage must survive.
    const [hydrated] = syncLenses(db, [makeLens({ cooldownDays: 9, name: 'Renamed' })]);

    expect(hydrated!.useCount).toBe(1);
    expect(hydrated!.lastUsed?.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(hydrated!.cooldownDays).toBe(9);
  });
});

describe('eligibleLenses', () => {
  const now = new Date('2026-08-21T00:00:00Z');

  it('drops a lens still inside its cooldown', () => {
    const lens = makeLens({ lastUsed: new Date('2026-08-19T00:00:00Z'), cooldownDays: 4 });
    const result = eligibleLenses([lens], ['macro'], now);

    expect(result.candidates).toHaveLength(0);
    expect(result.rejected[0]!.reason).toMatch(/cooldown/);
  });

  it('allows a lens once the cooldown has passed', () => {
    const lens = makeLens({ lastUsed: new Date('2026-08-10T00:00:00Z'), cooldownDays: 4 });
    expect(eligibleLenses([lens], ['macro'], now).candidates).toHaveLength(1);
  });

  it('drops a lens whose applies_when does not cover the topic', () => {
    const lens = makeLens({ appliesWhen: ['protocol'] });
    const result = eligibleLenses([lens], ['jobless', 'claims'], now);

    expect(result.candidates).toHaveLength(0);
    expect(result.rejected[0]!.reason).toMatch(/applies_when/);
  });

  it('offers the least-used lens first, so one lens cannot become a tic', () => {
    const heavy = makeLens({ id: 'heavy', useCount: 12 });
    const light = makeLens({ id: 'light', useCount: 1 });
    const result = eligibleLenses([heavy, light], ['macro'], now);

    expect(result.candidates.map((c) => c.lens.id)).toEqual(['light', 'heavy']);
  });
});

describe('verifyEvidence', () => {
  it('rejects a lens with no evidence rather than letting it through weakened', () => {
    const check = verifyEvidence(makeLens(), []);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/requires: a real quote/);
  });

  it('rejects evidence too thin to be a real citation', () => {
    expect(verifyEvidence(makeLens(), ['yes', 'ok']).ok).toBe(false);
  });

  it('accepts substantive evidence and passes it through', () => {
    const check = verifyEvidence(makeLens(), [
      'The docs state that Citadel proves session validity, not service policy.',
    ]);
    expect(check.ok).toBe(true);
    expect(check.evidence).toHaveLength(1);
  });
});
