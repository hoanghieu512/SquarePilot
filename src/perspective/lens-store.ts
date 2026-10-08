import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { asNumber, asString, asStringArray, parseDoc } from './frontmatter.js';
import type { EvidenceSource } from './evidence.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('lenses');

export interface Lens {
  id: string;
  path: string;
  name: string;
  appliesWhen: string[];
  /** What must be produced before this lens may be used. Never empty. */
  evidenceRequired: string;
  /** Where that evidence can come from. Decides whether it can be automated. */
  evidenceSource: EvidenceSource;
  cooldownDays: number;
  lastUsed: Date | null;
  useCount: number;
  /** Questions the lens generates, lifted from the file body. */
  questions: string[];
}

/**
 * The evidence bar may live in frontmatter or as a body section.
 *
 * The lens files in the vault put it under `## evidence_required`, because a
 * lens is a document a person reads and edits, not just a config row. Reading
 * only the frontmatter silently emptied the whole bank the first time this ran.
 */
function extractEvidenceRequired(body: string): string | null {
  const section = body.match(/##\s*evidence_required\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!section?.[1]) return null;
  const text = section[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ')
    .replace(/\*\*/g, '')
    .trim();
  return text === '' ? null : text;
}

function parseEvidenceSource(raw: string | null): EvidenceSource {
  return raw === 'data' || raw === 'docs' ? raw : 'author';
}

function extractQuestions(body: string): string[] {
  const heading = body.match(/##\s*Câu hỏi sinh ra\s*\n([\s\S]*?)(?=\n##|$)/i);
  const section = heading?.[1] ?? body;
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter((l) => l.endsWith('?'));
}

export function readLenses(lensesDir: string): Lens[] {
  if (!fs.existsSync(lensesDir)) {
    logger.warn(`Lenses directory not found: ${lensesDir}`);
    return [];
  }

  const lenses: Lens[] = [];
  for (const file of fs.readdirSync(lensesDir).filter((f) => f.endsWith('.md'))) {
    const full = path.join(lensesDir, file);
    const { front, body } = parseDoc(fs.readFileSync(full, 'utf8'));

    const id = asString(front.id) ?? file.replace(/\.md$/, '');
    const evidenceRequired = asString(front.evidence_required) ?? extractEvidenceRequired(body);

    // A lens with no evidence bar is exactly the failure mode the bar exists to
    // prevent, so it is excluded rather than defaulted to something permissive.
    if (!evidenceRequired) {
      logger.warn(`Lens "${id}" declares no evidence_required (frontmatter or ## section) — skipped`);
      continue;
    }

    lenses.push({
      id,
      path: full,
      name: asString(front.name) ?? id,
      appliesWhen: asStringArray(front.applies_when).map((s) => s.toLowerCase()),
      evidenceRequired,
      // Default to `author`: assuming a lens can be fed automatically when it
      // cannot is how a fabricated anecdote reaches a post.
      evidenceSource: parseEvidenceSource(asString(front.evidence_source)),
      cooldownDays: asNumber(front.cooldown_days) ?? 4,
      lastUsed: null,
      useCount: 0,
      questions: extractQuestions(body),
    });
  }
  return lenses;
}

/**
 * The file declares the rules; the database counts the usage.
 *
 * Kept apart on purpose: editing a lens must not reset its cooldown, and a
 * cooldown must survive the file being rewritten.
 */
export function syncLenses(db: Database.Database, lenses: Lens[]): Lens[] {
  const upsert = db.prepare(
    `INSERT INTO lenses (id, path, name, applies_when, evidence_required, cooldown_days, synced_at)
     VALUES (@id, @path, @name, @appliesWhen, @evidenceRequired, @cooldownDays, @syncedAt)
     ON CONFLICT(id) DO UPDATE SET
       path              = excluded.path,
       name              = excluded.name,
       applies_when      = excluded.applies_when,
       evidence_required = excluded.evidence_required,
       cooldown_days     = excluded.cooldown_days,
       synced_at         = excluded.synced_at`,
  );
  const read = db.prepare('SELECT last_used, use_count FROM lenses WHERE id = ?');

  const now = new Date().toISOString();
  const hydrated: Lens[] = [];

  db.transaction(() => {
    for (const lens of lenses) {
      upsert.run({
        id: lens.id,
        path: lens.path,
        name: lens.name,
        appliesWhen: JSON.stringify(lens.appliesWhen),
        evidenceRequired: lens.evidenceRequired,
        cooldownDays: lens.cooldownDays,
        syncedAt: now,
      });
      const row = read.get(lens.id) as { last_used: string | null; use_count: number };
      hydrated.push({
        ...lens,
        lastUsed: row.last_used ? new Date(row.last_used) : null,
        useCount: row.use_count,
      });
    }
  })();

  return hydrated;
}

export function markLensUsed(db: Database.Database, lensId: string, at: Date = new Date()): void {
  db.prepare('UPDATE lenses SET last_used = ?, use_count = use_count + 1 WHERE id = ?').run(
    at.toISOString(),
    lensId,
  );
}

export interface LensCandidate {
  lens: Lens;
  matchedTopics: string[];
}

export interface LensFilterResult {
  candidates: LensCandidate[];
  rejected: { candidate: string; reason: string }[];
}

/**
 * Narrow the bank to lenses that could apply to this topic and are off cooldown.
 *
 * Evidence is NOT checked here — that needs the actual research and happens in
 * `verifyEvidence`, after a candidate is chosen. This split keeps the cheap
 * filter cheap.
 */
export function eligibleLenses(
  lenses: Lens[],
  topics: string[],
  now: Date = new Date(),
): LensFilterResult {
  const haystack = topics.map((t) => t.toLowerCase());
  const candidates: LensCandidate[] = [];
  const rejected: { candidate: string; reason: string }[] = [];

  for (const lens of lenses) {
    if (lens.lastUsed) {
      const daysSince = (now.getTime() - lens.lastUsed.getTime()) / 86_400_000;
      if (daysSince < lens.cooldownDays) {
        rejected.push({
          candidate: lens.id,
          reason: `on cooldown (${daysSince.toFixed(1)}d of ${lens.cooldownDays}d)`,
        });
        continue;
      }
    }

    const matched = lens.appliesWhen.filter((topic) =>
      haystack.some((h) => h.includes(topic) || topic.includes(h)),
    );
    if (matched.length === 0) {
      rejected.push({ candidate: lens.id, reason: `applies_when does not cover ${topics.join(', ')}` });
      continue;
    }

    candidates.push({ lens, matchedTopics: matched });
  }

  // Least-used first: keeps one strong lens from becoming a tic.
  candidates.sort((a, b) => a.lens.useCount - b.lens.useCount);
  return { candidates, rejected };
}

export interface EvidenceCheck {
  ok: boolean;
  evidence: string[];
  reason?: string;
}

/**
 * A lens may only be used once the evidence it demands actually exists.
 *
 * This is the single guard against the failure mode that matters most here: a
 * model inventing a plausible quote, a fabricated docs line, or a job anecdote
 * that never happened. A lens without its evidence is dropped, never softened.
 */
export function verifyEvidence(lens: Lens, evidence: string[]): EvidenceCheck {
  const usable = evidence.map((e) => e.trim()).filter((e) => e.length >= 20);

  if (usable.length === 0) {
    return {
      ok: false,
      evidence: [],
      reason: `no evidence for "${lens.id}" (requires: ${lens.evidenceRequired})`,
    };
  }
  return { ok: true, evidence: usable };
}
