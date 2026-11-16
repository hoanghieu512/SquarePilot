import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { parseVaultPost, readRecentPosts } from '../src/compose/recent-posts.js';
import {
  markBankAnchorUsed,
  postSlug,
  vaultDate,
  writePublishedPost,
  writeUnpublishedDraft,
} from '../src/deliver/vault-writer.js';
import { memoryDb, seedDraft, seedVisual } from './helpers/approval-db.js';

const BODY = '#BTCHolds\n\nVolume rose 12% while price held $68k.\n\nWindows decide the story.';
const modelFor = (tier: string) => (tier === 'paid' ? 'anthropic/claude-sonnet-5.5' : 'vendor/free');

describe('vault writer', () => {
  let db: Database.Database;
  let vault: string;
  let squareDir: string;

  function publish(draftId: number, over: { id?: string | null; link?: string | null; at?: string } = {}) {
    db.prepare(
      `INSERT INTO posts (draft_id, square_post_id, content_snapshot, hashtag, png_path, share_link, published_at)
       VALUES (?, ?, ?, '#BTCHolds', NULL, ?, ?)`,
    ).run(
      draftId,
      over.id === undefined ? '991' : over.id,
      BODY,
      over.link === undefined ? 'https://square.example/p/991' : over.link,
      over.at ?? '2026-11-15T03:00:00.000Z',
    );
  }

  beforeEach(() => {
    db = memoryDb();
    vault = mkdtempSync(join(tmpdir(), 'sp-vault-'));
    squareDir = join(vault, 'outputs', 'square');
    mkdirSync(squareDir, { recursive: true });
  });
  afterEach(() => db.close());

  it('writes the post where the gates read it, and the gates count it once', () => {
    const png = join(vault, 'auto-card.png');
    writeFileSync(png, 'png-bytes');
    const id = seedDraft(db, { status: 'approved', body: BODY, anchorTier: 'derived' });
    seedVisual(db, id, { pngPath: png });
    publish(id);
    db.prepare(
      `INSERT INTO llm_calls (draft_id, purpose, model, cost_usd, created_at)
       VALUES (?, 'draft', 'anthropic/claude-sonnet-5', 0.0612, 'x')`,
    ).run(id);

    const out = writePublishedPost(db, id, { vaultDir: vault, modelFor });

    expect(out.mdPath).toBe(join(squareDir, '2026-11-15-btc-holds-square-post.md'));
    const md = readFileSync(out.mdPath, 'utf8');
    const parsed = parseVaultPost(md, '2026-11-15-btc-holds-square-post.md');
    expect(parsed.shapeText).toBe(BODY);
    expect(parsed.squarePostId).toBe('991');
    expect(parsed.date).toBe('2026-11-15');
    expect(md).toContain('_← Lens: [[funding-mood]]_');
    expect(md).toContain('[char count: 124/2100 (NFD; NFC 120)]');
    expect(md).toContain('[anchor: derived]');
    expect(md).toContain('cost_usd: 0.0612');
    // The model that wrote it, not whatever the tier points to today.
    expect(md).toContain('model: anthropic/claude-sonnet-5\n');
    expect(md).toContain('- Binance Square: https://square.example/p/991');
    expect(md).not.toContain('—');

    expect(out.pngPath).toBe(join(vault, 'outputs', 'visuals', 'square', '2026-11-15-btc-holds-card.png'));
    expect(readFileSync(out.pngPath!, 'utf8')).toBe('png-bytes');
    const row = db.prepare('SELECT md_path, png_path FROM posts').get() as { md_path: string; png_path: string };
    expect(row).toEqual({ md_path: out.mdPath, png_path: out.pngPath });

    const recent = readRecentPosts(db, squareDir);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.source).toBe('vault');
  });

  it('puts the disclaimer after the rule, where the hand-written posts keep it', () => {
    const published = `${BODY}\n\n*Not financial advice.*`;
    const id = seedDraft(db, { status: 'approved', body: published });
    seedVisual(db, id);
    db.prepare(
      `INSERT INTO posts (draft_id, square_post_id, content_snapshot, hashtag, published_at)
       VALUES (?, '992', ?, '#BTCHolds', '2026-11-15T03:00:00.000Z')`,
    ).run(id, published);

    const md = readFileSync(writePublishedPost(db, id, { vaultDir: vault, modelFor }).mdPath, 'utf8');

    expect(md).toContain(`${BODY}\n\n---\n*Not financial advice.*\n\n## Nguồn`);
    expect(parseVaultPost(md, 'x.md').shapeText).toBe(BODY);
  });

  it('never overwrites a post already in the vault', () => {
    writeFileSync(join(squareDir, '2026-11-15-btc-holds-square-post.md'), 'hand-written');
    const id = seedDraft(db, { status: 'approved', body: BODY });
    seedVisual(db, id);
    publish(id);

    const out = writePublishedPost(db, id, { vaultDir: vault, modelFor });

    expect(out.mdPath).toBe(join(squareDir, '2026-11-15-btc-holds-square-post-2.md'));
    expect(readFileSync(join(squareDir, '2026-11-15-btc-holds-square-post.md'), 'utf8')).toBe('hand-written');
  });

  it('dates the file in Vietnam time', () => {
    const id = seedDraft(db, { status: 'approved', body: BODY });
    seedVisual(db, id);
    publish(id, { at: '2026-11-15T20:30:00.000Z' });
    expect(writePublishedPost(db, id, { vaultDir: vault, modelFor }).mdPath).toContain('2026-11-16-btc-holds');
  });

  it('records a post Square answered without an id', () => {
    const id = seedDraft(db, { status: 'approved', body: BODY });
    seedVisual(db, id);
    publish(id, { id: null, link: null });
    const md = readFileSync(writePublishedPost(db, id, { vaultDir: vault, modelFor }).mdPath, 'utf8');
    expect(md).toContain('square_post_id: null');
    expect(md).toContain('- Binance Square post id: none returned');
    // Read back as no id, not as the string "null".
    expect(parseVaultPost(md, 'x.md').squarePostId).toBeUndefined();
  });

  it('marks the angle posted in its file, leaving the rest of the file alone', () => {
    const anglePath = join(vault, 'angles', '2026-11-01-123-some-angle.md');
    mkdirSync(join(vault, 'angles'));
    const rest = '\n## Why It Matters\n\nUnchanged text.\n';
    writeFileSync(anglePath, `---\ndate: 2026-11-01\nstatus: unused\ntags: []\n---\n${rest}`);
    const id = seedDraft(db, { status: 'approved', body: BODY, outcome: 'angle', sourceRef: anglePath });
    seedVisual(db, id);
    publish(id);

    const out = writePublishedPost(db, id, { vaultDir: vault, modelFor });

    expect(readFileSync(anglePath, 'utf8')).toBe(`---\ndate: 2026-11-01\nstatus: posted\ntags: []\n---\n${rest}`);
    expect(out.notes).toContain('angle marked posted: 2026-11-01-123-some-angle.md');
    expect(readFileSync(out.mdPath, 'utf8')).toContain('_← Angle gốc: [[2026-11-01-123-some-angle]]_');
  });

  it('marks a bank anchor used only after a real publish, and only that anchor', () => {
    const bank = join(vault, 'anchor-bank.md');
    const anchor = (id: string) =>
      `## ${id} - Title ${id}\n\n- **lens:** \`x\`\n- **used:** false\n- **last_used:** null\n\n**text_en:**\n> Text.\n\n`;
    writeFileSync(bank, `---\nstatus: approved\n---\n\n${anchor('A1')}${anchor('A2')}${anchor('A3')}${anchor('A12')}`);
    // A draft that was offered and rejected keeps its anchor unused.
    const rejected = seedDraft(db, { status: 'rejected', body: BODY, anchorTier: 'bank', anchorRef: 'A1' });
    writeUnpublishedDraft(db, rejected, { vaultDir: vault, now: new Date('2026-11-15T04:00:00Z'), modelFor });
    expect(readFileSync(bank, 'utf8').match(/- \*\*used:\*\* false/g)).toHaveLength(4);

    const id = seedDraft(db, { status: 'approved', body: BODY, anchorTier: 'bank', anchorRef: 'A2' });
    seedVisual(db, id);
    publish(id);

    writePublishedPost(db, id, { vaultDir: vault, modelFor });

    const after = readFileSync(bank, 'utf8');
    expect(after).toContain('## A2 - Title A2\n\n- **lens:** `x`\n- **used:** true\n- **last_used:** 2026-11-15');
    expect(after.match(/- \*\*used:\*\* false/g)).toHaveLength(3);
  });

  it('adds the bullets an anchor is missing, so a used anchor always carries its date', () => {
    const bank = join(vault, 'anchor-bank.md');
    writeFileSync(bank, '## A1 - One\n- **lens:** `x`\n\n**text_en:**\n> T.\n\n## A2 - Two\n- **used:** false\n');
    expect(markBankAnchorUsed(bank, 'A1', '2026-11-15')).toBe('anchor A1 marked used on 2026-11-15');
    expect(readFileSync(bank, 'utf8')).toBe(
      '## A1 - One\n- **lens:** `x`\n- **used:** true\n- **last_used:** 2026-11-15\n\n**text_en:**\n> T.\n\n## A2 - Two\n- **used:** false\n',
    );
  });

  it('marks the angle inside the vault, with CRLF notes and a rule in the body left intact', () => {
    mkdirSync(join(vault, 'angles'));
    const inVault = join(vault, 'angles', '2026-11-02-9-crlf-angle.md');
    const body = '\r\nText.\r\n\r\n---\r\n\r\nAfter a rule.\r\n';
    writeFileSync(inVault, `---\r\ndate: 2026-11-02\r\nstatus: unused\r\n---\r\n${body}`);
    // The database remembers the note under another vault path.
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'sp-other-')), '2026-11-02-9-crlf-angle.md');
    writeFileSync(elsewhere, '---\nstatus: unused\n---\nOther vault.\n');
    db.prepare(`INSERT INTO angles (path, status, synced_at) VALUES (?, 'unused', 'x')`).run(elsewhere);
    const id = seedDraft(db, { status: 'approved', body: BODY, outcome: 'angle', sourceRef: elsewhere });
    seedVisual(db, id);
    publish(id);

    writePublishedPost(db, id, { vaultDir: vault, modelFor });

    expect(readFileSync(inVault, 'utf8')).toBe(`---\r\ndate: 2026-11-02\r\nstatus: posted\r\n---\r\n${body}`);
    expect(readFileSync(elsewhere, 'utf8')).toBe('---\nstatus: unused\n---\nOther vault.\n');
    expect(db.prepare('SELECT status FROM angles WHERE path = ?').get(elsewhere)).toEqual({ status: 'posted' });
  });

  it('marks the angle posted in the database even when its note is gone', () => {
    const gone = join(vault, 'angles', '2026-11-03-1-gone.md');
    db.prepare(`INSERT INTO angles (path, status, synced_at) VALUES (?, 'unused', 'x')`).run(gone);
    const id = seedDraft(db, { status: 'approved', body: BODY, outcome: 'angle', sourceRef: gone });
    seedVisual(db, id);
    publish(id);

    const out = writePublishedPost(db, id, { vaultDir: vault, modelFor });

    expect(out.notes).toContain('angle file missing, marked posted in the database only: 2026-11-03-1-gone.md');
    expect(db.prepare('SELECT status FROM angles WHERE path = ?').get(gone)).toEqual({ status: 'posted' });
  });

  it('keeps an approved draft whose publish result is unknown, saying so', () => {
    const id = seedDraft(db, { status: 'approved', body: BODY });
    const md = readFileSync(
      writeUnpublishedDraft(db, id, { vaultDir: vault, now: new Date('2026-11-15T04:00:00Z'), modelFor }),
      'utf8',
    );
    expect(md).toContain('status: approved');
    expect(md).toContain('rejected_reason: none, publish result unknown (Square did not answer clearly)');
  });

  it('reports an anchor the bank does not have instead of failing', () => {
    const bank = join(vault, 'anchor-bank.md');
    writeFileSync(bank, '## A1 - One\n- **used:** false\n');
    expect(markBankAnchorUsed(bank, 'A9', '2026-11-15')).toBe('anchor A9 not found in the bank, not marked');
    expect(readFileSync(bank, 'utf8')).toBe('## A1 - One\n- **used:** false\n');
  });

  it('keeps an offered draft that was not published in the drafts folder, with its reason', () => {
    const id = seedDraft(db, { status: 'rejected', body: BODY });
    db.prepare(`UPDATE drafts SET reject_reason = 'take' WHERE id = ?`).run(id);

    const mdPath = writeUnpublishedDraft(db, id, { vaultDir: vault, now: new Date('2026-11-15T04:00:00Z'), modelFor });

    expect(mdPath).toBe(join(vault, 'outputs', 'square-auto', 'drafts', `2026-11-15-btc-holds-d${id}.md`));
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toContain('status: rejected');
    expect(md).toContain('rejected_reason: take');
    expect(md.endsWith(`${BODY}\n`)).toBe(true);
    // Never in the published folder, so the gates do not count it.
    expect(readdirSync(squareDir)).toEqual([]);
    expect(existsSync(join(vault, 'outputs', 'visuals', 'square'))).toBe(false);
  });
});

describe('postSlug and vaultDate', () => {
  it('splits camel-case hashtags into a short slug', () => {
    expect(postSlug('#WhatWillDriveCryptoandStocks’NextRebound?')).toBe('what-will-drive-cryptoand-stocks-next');
    expect(postSlug('#BTCHolds')).toBe('btc-holds');
    expect(postSlug('#TRUMPBreaksAbove$3.4')).toBe('trump-breaks-above-3-4');
    expect(postSlug('#???')).toBe('post');
  });

  it('uses the Vietnam calendar day', () => {
    expect(vaultDate(new Date('2026-11-15T16:59:00Z'))).toBe('2026-11-15');
    expect(vaultDate(new Date('2026-11-15T17:00:00Z'))).toBe('2026-11-16');
  });
});
