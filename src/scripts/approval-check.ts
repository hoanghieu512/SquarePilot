import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ConfigError, loadConfig, loadZaloConfig } from '../config/index.js';
import { runMigrations } from '../database/migrations.js';
import { runDataGate } from '../compose/data-gate.js';
import { createSquareClient, resolveSquareKey } from '../client/square-client.js';
import { createZaloApi } from '../deliver/zalo-api.js';
import { runApprovalSession } from '../deliver/approval-session.js';
import { createSessionHandlers } from '../deliver/session-handlers.js';
import { renderDraftVisual } from '../visual/draft-visual.js';
import { acquireSessionLock } from '../utils/session-lock.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('approval-check');

/**
 * Exercise the approval chat end to end without a model call and without
 * touching the real queue: copy one recorded draft into a scratch database,
 * draw its card, upload it, and run a session with publishing off.
 *
 * Use it after a change to the approver, or when no real draft passes its
 * gates and the chat still needs checking. "v" answers that only the run that
 * wrote a draft can rewrite it; "d" answers that publishing is off.
 *
 * Usage: npm run check:approval [-- --draft <id>]   (default: the newest draft)
 */

interface SourceRow {
  id: number;
  body: string;
  nfc_len: number;
  nfd_len: number;
  tone_gate: string | null;
  shape_gate: string | null;
  persona_gate: string | null;
  fact_gate: string | null;
  model_used: string;
  escalated: number;
  anchor_tier: string | null;
  anchor_ref: string | null;
  outcome: string;
  source_ref: string | null;
  perspective_summary: string | null;
  mode: string | null;
  hashtag: string;
  rank: number;
  view_count: number;
  content_count: number;
}

function readSource(dbPath: string, draftId: number | null): SourceRow {
  const real = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = real
      .prepare(
        `SELECT d.id, d.body, d.nfc_len, d.nfd_len, d.tone_gate, d.shape_gate, d.persona_gate, d.fact_gate,
                d.model_used, d.escalated, d.anchor_tier, d.anchor_ref,
                s.outcome, s.source_ref, s.mode, t.hashtag, t.rank, t.view_count, t.content_count,
                ${hasColumn(real, 'selections', 'perspective_summary') ? 's.perspective_summary' : 'NULL'} AS perspective_summary
         FROM drafts d
         JOIN selections s ON s.id = d.selection_id
         JOIN trends t ON t.id = s.trend_id
         WHERE ${draftId === null ? '1 = 1' : 'd.id = ?'}
         ORDER BY d.id DESC LIMIT 1`,
      )
      .get(...(draftId === null ? [] : [draftId])) as SourceRow | undefined;
    if (!row) throw new Error(draftId === null ? 'The database has no draft yet' : `No draft ${draftId}`);
    return row;
  } finally {
    real.close();
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

function seed(db: Database.Database, src: SourceRow, now: Date): number {
  const trend = db
    .prepare(
      `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(src.hashtag, src.rank, src.view_count, src.content_count, now.toISOString());
  const selection = db
    .prepare(
      `INSERT INTO selections (trend_id, outcome, source_ref, perspective_summary, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(trend.lastInsertRowid, src.outcome, src.source_ref, src.perspective_summary, src.mode, now.toISOString());
  // Pending regardless of what the source draft scored: the gate columns are
  // copied as recorded, so the card shows any gate that failed.
  const draft = db
    .prepare(
      `INSERT INTO drafts
         (selection_id, body, nfc_len, nfd_len, tone_gate, shape_gate, persona_gate, fact_gate,
          anchor_tier, anchor_ref, model_used, escalated, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      selection.lastInsertRowid,
      src.body,
      src.nfc_len,
      src.nfd_len,
      src.tone_gate,
      src.shape_gate,
      src.persona_gate,
      src.fact_gate,
      src.anchor_tier,
      src.anchor_ref,
      src.model_used,
      src.escalated,
      now.toISOString(),
    );
  return Number(draft.lastInsertRowid);
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf('--draft');
  const draftArg = flag >= 0 ? Number.parseInt(process.argv[flag + 1] ?? '', 10) : null;
  if (draftArg !== null && !Number.isInteger(draftArg)) throw new Error('--draft takes a draft id');

  const config = loadConfig();
  const zalo = loadZaloConfig();
  if (!zalo.chatId) throw new ConfigError('Missing ZALO_CHAT_ID. Run `npm run zalo:setup` first.');
  const square = createSquareClient({ apiKey: resolveSquareKey() });

  const src = readSource(config.dbPath, draftArg);
  const lock = acquireSessionLock(path.join(path.dirname(config.dbPath), 'session.lock'));
  if (!lock.acquired) {
    logger.info(`Run ${lock.heldBy} is waiting for approval on the same bot; try again when it ends`);
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-approval-check-'));
  const db = new Database(path.join(workDir, 'check.db'));
  try {
    runMigrations(db);
    const now = (): Date => new Date();
    const draftId = seed(db, src, now());

    const gate = runDataGate({
      trend: {
        hashtag: src.hashtag,
        hashtagId: null,
        rank: src.rank,
        viewCount: src.view_count,
        contentCount: src.content_count,
        tradingPairs: [],
      },
      topPosts: [{ id: null, authorName: null, text: src.body, likeCount: 0, viewCount: 0 }],
    });
    if (!gate.ok) throw new Error(`Draft ${src.id} cannot be drawn: ${gate.reason}`);
    const drawn = await renderDraftVisual(db, {
      draftId,
      body: src.body,
      hashtag: src.hashtag,
      baseSchema: gate.available,
      visualDir: workDir,
      now: now(),
    });
    if (!drawn.ok) throw new Error(`Draft ${src.id} cannot be drawn: ${drawn.reason}`);
    logger.info(`Copied draft ${src.id} into ${workDir}`);

    const api = createZaloApi({ token: zalo.token, apiBase: zalo.apiBase });
    await api.sendMessage(
      zalo.chatId,
      `Approval check: a copy of draft #${src.id} in a scratch database. Nothing will be published. Try a, v, d, then b to finish.`,
    );

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const summary = await runApprovalSession(
      {
        db,
        api,
        chatId: zalo.chatId,
        now,
        square,
        modelFor: (tier) => (tier === 'paid' ? config.modelPaid : tier === 'free' ? config.modelFree : tier),
        publishEnabled: false,
        handlers: createSessionHandlers({
          db,
          square: null,
          publishEnabled: false,
          visualDir: workDir,
          now,
          contexts: new Map(),
          draw: async () => {
            throw new Error('rewrite is not available in the approval check');
          },
        }),
        signal: controller.signal,
      },
      [draftId],
    );
    logger.info(`Check over (${summary.reason}): ${summary.drafts.map((d) => `${d.code} ${d.status}`).join(', ')}`);
  } finally {
    db.close();
    lock.release();
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
