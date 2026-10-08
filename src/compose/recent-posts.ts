import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { PERSONA_CAP_WINDOW } from './persona-guard.js';

/**
 * The recent history of the Square account, as the shape and persona gates see it.
 *
 * Both pipelines post to the same account: hand-written posts land in
 * `outputs/square/`, this bot's posts land in its database and, once the vault
 * writer runs, in the same folder. Reading only the database would let each
 * pipeline spend the persona cap separately, so 1 in 10 becomes 2 in 10 on the
 * page a reader actually scrolls.
 *
 * Parsing follows `Content-Creator/tools/shape-analyzer.mjs` (`parsePost`), so
 * both sides count the same window the same way.
 */
export interface RecentPost {
  source: 'vault' | 'db';
  /** File name for vault posts, `posts.id` for database posts. */
  ref: string;
  /** `YYYY-MM-DD` for vault posts, full ISO timestamp for database posts. */
  date: string;
  /** The post text only: no frontmatter, annotations, disclaimer or sources. */
  shapeText: string;
  /** Everything that was published, minus headings, annotations and link lines. */
  personaText: string;
  squarePostId?: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function field(front: string, name: string): string | undefined {
  const m = front.match(new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, 'm'));
  return m?.[1] || undefined;
}

export function parseVaultPost(raw: string, fileName: string): RecentPost {
  const fm = raw.match(FRONTMATTER);
  const front = fm?.[1] ?? '';
  const afterFront = fm ? raw.slice(fm[0].length) : raw;
  const lines = afterFront.split('\n');

  const body: string[] = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^##\s*Nguồn/i.test(t) || /^\*Not financial advice/i.test(t)) break;
    if (!started) {
      // Header block: wikilink backref, section heading, [meta] annotations.
      if (t === '' || t.startsWith('_←') || t.startsWith('##') || t.startsWith('[')) continue;
      started = true;
    }
    if (t === '---') break;
    body.push(line);
  }

  // Annotations such as `[anchor: ...]` are notes to self, never published, and
  // can mention the job while describing why the post avoided it.
  const personaLines = lines.filter((line) => {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('_←') || t.startsWith('[') || t.startsWith('<!--')) {
      return false;
    }
    return !/https?:\/\//.test(t);
  });

  return {
    source: 'vault',
    ref: fileName,
    date: field(front, 'date_written') ?? fileName.slice(0, 10),
    shapeText: body.join('\n').trim(),
    personaText: personaLines.join('\n').trim(),
    squarePostId: field(front, 'square_post_id'),
  };
}

/** Posts in `outputs/square/`, newest first by file name (the date prefix). */
export function readVaultPosts(squareDir: string): RecentPost[] {
  if (!fs.existsSync(squareDir)) {
    throw new Error(
      `Square outputs folder not found: ${squareDir}. Expected <VAULT_DIR>/outputs/square. ` +
        'Without it the persona and shape gates would compare against nothing.',
    );
  }
  return fs
    .readdirSync(squareDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((name) => parseVaultPost(fs.readFileSync(path.join(squareDir, name), 'utf8'), name));
}

interface PostRow {
  id: number;
  content_snapshot: string;
  square_post_id: string | null;
  md_path: string | null;
  published_at: string;
}

/**
 * The last `limit` posts on the account, from both sources, newest first.
 *
 * A database post is dropped when the vault already holds it, matched by file
 * name or Square post id. One that is published but not yet in the vault still
 * counts: otherwise a failed vault write would hide a job mention from the cap.
 */
export function readRecentPosts(
  db: Database.Database,
  squareDir: string,
  limit = PERSONA_CAP_WINDOW,
): RecentPost[] {
  const vault = readVaultPosts(squareDir);
  const files = new Set(vault.map((p) => p.ref));
  const ids = new Set(vault.map((p) => p.squarePostId).filter(Boolean));

  const rows = db
    .prepare(
      `SELECT id, content_snapshot, square_post_id, md_path, published_at
       FROM posts ORDER BY published_at DESC LIMIT ?`,
    )
    .all(limit) as PostRow[];

  const fromDb: RecentPost[] = rows
    .filter((r) => !(r.md_path && files.has(path.basename(r.md_path))))
    .filter((r) => !(r.square_post_id && ids.has(r.square_post_id)))
    .map((r) => ({
      source: 'db',
      ref: String(r.id),
      date: r.published_at,
      shapeText: r.content_snapshot,
      personaText: r.content_snapshot,
      squarePostId: r.square_post_id ?? undefined,
    }));

  // Comparing on the date prefix keeps file names and ISO timestamps in one
  // order; on the same day the database post is the newer one, since the vault
  // copy is written after publishing.
  return [...fromDb, ...vault]
    .sort((a, b) => b.date.slice(0, 10).localeCompare(a.date.slice(0, 10)))
    .slice(0, limit);
}
