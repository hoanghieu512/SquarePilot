import path from 'node:path';
import type Database from 'better-sqlite3';
import type { VisualSchema } from '../compose/data-gate.js';
import { alignVisualToDraft } from '../compose/visual-alignment.js';
import { renderToFile, type RenderResult } from './render.js';

/**
 * The card for one draft: aligned to what the draft says, drawn, and recorded.
 *
 * A draft can have several visuals: the first from the pipeline, more when the
 * owner asks for a new one from the approval chat. The newest row is the one
 * shown and, if approved, the one posted.
 */

export interface VisualRow {
  id: number;
  draftId: number;
  schema: Partial<VisualSchema>;
  pngPath: string | null;
  imageUrl: string | null;
}

export type DraftVisualResult =
  | { ok: true; visual: VisualRow; changed: string[]; rendered: RenderResult }
  | { ok: false; reason: string };

export type RenderFn = (schema: VisualSchema, filePath: string) => Promise<RenderResult>;

/**
 * A file-name-safe slug. Hashtags carry "?", curly quotes and "$", which end
 * up in the PNG name and in the image name sent to Square.
 */
export function visualSlug(hashtag: string): string {
  const slug = hashtag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'card';
}

interface RawVisual {
  id: number;
  draft_id: number;
  schema_json: string;
  png_path: string | null;
  image_url: string | null;
}

function toRow(r: RawVisual): VisualRow {
  return {
    id: r.id,
    draftId: r.draft_id,
    schema: JSON.parse(r.schema_json) as Partial<VisualSchema>,
    pngPath: r.png_path,
    imageUrl: r.image_url,
  };
}

export function latestVisual(db: Database.Database, draftId: number): VisualRow | undefined {
  const r = db
    .prepare(
      `SELECT id, draft_id, schema_json, png_path, image_url FROM visuals
       WHERE draft_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(draftId) as RawVisual | undefined;
  return r ? toRow(r) : undefined;
}

/** Every focal number this draft's cards have shown, oldest first. */
export function shownFocals(db: Database.Database, draftId: number): string[] {
  const rows = db
    .prepare('SELECT schema_json FROM visuals WHERE draft_id = ? ORDER BY id ASC')
    .all(draftId) as { schema_json: string }[];
  return rows
    .map((r) => (JSON.parse(r.schema_json) as Partial<VisualSchema>).focal_number)
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
}

export function setVisualImageUrl(db: Database.Database, visualId: number, url: string): void {
  db.prepare('UPDATE visuals SET image_url = ? WHERE id = ?').run(url, visualId);
}

export interface DraftVisualInput {
  draftId: number;
  body: string;
  hashtag: string;
  /** What the data gate found, or the last card when asking for a new one. */
  baseSchema: Partial<VisualSchema>;
  visualDir: string;
  now: Date;
  excludeFocal?: string[];
  render?: RenderFn;
}

export async function renderDraftVisual(
  db: Database.Database,
  input: DraftVisualInput,
): Promise<DraftVisualResult> {
  const aligned = alignVisualToDraft(input.baseSchema, input.body, {
    currentYear: input.now.getUTCFullYear(),
    excludeFocal: input.excludeFocal,
  });
  if (!aligned.ok) return { ok: false, reason: aligned.reason };
  const schema = aligned.schema;

  // One file per card, so a new visual never overwrites the one already on
  // the owner's phone and a rewrite never overwrites the draft it replaces.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM visuals WHERE draft_id = ?').get(input.draftId) as {
    n: number;
  };
  const variant = n > 0 ? `-v${n + 1}` : '';
  const pngPath = path.join(
    input.visualDir,
    `${input.now.toISOString().slice(0, 10)}-${visualSlug(input.hashtag)}-d${input.draftId}${variant}.png`,
  );

  // "No image, no post": the data gate already proved the schema can be
  // filled, so a throw here is a rendering fault and is left to the caller.
  const rendered = await (input.render ?? renderToFile)(schema as VisualSchema, pngPath);
  const info = db
    .prepare(
      `INSERT INTO visuals (draft_id, visual_type, mood, schema_json, png_path, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.draftId,
      schema.visual_type ?? 'macro_card',
      schema.mood_variant ?? 'neutral',
      JSON.stringify(schema),
      pngPath,
      rendered.bytes,
      input.now.toISOString(),
    );

  return {
    ok: true,
    visual: { id: Number(info.lastInsertRowid), draftId: input.draftId, schema, pngPath, imageUrl: null },
    changed: aligned.changed,
    rendered,
  };
}

/**
 * A different card for a draft already in the approval chat, from the
 * database alone: it works for a draft written by an earlier run too.
 */
export async function renderNewVisual(
  db: Database.Database,
  draftId: number,
  opts: { visualDir: string; now: Date; render?: RenderFn },
): Promise<DraftVisualResult> {
  const draft = db
    .prepare(
      `SELECT d.body, t.hashtag FROM drafts d
       JOIN selections s ON s.id = d.selection_id
       JOIN trends t ON t.id = s.trend_id
       WHERE d.id = ?`,
    )
    .get(draftId) as { body: string; hashtag: string } | undefined;
  if (!draft) return { ok: false, reason: `no draft ${draftId}` };

  const current = latestVisual(db, draftId);
  if (!current) return { ok: false, reason: 'the draft has no card to start from' };

  return renderDraftVisual(db, {
    draftId,
    body: draft.body,
    hashtag: draft.hashtag,
    baseSchema: current.schema,
    visualDir: opts.visualDir,
    now: opts.now,
    excludeFocal: shownFocals(db, draftId),
    render: opts.render,
  });
}
