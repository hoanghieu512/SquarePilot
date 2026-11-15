import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { VisualSchema } from '../compose/data-gate.js';
import { HARD_CAP_NFD } from '../compose/text-validation.js';
import { latestOfferedVisual } from '../visual/draft-visual.js';

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
export function vaultDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(at);
}

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
  opts: { vaultDir: string; modelFor(tier: string): string },
): VaultWriteResult {
  const post = db
    .prepare(
      'SELECT id, square_post_id, content_snapshot, share_link, published_at FROM posts WHERE draft_id = ?',
    )
    .get(draftId) as PostRow | undefined;
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
      : `- Binance Square post id: ${post.square_post_id ?? 'none returned (HTTP 504, the post is live)'}`,
  ];

  // The body exactly as published, so the vault copy matches the snapshot.
  const md = [...front, '', ...header, '', post.content_snapshot, '', '---', '', ...sources, ''].join('\n');
  const mdPath = path.join(squareDir, freeName(squareDir, `${date}-${slug}-square-post`, '.md'));
  fs.writeFileSync(mdPath, md, { flag: 'wx' });
  db.prepare('UPDATE posts SET md_path = ?, png_path = COALESCE(?, png_path) WHERE id = ?').run(
    mdPath,
    pngPath,
    post.id,
  );

  if (d.outcome === 'angle' && d.source_ref) notes.push(markAnglePosted(db, d.source_ref, date));
  if (d.anchor_tier === 'bank' && d.anchor_ref) {
    notes.push(markBankAnchorUsed(path.join(opts.vaultDir, 'anchor-bank.md'), d.anchor_ref, date));
  }
  return { mdPath, pngPath, notes };
}

/** Set `status: posted` in the angle's frontmatter, as the hand pipeline does. */
export function markAnglePosted(db: Database.Database, anglePath: string, date: string): string {
  if (!fs.existsSync(anglePath)) return `angle file missing, not marked: ${path.basename(anglePath)}`;
  const raw = fs.readFileSync(anglePath, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return `angle has no frontmatter, not marked: ${path.basename(anglePath)}`;
  const front = /^status:.*$/m.test(fm[1]!) ? fm[1]!.replace(/^status:.*$/m, 'status: posted') : `${fm[1]}\nstatus: posted`;
  fs.writeFileSync(anglePath, `---\n${front}\n---\n${raw.slice(fm[0].length)}`);
  db.prepare(`UPDATE angles SET status = 'posted', used_at = ? WHERE path = ?`).run(date, anglePath);
  return `angle marked posted: ${path.basename(anglePath)}`;
}

/** Set `used: true` and `last_used` on one anchor of the bank, leaving the rest of the file as it is. */
export function markBankAnchorUsed(bankPath: string, anchorId: string, date: string): string {
  if (!fs.existsSync(bankPath)) return `anchor bank missing, ${anchorId} not marked`;
  const raw = fs.readFileSync(bankPath, 'utf8');
  const head = new RegExp(`^## ${anchorId}\\s*-.*$`, 'm').exec(raw);
  if (!head) return `anchor ${anchorId} not found in the bank, not marked`;
  const start = head.index;
  const next = raw.slice(start + head[0].length).search(/^## /m);
  const end = next === -1 ? raw.length : start + head[0].length + next;
  const section = raw
    .slice(start, end)
    .replace(/^- \*\*used:\*\*.*$/m, '- **used:** true')
    .replace(/^- \*\*last_used:\*\*.*$/m, `- **last_used:** ${date}`);
  fs.writeFileSync(bankPath, raw.slice(0, start) + section + raw.slice(end));
  return `anchor ${anchorId} marked used on ${date}`;
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
    `rejected_reason: ${d.reject_reason ?? (d.status === 'expired' ? 'expired' : 'n/a')}`,
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
