import { chromium, type BrowserContext } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('browser');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.squarepilot', 'browser-profile');

export interface FetchOptions {
  url: string;
  /** Page is ready only once this appears in the HTML. */
  waitForMarker: string;
  profileDir?: string;
  timeoutMs?: number;
  /** Force a visible window. Used to warm a cold profile. */
  headed?: boolean;
}

/**
 * Binance sits behind Cloudflare. Measured on 2026-08-21:
 *
 *   plain curl                      → 0 bytes
 *   headless, fresh profile         → HTTP 202, 2 KB challenge page
 *   headed, fresh profile           → HTTP 202, 2 KB challenge page
 *   persistent profile, real Chrome → challenge clears in ~5 s, then 222 KB
 *   same profile once warm, headless→ 1.7 s
 *
 * So the profile, not the window, is what carries clearance. We keep one on
 * disk, run headless, and only fall back to a visible window when a cold or
 * expired profile needs to solve the challenge again.
 */
async function open(profileDir: string, headless: boolean): Promise<BrowserContext> {
  fs.mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless,
    channel: 'chrome',
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function loadOnce(
  opts: FetchOptions,
  profileDir: string,
  headless: boolean,
): Promise<string | null> {
  const timeout = opts.timeoutMs ?? 60_000;
  const ctx = await open(profileDir, headless);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout });

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const html = await page.content();
      if (html.includes(opts.waitForMarker)) return html;
      await page.waitForTimeout(1000);
    }
    return null;
  } finally {
    await ctx.close();
  }
}

export async function fetchRenderedHtml(opts: FetchOptions): Promise<string> {
  const profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;

  if (!opts.headed) {
    const html = await loadOnce(opts, profileDir, true);
    if (html) return html;
    logger.warn('Headless load did not clear the challenge — retrying with a visible window');
  }

  const html = await loadOnce(opts, profileDir, false);
  if (html) return html;

  throw new Error(
    `Timed out waiting for "${opts.waitForMarker}" at ${opts.url}. ` +
      'Cloudflare did not let the page through, even with a visible window.',
  );
}

export { USER_AGENT, DEFAULT_PROFILE_DIR };
