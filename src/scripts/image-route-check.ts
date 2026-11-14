import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { createSquareClient, resolveSquareKey } from '../client/square-client.js';
import { loadZaloConfig } from '../config/index.js';
import { createZaloApi } from '../deliver/zalo-api.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('image-route');

/**
 * One-off check of the approval image route (decided 2026-11-14, option A):
 * upload a card to Square's image store, confirm the returned URL opens without
 * credentials, then send it to the Zalo approval chat. Uploads, never publishes.
 *
 * Usage: npm run check:image-route -- <path/to/card.png>
 */
async function main(): Promise<void> {
  const pngPath = process.argv[2];
  if (!pngPath || !fs.existsSync(pngPath)) {
    logger.error('Pass the path of an existing PNG card.');
    process.exit(1);
  }

  const square = createSquareClient({ apiKey: resolveSquareKey() });
  const imageUrl = await square.uploadImage(fs.readFileSync(pngPath), path.basename(pngPath));
  logger.info(`Uploaded: ${imageUrl}`);

  const res = await fetch(imageUrl);
  const bytes = (await res.arrayBuffer()).byteLength;
  logger.info(`Public fetch: HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'}, ${bytes} bytes`);
  if (!res.ok) {
    logger.error('The image URL is not publicly readable, so Zalo cannot fetch it either.');
    process.exit(1);
  }

  const zalo = loadZaloConfig();
  if (!zalo.chatId) {
    logger.warn('ZALO_CHAT_ID is not set; run npm run zalo:setup first to finish the check.');
    return;
  }
  const api = createZaloApi({ token: zalo.token, apiBase: zalo.apiBase });
  await api.sendPhoto(zalo.chatId, imageUrl, 'SquarePilot image route check: this card was uploaded to Square, not posted.');
  logger.info('Sent to the Zalo approval chat.');
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
