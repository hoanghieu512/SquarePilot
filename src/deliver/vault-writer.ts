import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { VisualSchema } from '../compose/data-gate.js';
import { HARD_CAP_NFD } from '../compose/text-validation.js';
import { latestOfferedVisual } from '../visual/draft-visual.js';
import { vietnamDate } from '../compose/recent-posts.js';

/**
 * Copy what the bot published into the vault, next to the hand-written posts.
 *
 * One account, two pipelines: the persona cap and the shape gate read
 * `outputs/square/` for both, so a bot post must land there in the same shape
 * as a hand-written one (see `parseVaultPost`, which mirrors the
 * Content-Creator shape analyzer). The headings "Post thường Square" and
 * "Nguồn" and the "_← Angle gốc" back-link are the vault's own conventions,
 * kept verbatim so both pipelines read each other's files.
 *
 * Published posts go to `outputs/square/` and their card to
 * `outputs/visuals/square/`; drafts that were offered and not published go to
 * `outputs/square-auto/drafts/` with the reason, for the approval-rate stats.
 * Only a real publish marks the angle posted and the bank anchor used.
 */

export interface VaultWriteResult {
  mdPath: string;
  pngPath: string | null;
  /** What else was updated or skipped, one line each, for the chat and the log. */
  notes: string[];
}

interface DraftRow {
  id: number;
  body: string;
  nfc_len: number;
  nfd_len: number;
  status: string;
  reject_reason: string | null;
  tone_gate: string | null;
  shape_gate: string | null;
  persona_gate: string | null;
  fact_gate: string | null;
  model_used: string;
  escalated: number;
  anchor_tier: string | null;
  anchor_ref: string | null;
  created_at: string;
  outcome: string;
  source_ref: string | null;
  perspective_summary: string | null;
  mode: string | null;
  hashtag: string;
  view_count: number;
  content_count: number;
}

function loadDraft(db: Database.Database, draftId: number): DraftRow {
  const row = db
    .prepare(
      `SELECT d.id, d.body, d.nfc_len, d.nfd_len, d.status, d.reject_reason, d.tone_gate, d.shape_gate,
              d.persona_gate, d.fact_gate, d.model_used, d.escalated, d.anchor_tier, d.anchor_ref, d.created_at,
              s.outcome, s.source_ref, s.perspective_summary, s.mode,
              t.hashtag, t.view_count, t.content_count
       FROM drafts d
       JOIN selections s ON s.id = d.selection_id
       JOIN trends t ON t.id = s.trend_id
       WHERE d.id = ?`,
    )
    .get(draftId) as DraftRow | undefined;
  if (!row) throw new Error(`no draft ${draftId}`);
  return row;
}

/** `YYYY-MM-DD` in Vietnam, the date the vault's file names use. */
export const vaultDate = vietnamDate;

/** "#WhatWillDriveCryptoandStocks’NextRebound?" → "what-will-drive-cryptoand-stocks-next". */
export function postSlug(hashtag: string, maxWords = 6): string {
  const words = hashtag
    .replace(/^#/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.slice(0, maxWords).join('-') || 'post';
}

/** A file name not taken yet in `dir`: `base.ext`, then `base-2.ext`, ... */
function freeName(dir: string, base: string, ext: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

function verdict(column: string | null): string {
  return column ? column.split(':')[0]!.trim() : 'n/a';
}

function costOf(db: Database.Database, draftId: number): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_calls WHERE draft_id = ?').get(draftId) as {
    cost: number;
  };
  return Math.round(r.cost * 10_000) / 10_000;
}

/**
 * The model that wrote the final text, from the call log. `drafts.model_used`
 * holds only the tier, and the tier's model can change between the draft and
 * this copy (Sonnet 5 to 5.5 on 2026-11-15).
 */
function modelOf(db: Database.Database, d: DraftRow, modelFor: (tier: string) => string): string {
  const r = db
    .prepare(
      `SELECT model FROM llm_calls WHERE draft_id = ? AND purpose = 'draft' AND ok = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(d.id) as { model: string } | undefined;
  return r?.model ?? modelFor(d.model_used);
}

function sourceFields(d: DraftRow): { source: string; backLink: string } {
  if (d.outcome === 'angle' && d.source_ref) {
    const base = path.basename(d.source_ref, '.md');
    return { source: `${base}.md`, backLink: `_← Angle gốc: [[${base}]]_` };
  }
  if (d.outcome === 'lens' && d.source_ref) {
    return { source: `lenses/${d.source_ref}.md`, backLink: `_← Lens: [[${d.source_ref}]]_` };
  }
  return { source: `tension in ${d.hashtag}`, backLink: `_← Tension trong trend ${d.hashtag}_` };
}

function gatesLine(d: DraftRow): string {
  return [
    `tone ${verdict(d.tone_gate)}`,
    `shape ${verdict(d.shape_gate)}`,
    `persona ${verdict(d.persona_gate)}`,
    `facts ${verdict(d.fact_gate)}`,
  ].join(' · ');
}

function visualLine(fileName: string, schema: Partial<VisualSchema>): string {
  const tiles = (schema.stat_tiles ?? []).map((t) => `${t.label.toUpperCase()} ${t.value}`).join(' · ');
  return (
    `[visual: ${fileName}, ${schema.visual_type ?? 'macro_card'} ${schema.mood_variant ?? 'neutral'}, ` +
    `focal "${schema.focal_number ?? ''}"${tiles ? `, tiles ${tiles}` : ''}]`
  );
}

interface PostRow {
  id: number;
  square_post_id: string | null;
  content_snapshot: string;
  share_link: string | null;
  published_at: string;
}

export function writePublishedPost(
  db: Database.Database,
  draftId: number,
  opts: {
    vaultDir: string;
    modelFor(tier: string): string;
    /** What the publisher knows of the live post, when its posts row could not be written. */
    live?: { squarePostId: string | null; shareLink: string | null; publishedAt: string; body: string };
  },
): VaultWriteResult {
  const row = db
    .prepare(
      'SELECT id, square_post_id, content_snapshot, share_link, published_at FROM posts WHERE draft_id = ?',
    )
    .get(draftId) as PostRow | undefined;
  const post: PostRow | undefined =
    row ??
    (opts.live && {
      id: -1,
      square_post_id: opts.live.squarePostId,
      content_snapshot: opts.live.body,
      share_link: opts.live.shareLink,
      published_at: opts.live.publishedAt,
    });
  if (!post) throw new Error(`draft ${draftId} has no post to write`);
  const d = loadDraft(db, draftId);
  const date = vaultDate(new Date(post.published_at));
  const slug = postSlug(d.hashtag);
  const notes: string[] = [];

  const squareDir = path.join(opts.vaultDir, 'outputs', 'square');
  const visualsDir = path.join(opts.vaultDir, 'outputs', 'visuals', 'square');
  fs.mkdirSync(squareDir, { recursive: true });

  const visual = latestOfferedVisual(db, draftId);
  let pngPath: string | null = null;
  if (visual?.pngPath && fs.existsSync(visual.pngPath)) {
    fs.mkdirSync(visualsDir, { recursive: true });
    pngPath = path.join(visualsDir, freeName(visualsDir, `${date}-${slug}-card`, '.png'));
    fs.copyFileSync(visual.pngPath, pngPath);
  } else {
    notes.push('card PNG not found, not copied');
  }

  const { source, backLink } = sourceFields(d);
  const model = modelOf(db, d, opts.modelFor);
  const front = [
    '---',
    `source: ${source}`,
    `angle_used: ${yamlString(d.perspective_summary ?? d.source_ref ?? '')}`,
    `date_written: ${date}`,
    `input_source: ${d.outcome}`,
    'format: square',
    'post_type: post',
    'language: en',
    'adapted_from: square-pilot',
    'pipeline: square-pilot',
    `draft_id: ${d.id}`,
    `trend: ${yamlString(d.hashtag)}`,
    `trend_views: ${d.view_count}`,
    `trend_posts: ${d.content_count}`,
    `mode: ${d.mode ?? 'n/a'}`,
    `model: ${model}`,
    `escalated: ${d.escalated === 1}`,
    `gates: ${yamlString(gatesLine(d))}`,
    `cost_usd: ${costOf(db, draftId)}`,
    `square_post_id: ${post.square_post_id === null ? 'null' : yamlString(post.square_post_id)}`,
    `published_at: ${post.published_at}`,
    '---',
  ];
  const header = [
    backLink,
    '',
    '## Post thường Square',
    `[char count: ${d.nfd_len}/${HARD_CAP_NFD} (NFD; NFC ${d.nfc_len})]`,
    ...(visual ? [visualLine(pngPath ? path.basename(pngPath) : 'not copied', visual.schema)] : []),
    `[anchor: ${d.anchor_tier ?? 'none'}${d.anchor_ref ? ` ${d.anchor_ref}` : ''}]`,
    `[pipeline: SquarePilot draft #${d.id}, ${model}${d.escalated === 1 ? ' (escalated)' : ''}, mode ${d.mode ?? 'n/a'}, approved in the Zalo chat]`,
  ];
  const sources = [
    '## Nguồn',
    post.share_link
      ? `- Binance Square: ${post.share_link}`
      : `- Binance Square post id: ${post.square_post_id ?? 'none returned'}`,
  ];

  // The body exactly as published, so the vault copy matches the snapshot.
  const md = [...front, '', ...header, '', post.content_snapshot, '', '---', '', ...sources, ''].join('\n');
  const mdPath = path.join(squareDir, freeName(squareDir, `${date}-${slug}-square-post`, '.md'));
  fs.writeFileSync(mdPath, md, { flag: 'wx' });
  if (row) {
    db.prepare('UPDATE posts SET md_path = ?, png_path = COALESCE(?, png_path) WHERE id = ?').run(
      mdPath,
      pngPath,
      row.id,
    );
  }

  if (d.outcome === 'angle' && d.source_ref) notes.push(markAnglePosted(db, d.source_ref, date, opts.vaultDir));
  if (d.anchor_tier === 'bank' && d.anchor_ref) {
    notes.push(markBankAnchorUsed(path.join(opts.vaultDir, 'anchor-bank.md'), d.anchor_ref, date));
  }
  return { mdPath, pngPath, notes };
}

/**
 * Set `status: posted` in the angle's frontmatter, as the hand pipeline does.
 *
 * The note is looked up by name under this vault's `angles/`, never at the
 * path the database remembers, which can point into another vault. The
 * database row is marked either way, so the angle is not offered again.
 */
export function markAnglePosted(db: Database.Database, anglePath: string, date: string, vaultDir: string): string {
  db.prepare(`UPDATE angles SET status = 'posted', used_at = ? WHERE path = ?`).run(date, anglePath);
  const name = path.basename(anglePath);
  const file = path.join(vaultDir, 'angles', name);
  if (!fs.existsSync(file)) return `angle file missing, marked posted in the database only: ${name}`;

  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  // The first line that is only "---" closes the frontmatter; a rule further
  // down the body is never reached.
  const fm = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!fm) return `angle has no frontmatter, marked posted in the database only: ${name}`;
  const inner = fm[1]!;
  const status = /^status:[^\r\n]*/m;
  const updated = status.test(inner) ? inner.replace(status, 'status: posted') : `${inner}${eol}status: posted`;
  fs.writeFileSync(file, `---${eol}${updated}${eol}---${fm[2]}${raw.slice(fm[0].length)}`);
  return `angle marked posted: ${name}`;
}

/** The anchor headings exactly as `parseAnchorBank` reads them. */
const ANCHOR_HEADING = /^## (A\d+)\s*-\s*(.+)$/gm;

/**
 * Set `used: true` and `last_used` on one anchor of the bank, adding either
 * bullet if the anchor lacks it, and leaving the rest of the file as it is.
 * The cooldown reads `last_used`, so a used anchor must always carry it.
 */
export function markBankAnchorUsed(bankPath: string, anchorId: string, date: string): string {
  if (!fs.existsSync(bankPath)) return `anchor bank missing, ${anchorId} not marked`;
  const raw = fs.readFileSync(bankPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const heads = [...raw.matchAll(ANCHOR_HEADING)];
  const at = heads.findIndex((h) => h[1] === anchorId);
  if (at === -1) return `anchor ${anchorId} not found in the bank, not marked`;
  const start = heads[at]!.index;
  const end = at + 1 < heads.length ? heads[at + 1]!.index : raw.length;

  let section = raw.slice(start, end);
  const setBullet = (name: string, value: string): void => {
    const line = `- **${name}:** ${value}`;
    const existing = new RegExp(`^- \\*\\*${name}:\\*\\*[^\\r\\n]*`, 'm');
    if (existing.test(section)) {
      section = section.replace(existing, line);
      return;
    }
    const bullets = [...section.matchAll(/^- \*\*[a-z_]+:\*\*[^\r\n]*/gm)];
    const last = bullets[bullets.length - 1];
    const headingEnd = section.search(/\r?\n/);
    const pos = last ? last.index + last[0].length : headingEnd === -1 ? section.length : headingEnd;
    section = `${section.slice(0, pos)}${eol}${line}${section.slice(pos)}`;
  };
  setBullet('used', 'true');
  setBullet('last_used', date);

  fs.writeFileSync(bankPath, raw.slice(0, start) + section + raw.slice(end));
  return `anchor ${anchorId} marked used on ${date}`;
}

function unpublishedReason(d: DraftRow): string {
  if (d.reject_reason) return d.reject_reason;
  if (d.status === 'expired') return 'expired';
  // Approved with no post: the publisher could not tell whether it went out.
  if (d.status === 'approved') return 'none, publish result unknown (Square did not answer clearly)';
  return 'n/a';
}

/**
 * A draft that reached the chat and was not published: rejected, replaced by
 * a rewrite, expired, or withdrawn when its session stopped.
 */
export function writeUnpublishedDraft(
  db: Database.Database,
  draftId: number,
  opts: { vaultDir: string; now: Date; modelFor(tier: string): string },
): string {
  const d = loadDraft(db, draftId);
  const dir = path.join(opts.vaultDir, 'outputs', 'square-auto', 'drafts');
  fs.mkdirSync(dir, { recursive: true });
  const date = vaultDate(new Date(d.created_at));
  const mdPath = path.join(dir, freeName(dir, `${date}-${postSlug(d.hashtag)}-d${d.id}`, '.md'));
  const { source, backLink } = sourceFields(d);
  const md = [
    '---',
    'pipeline: square-pilot',
    `draft_id: ${d.id}`,
    `status: ${d.status}`,
    `rejected_reason: ${unpublishedReason(d)}`,
    `source: ${source}`,
    `angle_used: ${yamlString(d.perspective_summary ?? d.source_ref ?? '')}`,
    `input_source: ${d.outcome}`,
    `trend: ${yamlString(d.hashtag)}`,
    `mode: ${d.mode ?? 'n/a'}`,
    `model: ${modelOf(db, d, opts.modelFor)}`,
    `escalated: ${d.escalated === 1}`,
    `gates: ${yamlString(gatesLine(d))}`,
    `anchor: ${d.anchor_tier ?? 'none'}${d.anchor_ref ? ` ${d.anchor_ref}` : ''}`,
    `cost_usd: ${costOf(db, draftId)}`,
    `written_at: ${opts.now.toISOString()}`,
    '---',
    '',
    backLink,
    '',
    d.body,
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, md, { flag: 'wx' });
  return mdPath;
}
