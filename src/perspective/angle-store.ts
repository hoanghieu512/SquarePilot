import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { asDate, asNumber, asString, asStringArray, parseDoc } from './frontmatter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('angles');

/**
 * An angle is written about a specific story. Past this age the story it was
 * written for is no longer the story trending today, and pairing them produces
 * the "bot stitched two unrelated things together" effect.
 */
export const MAX_ANGLE_AGE_DAYS = 30;

export interface Angle {
  path: string;
  articleId: string | null;
  title: string | null;
  date: Date | null;
  score: number | null;
  status: string;
  tags: string[];
  /** Campaign rules and warnings lifted from the body, e.g. "no price talk". */
  guardrails: string[];
  body: string;
}

const GUARDRAIL_MARKERS = /guardrail|KHÔNG|TUYỆT ĐỐI|⚠️|🚨|avoid|do not/i;

/**
 * Pull constraint lines out of the angle body.
 *
 * The Dusk campaign angle, for instance, forbids price speculation. Losing
 * that on the way to the drafter would breach the campaign terms, so the lines
 * travel with the angle rather than being left in the file.
 */
function extractGuardrails(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') || l.startsWith('>') || l.startsWith('**'))
    .filter((l) => GUARDRAIL_MARKERS.test(l))
    .map((l) => l.replace(/^[->*\s]+/, '').trim())
    .filter((l) => l.length > 20)
    .slice(0, 12);
}

export function readAngles(anglesDir: string): Angle[] {
  if (!fs.existsSync(anglesDir)) {
    logger.warn(`Angles directory not found: ${anglesDir}`);
    return [];
  }

  const angles: Angle[] = [];
  for (const file of fs.readdirSync(anglesDir).filter((f) => f.endsWith('.md'))) {
    const full = path.join(anglesDir, file);
    const { front, body } = parseDoc(fs.readFileSync(full, 'utf8'));
    angles.push({
      path: full,
      articleId: asString(front.article_id),
      title: asString(front.title),
      date: asDate(front.date) ?? asDate(file.slice(0, 10)),
      score: asNumber(front.score),
      status: asString(front.status) ?? 'unused',
      tags: asStringArray(front.tags),
      guardrails: extractGuardrails(body),
      body,
    });
  }
  return angles;
}

export function syncAngles(db: Database.Database, angles: Angle[]): void {
  const upsert = db.prepare(
    `INSERT INTO angles (path, article_id, title, angle_date, score, status, tags, guardrails, synced_at)
     VALUES (@path, @articleId, @title, @date, @score, @status, @tags, @guardrails, @syncedAt)
     ON CONFLICT(path) DO UPDATE SET
       article_id = excluded.article_id,
       title      = excluded.title,
       angle_date = excluded.angle_date,
       score      = excluded.score,
       status     = excluded.status,
       tags       = excluded.tags,
       guardrails = excluded.guardrails,
       synced_at  = excluded.synced_at`,
  );

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const a of angles) {
      upsert.run({
        path: a.path,
        articleId: a.articleId,
        title: a.title,
        date: a.date?.toISOString() ?? null,
        score: a.score,
        status: a.status,
        tags: JSON.stringify(a.tags),
        guardrails: JSON.stringify(a.guardrails),
        syncedAt: now,
      });
    }
  })();
}

export interface AngleFilterResult {
  usable: Angle[];
  rejected: { candidate: string; reason: string }[];
}

export function usableAngles(
  angles: Angle[],
  referenceDate: Date,
  maxAgeDays = MAX_ANGLE_AGE_DAYS,
): AngleFilterResult {
  const usable: Angle[] = [];
  const rejected: { candidate: string; reason: string }[] = [];

  for (const angle of angles) {
    const label = angle.title ?? path.basename(angle.path);

    if (!angle.status.startsWith('unused')) {
      rejected.push({ candidate: label, reason: `status is "${angle.status}"` });
      continue;
    }
    if (!angle.date) {
      rejected.push({ candidate: label, reason: 'no usable date' });
      continue;
    }

    const ageDays = Math.floor((referenceDate.getTime() - angle.date.getTime()) / 86_400_000);
    if (ageDays > maxAgeDays) {
      rejected.push({ candidate: label, reason: `${ageDays} days old (limit ${maxAgeDays})` });
      continue;
    }

    usable.push(angle);
  }

  return { usable, rejected };
}
