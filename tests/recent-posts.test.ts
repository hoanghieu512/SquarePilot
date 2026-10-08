import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import { detectPersona } from '../src/compose/persona-guard.js';
import { parseVaultPost, readRecentPosts, readVaultPosts } from '../src/compose/recent-posts.js';

/** Shaped like a hand-written Square post in outputs/square/. */
const HAND_WRITTEN = `---
source: 2026-08-13-dusk-campaign-template.md
date_written: 2026-08-26
format: square
campaign: dusk-daily
language: en
---

_← Angle gốc: [[2026-08-13-dusk-campaign-template]]_

## Post thường Square
[char count: 2055/2100]
[anchor: tầng 2 (Anchor Bank A7). Persona: no QA mention this time.]

There's a withdrawal of mine sitting on Dusk right now, and it hasn't moved.

Two weeks of writing about it, and that screen is still the best summary I've got.

#dusk

---
*Not financial advice.*

## Nguồn
- Bridge docs: https://docs.example.org/qa-guide
`;

describe('parseVaultPost', () => {
  it('measures shape on the post text only', () => {
    const post = parseVaultPost(HAND_WRITTEN, '2026-08-26-dusk-square-post.md');

    expect(post.shapeText.startsWith("There's a withdrawal")).toBe(true);
    expect(post.shapeText).not.toMatch(/char count|Not financial advice|Nguồn/);
  });

  it('scans for persona without the annotation lines or links', () => {
    // The [anchor: ...] note and the source URL both contain "QA"; neither was
    // published, so neither may spend the cap.
    const post = parseVaultPost(HAND_WRITTEN, '2026-08-26-dusk-square-post.md');

    expect(detectPersona(post.personaText).mentionsPersona).toBe(false);
    expect(post.personaText).toMatch(/Not financial advice/);
  });

  it('takes the date from the frontmatter, falling back to the file name', () => {
    expect(parseVaultPost(HAND_WRITTEN, 'x.md').date).toBe('2026-08-26');
    expect(parseVaultPost('Plain body.', '2026-09-01-plain.md').date).toBe('2026-09-01');
  });

  it('reads the Square post id when the vault writer recorded one', () => {
    const raw = HAND_WRITTEN.replace('language: en', 'language: en\nsquare_post_id: "998877"');
    expect(parseVaultPost(raw, 'x.md').squarePostId).toBe('998877');
  });
});

describe('readVaultPosts', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-square-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns posts newest first by file name, ignoring non-markdown files', () => {
    fs.writeFileSync(path.join(dir, '2026-08-01-a.md'), 'Older post.');
    fs.writeFileSync(path.join(dir, '2026-08-20-b.md'), 'Newer post.');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a post');
    fs.mkdirSync(path.join(dir, '_drafts'));

    expect(readVaultPosts(dir).map((p) => p.ref)).toEqual(['2026-08-20-b.md', '2026-08-01-a.md']);
  });

  it('fails loudly when the directory is missing', () => {
    // An empty window would read as "nobody named the job lately" and switch
    // the cap off without a word.
    expect(() => readVaultPosts(path.join(dir, 'nope'))).toThrow(/outputs\/square/);
  });
});

describe('readRecentPosts', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-square-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
       VALUES ('#T', 1, 9999, 10, '2026-09-30T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO selections (trend_id, outcome, created_at) VALUES (1, 'lens', '2026-09-30T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO drafts (selection_id, body, nfc_len, nfd_len, model_used, created_at)
       VALUES (1, 'b', 1, 1, 'm', '2026-09-30T00:00:00Z')`,
    ).run();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const publish = (body: string, at: string, mdPath: string | null = null) =>
    db
      .prepare(
        `INSERT INTO posts (draft_id, content_snapshot, hashtag, md_path, published_at)
         VALUES (1, ?, '#T', ?, ?)`,
      )
      .run(body, mdPath, at);

  it('sees the posts written by hand on the same account', () => {
    fs.writeFileSync(path.join(dir, '2026-08-26-dusk.md'), 'My day job is testing.');

    const recent = readRecentPosts(db, dir);

    expect(recent).toHaveLength(1);
    expect(recent[0]!.source).toBe('vault');
  });

  it('includes a published post the vault writer has not written yet', () => {
    fs.writeFileSync(path.join(dir, '2026-08-26-dusk.md'), 'Hand-written.');
    publish('Bot post, not in the vault yet.', '2026-10-02T08:00:00Z');

    const recent = readRecentPosts(db, dir);

    expect(recent.map((p) => p.source)).toEqual(['db', 'vault']);
  });

  it('counts a post once when it is in both the database and the vault', () => {
    const file = path.join(dir, '2026-10-02-bot.md');
    fs.writeFileSync(file, 'Bot post.');
    publish('#T\n\nBot post.', '2026-10-02T08:00:00Z', file);

    expect(readRecentPosts(db, dir)).toHaveLength(1);
  });

  it('stops at the window size', () => {
    for (let i = 1; i <= 14; i++) {
      fs.writeFileSync(path.join(dir, `2026-09-${String(i).padStart(2, '0')}-p.md`), `Post ${i}.`);
    }

    const recent = readRecentPosts(db, dir, 10);

    expect(recent).toHaveLength(10);
    expect(recent[0]!.ref).toBe('2026-09-14-p.md');
  });
});
