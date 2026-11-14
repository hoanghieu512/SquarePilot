import { ConfigError, loadZaloConfig } from '../config/index.js';
import { createZaloApi } from '../deliver/zalo-api.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('zalo-setup');

/**
 * Find the chat id of the owner's conversation with the approval bot.
 *
 * Zalo has no offset on getUpdates and only returns messages that arrive while
 * a poll is waiting, so this keeps polling until the first text message comes
 * in (or the window closes), prints its chat id, and answers in that chat so
 * the owner sees it worked. The token is never printed.
 *
 * Usage: npm run zalo:setup [-- --minutes 15]
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadZaloConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const minutesArg = process.argv.indexOf('--minutes');
  const minutes = minutesArg > -1 ? Number(process.argv[minutesArg + 1]) || 15 : 15;
  const api = createZaloApi({ token: config.token, apiBase: config.apiBase });

  const me = (await api.getMe()) as { account_name?: string; display_name?: string } | null;
  logger.info(`Bot reachable: ${me?.display_name ?? me?.account_name ?? '(no name returned)'}`);

  const hook = (await api.getWebhookInfo().catch(() => null)) as { url?: string } | null;
  if (hook?.url) {
    logger.error('This bot has a webhook set, so getUpdates cannot read messages. Remove it first.');
    process.exit(1);
  }

  logger.info(`Waiting up to ${minutes} min: send any message to the bot from Zalo now.`);
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    let updates;
    try {
      updates = await api.getUpdates(30);
    } catch (err) {
      // An empty long-poll may come back as an error; keep waiting either way.
      logger.debug('Poll ended without a message', {
        reason: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const msg = updates.find((u) => u.message?.chat.id)?.message;
    if (!msg) continue;

    const chatId = msg.chat.id;
    logger.info(`Message received from ${msg.from?.display_name ?? 'unknown sender'}`);
    console.log(`\nZALO_CHAT_ID=${chatId}\n`);
    await api.sendMessage(chatId, 'SquarePilot is connected to this chat. Drafts for approval will arrive here.');
    logger.info('Confirmation sent. Add the ZALO_CHAT_ID line above to .env.');
    return;
  }

  logger.error(`No message arrived within ${minutes} min. Run again and message the bot while it waits.`);
  process.exit(1);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
