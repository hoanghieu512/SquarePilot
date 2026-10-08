import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { buildCard } from './layout.js';
import { CANVAS } from './palette.js';
import { loadFonts } from './fonts.js';
import type { VisualSchema } from '../compose/data-gate.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('visual');

/** Square rejects uploads over 1MB. */
export const MAX_BYTES = 1_000_000;

export interface RenderResult {
  png: Buffer;
  bytes: number;
  width: number;
  height: number;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

/**
 * Schema to PNG, with no model in the loop.
 *
 * An image model cannot be trusted with the text: every number on the card has
 * to match the post exactly, and the Vietnamese diacritics on the sibling
 * pipeline would come out mangled. The model's only job upstream is to fill the
 * schema; the drawing is deterministic.
 */
export async function renderVisual(schema: VisualSchema): Promise<RenderResult> {
  const svg = await satori(buildCard(schema) as never, {
    width: CANVAS.width,
    height: CANVAS.height,
    fonts: loadFonts(),
  });

  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: CANVAS.width },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();

  if (png.byteLength > MAX_BYTES) {
    throw new RenderError(
      `Rendered PNG is ${(png.byteLength / 1024).toFixed(0)} KB, over the ${MAX_BYTES / 1024} KB upload limit`,
    );
  }

  logger.debug(`Rendered ${schema.visual_type}`, { bytes: png.byteLength });
  return { png, bytes: png.byteLength, width: CANVAS.width, height: CANVAS.height };
}

export async function renderToFile(schema: VisualSchema, filePath: string): Promise<RenderResult> {
  const result = await renderVisual(schema);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, result.png);
  logger.info(`Wrote ${filePath} (${(result.bytes / 1024).toFixed(0)} KB)`);
  return result;
}
