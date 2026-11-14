import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Binance Square OpenAPI: image upload and short-post publish.
 *
 * Mirrors the official `square-post` skill (binance/binance-skills-hub, v2.0.0):
 * presigned upload, poll until processed, then `/content/add` with the
 * processed image URLs. Two behaviours matter more than the rest:
 *
 * - HTTP 504 on `/content/add` means the post WAS published, only without an
 *   id. It must come back as a success. The approver reverts a draft to
 *   pending when publishing throws, so throwing here would invite a second,
 *   duplicate post on the next approval.
 * - The key lives in an environment variable or a 0600 file, is sent only as a
 *   header, and never appears in a log or an error.
 */

const BASE_V1 = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';
const BASE_V2 = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const OK_CODE = '000000';
export const MAX_IMAGES = 4;

export const DEFAULT_KEY_FILE = path.join(os.homedir(), '.config', 'binance-square', 'openapi-key');

export class SquareError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SquareError';
  }
}

export function resolveSquareKey(
  env: NodeJS.ProcessEnv = process.env,
  keyFile: string = DEFAULT_KEY_FILE,
): string {
  const fromEnv = env.BINANCE_SQUARE_OPENAPI_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(keyFile)) {
    const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  throw new SquareError(
    `Missing Square OpenAPI key. Set BINANCE_SQUARE_OPENAPI_KEY or save it to ${keyFile} (mode 600).`,
  );
}

export type PublishResult =
  | { status: 'published'; id: string | null; shareLink: string | null }
  | { status: 'published_without_id'; id: null; shareLink: null };

export interface SquareClient {
  /** Upload a PNG and wait until Square has processed it. Returns the image URL. */
  uploadImage(png: Buffer, imageName: string): Promise<string>;
  publishPost(post: { body: string; imageUrls: string[] }): Promise<PublishResult>;
}

export interface SquareClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

interface Envelope {
  code?: string;
  message?: string;
  data?: unknown;
}

export function createSquareClient(opts: SquareClientOptions): SquareClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const maxPolls = opts.maxPolls ?? 10;
  const redact = (text: string): string => (opts.apiKey ? text.split(opts.apiKey).join('[redacted]') : text);

  async function post(endpoint: string, body: unknown, base = BASE_V2): Promise<Response> {
    try {
      return await fetchImpl(`${base}${endpoint}`, {
        method: 'POST',
        headers: {
          'X-Square-OpenAPI-Key': opts.apiKey,
          'Content-Type': 'application/json',
          clienttype: 'binanceSkill',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SquareError(`Request to ${endpoint} failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }

  async function data(res: Response, endpoint: string): Promise<Record<string, unknown>> {
    const raw = await res.text();
    let json: Envelope;
    try {
      json = JSON.parse(raw) as Envelope;
    } catch {
      throw new SquareError(`${endpoint} returned non-JSON (HTTP ${res.status})`);
    }
    if (json.code !== OK_CODE) {
      throw new SquareError(`${endpoint} failed [${json.code}]: ${redact(json.message ?? 'no message')}`, json.code);
    }
    return (json.data ?? {}) as Record<string, unknown>;
  }

  return {
    async uploadImage(png, imageName) {
      const presign = await data(await post('/image/presignedUrl', { imageName }), '/image/presignedUrl');
      const presignedUrl = presign.presignedUrl;
      const fileTicket = presign.fileTicket;
      if (typeof presignedUrl !== 'string' || typeof fileTicket !== 'string') {
        throw new SquareError('/image/presignedUrl returned no presignedUrl or fileTicket');
      }

      // The presigned URL carries a signature in its query string: never let
      // it into an error message, which can end up in the approval chat.
      let put: Response;
      try {
        put = await fetchImpl(presignedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: new Uint8Array(png),
        });
      } catch {
        throw new SquareError('Image upload to the presigned URL failed (network error)');
      }
      if (!put.ok) throw new SquareError(`Image upload failed: HTTP ${put.status}`);

      for (let i = 0; i < maxPolls; i++) {
        const status = await data(await post('/image/imageStatus', { fileTicket }), '/image/imageStatus');
        if (status.status === 1 && typeof status.imageUrl === 'string') return status.imageUrl;
        if (status.status === 2) {
          throw new SquareError(`Image processing failed: ${redact(String(status.failedReason ?? 'no reason'))}`);
        }
        await sleep(pollIntervalMs);
      }
      throw new SquareError(`Image still processing after ${maxPolls} polls`);
    },

    async publishPost({ body, imageUrls }) {
      if (imageUrls.length > MAX_IMAGES) {
        throw new SquareError(`At most ${MAX_IMAGES} images per post, got ${imageUrls.length}`);
      }
      const res = await post(
        '/content/add',
        { contentType: 1, bodyTextOnly: body, ...(imageUrls.length > 0 ? { imageList: imageUrls } : {}) },
        BASE_V1,
      );
      if (res.status === 504) return { status: 'published_without_id', id: null, shareLink: null };
      const d = await data(res, '/content/add');
      return {
        status: 'published',
        id: d.id === undefined || d.id === null ? null : String(d.id),
        shareLink: typeof d.shareLink === 'string' ? d.shareLink : null,
      };
    },
  };
}
