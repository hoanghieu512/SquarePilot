import path from 'node:path';
import { ConfigError, loadConfig, loadZaloConfig } from '../config/index.js';
import { closeDb, initDb } from '../database/index.js';
import { LlmClient } from '../llm/client.js';
import { draftAndDraw, runUpToDraft, type DraftContext } from '../pipeline.js';
import { withdrawDraft } from '../compose/compose-draft.js';
import { createSquareClient, resolveSquareKey, type SquareClient } from '../client/square-client.js';
import { createZaloApi } from '../deliver/zalo-api.js';
import { statusOf } from '../deliver/approval-store.js';
import { runApprovalSession } from '../deliver/approval-session.js';
import { createSessionHandlers } from '../deliver/session-handlers.js';
import { acquireSessionLock } from '../utils/session-lock.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('run');

/**
 * One full run: collect, pick, draft, draw, then wait in the approval chat
 * until the draft is published, rejected or expired.
 *
 * Publishing is off unless `--publish` is passed. Without it, "d" answers that
 * publishing is off and the draft stays pending, so the whole path can be
 * tried on real trends without anything reaching Binance Square.
 */
async function main(): Promise<void> {
  const publishEnabled = process.argv.includes('--publish');
  const headed = process.argv.includes('--headed');

  const config = loadConfig();
  const zalo = loadZaloConfig();
  if (!zalo.chatId) throw new ConfigError('Missing ZALO_CHAT_ID. Run `npm run zalo:setup` first.');
  const chatId = zalo.chatId;

  let square: SquareClient | null = null;
  try {
    square = createSquareClient({ apiKey: resolveSquareKey() });
  } catch (err) {
    if (publishEnabled) throw err;
    logger.warn('No Square OpenAPI key: drafts go to Zalo without their card');
  }

  const db = initDb(config.dbPath);
  const lock = acquireSessionLock(path.join(path.dirname(config.dbPath), 'session.lock'));
  if (!lock.acquired) {
    logger.info(`Run ${lock.heldBy} is still waiting for approval; this run steps aside`);
    closeDb();
    return;
  }

  try {
    const llm = new LlmClient({
      apiKey: config.openRouterApiKey,
      modelFree: config.modelFree,
      modelPaid: config.modelPaid,
      db,
    });
    const visualDir = path.join(config.vaultDir, 'outputs', 'visuals', 'square-auto');
    const now = (): Date => new Date();

    const result = await runUpToDraft(db, config, { headed, llm, visualDir });
    const draftId = result.draftId;
    if (draftId === undefined || !result.context || statusOf(db, draftId) !== 'pending') {
      logger.info(
        !result.chosen
          ? 'No draft this run: no trend had both a perspective and a visual'
          : 'No draft this run: the draft failed its gates or has no card',
      );
      return;
    }

    const contexts = new Map<number, DraftContext>([[draftId, result.context]]);
    const handlers = createSessionHandlers({
      db,
      square,
      publishEnabled,
      visualDir,
      now,
      contexts,
      draw: (context) => draftAndDraw(db, config, context, { llm, visualDir, now }),
    });

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
      const summary = await runApprovalSession(
        {
          db,
          api: createZaloApi({ token: zalo.token, apiBase: zalo.apiBase }),
          chatId,
          now,
          square,
          modelFor: (tier) => (tier === 'paid' ? config.modelPaid : tier === 'free' ? config.modelFree : tier),
          publishEnabled,
          handlers,
          signal: controller.signal,
        },
        [draftId],
      );
      logger.info(`Session over (${summary.reason}): ${summary.drafts.map((d) => `${d.code} ${d.status}`).join(', ')}`);
    } catch (err) {
      // The draft could not be put in front of the owner: it must not sit in
      // the queue where a later "d" could post it unseen.
      withdrawDraft(db, draftId, 'not-sent');
      throw err;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } finally {
    lock.release();
    closeDb();
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
